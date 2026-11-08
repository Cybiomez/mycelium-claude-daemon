// Менеджер: очередь ходов, живые query-процессы SDK, события для SSE
import { query } from '@anthropic-ai/claude-agent-sdk';
import crypto from 'node:crypto';
import { normalizeBlocks } from './history.mjs';
import { CHANNEL_TAG } from './config.mjs';
import { memAvailableMb } from './locks.mjs';

// Управляемый асинх-итератор входа для streaming input mode
function makeInput() {
  const q = []; let notify = null; let closed = false;
  return {
    push(m) { q.push(m); notify?.(); },
    close() { closed = true; notify?.(); },
    get closed() { return closed; },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (q.length) yield q.shift();
        if (closed) return;
        await new Promise(r => { notify = r; });
        notify = null;
      }
    },
  };
}

export class Manager {
  constructor(cfg, store, log) {
    this.cfg = cfg;
    this.store = store;
    this.log = log;
    this.active = new Map();   // sessionKey -> {q, input, sessionId, idleTimer, currentJobId, startedAt}
    this.pending = new Map();   // sessionId -> {resolve} для интерактивных вопросов (AskUserQuestion)
    this.requests = new Map();  // requestId -> {session, kind, resolve} — разрешения и планы
    this.listeners = new Set(); // SSE подписчики: fn(event)
    this.seq = 0;
    this.recent = [];          // кольцевой буфер последних событий для reconnect
    this.usageCache = store.kvGet('usage') ?? null;
    this.contextCache = new Map(Object.entries(store.kvGet('contextCache') ?? {}));
    this.commandsCache = store.kvGet('commands') ?? null;
    this.modelsCache = store.kvGet('models') ?? null;   // {models: [...], fetchedAt}
    this.lastServed = new Map();   // sessionKey -> ts последнего запуска хода (очередь по кругу)
    this.memTimer = null;          // повтор pump(), когда ход ждёт памяти
    store.recoverStale();
  }

  // ---------- события ----------
  emit(type, sessionKey, data = {}) {
    const ev = { seq: ++this.seq, ts: Date.now(), type, session: sessionKey, ...data };
    this.recent.push(ev);
    if (this.recent.length > 500) this.recent.shift();
    for (const fn of this.listeners) { try { fn(ev); } catch { /* умерший подписчик */ } }
  }

  subscribe(fn, afterSeq = 0) {
    for (const ev of this.recent) if (ev.seq > afterSeq) fn(ev);
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ---------- публичное API ----------
  // Возвращает {jobId, sessionKey}. sessionId=null => новая сессия.
  // opts: settings — {model, effort, permissionMode}, применяются ДО запуска процесса;
  //       channel — ключ памятки канала (cfg.channelMemos); priority — 1 разговор, 0 фон.
  submit(sessionId, text, attachments, opts = {}) {
    const sessionKey = sessionId ?? ('new-' + crypto.randomUUID());
    if (opts.settings && typeof opts.settings === 'object') this.applySettings(sessionKey, opts.settings);
    const priority = opts.priority === 0 ? 0 : 1;
    const channel = typeof opts.channel === 'string' && this.cfg.channelMemos?.[opts.channel] ? opts.channel : null;
    const jobId = this.store.addJob(sessionKey, text, attachments, { priority, channel });
    const position = this.queuePosition(jobId);
    this.emit('job.queued', sessionKey, { jobId, text: text.slice(0, 200), position });
    setImmediate(() => this.pump());
    return { jobId, sessionKey, position };
  }

  // Смена настроек сессии. Живой процесс работает со старыми — его надо
  // перезапустить: простаивающий закрываем сразу, занятый — после текущего хода.
  applySettings(sessionKey, body) {
    const clean = {};
    for (const k of ['permissionMode', 'model', 'effort']) {
      if (body[k] === undefined) continue;
      clean[k] = body[k] === '' ? null : body[k];
    }
    this.store.setSettings(sessionKey, clean);
    const a = this.active.get(sessionKey);
    if (a) {
      a.stale = true;
      if (a.currentJobId == null) this.closeProcess(a);
    }
  }

  closeProcess(a) {
    if (a.closing) return;
    a.closing = true;
    clearTimeout(a.idleTimer);
    try { a.input.close(); } catch { /* уже закрыт */ }
  }

  // Сколько ходов впереди: все выполняющиеся + ожидающие, поступившие раньше
  queuePosition(jobId) {
    const running = this.runningSessions().length;
    const ahead = this.store.queuedJobs().filter(j => j.id < jobId).length;
    return running + ahead;
  }

  getQueue() {
    const running = [...this.active.entries()]
      .filter(([, a]) => a.currentJobId != null)
      .map(([k, a]) => ({ jobId: a.currentJobId, session: a.sessionId ?? k, status: 'running', startedAt: a.startedAt }));
    const queued = this.store.queuedJobs().map(j => ({
      jobId: j.id, session: this.store.resolveAlias(j.session_key) ?? j.session_key, status: 'queued',
      text: j.text.slice(0, 200), priority: j.priority, createdAt: j.created_at,
    }));
    return { running, queued };
  }

  cancelJob(jobId) {
    const job = this.store.getJob(jobId);
    if (!job || !this.store.cancelJob(jobId)) return false;
    this.emit('job.cancelled', job.session_key, { jobId });
    return true;
  }

  getModels() { return this.modelsCache; }

  cacheModels(list) {
    const models = (list ?? []).map(m => ({
      value: m.value, displayName: m.displayName, description: m.description,
      supportsEffort: !!m.supportsEffort, supportedEffortLevels: m.supportedEffortLevels ?? [],
    }));
    if (!models.length) return;
    const before = new Set((this.modelsCache?.models ?? []).map(m => m.value));
    this.modelsCache = { models, fetchedAt: Date.now() };
    this.store.kvSet('models', this.modelsCache);
    // Первая сверка после старта демона — базовая линия, не «новинка»: иначе
    // каждый перезапуск объявляет модель, у которой чуть сменился id (fable-5↔fable-5-1).
    if (!this.modelsBaselined) { this.modelsBaselined = true; return; }
    const added = models.filter(m => before.size && !before.has(m.value)).map(m => m.value);
    if (added.length) this.emit('models.changed', null, { added });
  }

  // Список моделей при пустом кэше (чистая установка): короткий служебный
  // процесс только ради supportedModels(), если хватает памяти и демон свободен.
  async probeModels() {
    if (this.modelsCache?.models?.length || this.active.size) return;
    if (memAvailableMb() < this.cfg.minFreeMemMb) return;
    const input = makeInput();
    const q = query({ prompt: input, options: { cwd: this.cfg.cwd } });
    try {
      const list = await Promise.race([
        q.supportedModels(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 60_000)),
      ]);
      this.cacheModels(list);
      this.log('models probe:', this.modelsCache?.models?.length ?? 0, 'моделей');
    } catch (e) {
      this.log('models probe failed:', e.message);
    } finally {
      input.close();
      try { q.close(); } catch { /* ок */ }
    }
  }

  async interrupt(sessionKey) {
    this.cancelPending(sessionKey);
    const a = this.active.get(sessionKey);
    if (!a) return false;
    try { await a.q.interrupt(); } catch (e) { this.log('interrupt err:', e.message); }
    return true;
  }

  // Ответ на живой интерактивный вопрос (AskUserQuestion). answers — объект
  // {текст вопроса: выбранный вариант | [варианты] | свой текст}.
  answerQuestion(sessionKey, answers) {
    const p = this.pending.get(sessionKey);
    if (!p) return false;
    p.resolve(answers);
    return true;
  }

  cancelPending(sessionKey) {
    const p = this.pending.get(sessionKey);
    if (p) p.resolve(null);
    for (const [id, r] of this.requests) if (r.session === sessionKey) { this.requests.delete(id); r.resolve(null); }
  }

  // Запрос решения у человека (разрешение / план): событие с requestId, ждём ответ клиента.
  // Своё id у каждого запроса — модель может просить несколько действий параллельно.
  ask(sid, kind, payload) {
    const requestId = crypto.randomUUID().slice(0, 12);
    return new Promise(resolve => {
      this.requests.set(requestId, { session: sid, kind, resolve });
      this.emit(kind, sid, { requestId, ...payload });
    });
  }

  resolveRequest(requestId, value) {
    const r = this.requests.get(requestId);
    if (!r) return false;
    this.requests.delete(requestId);
    r.resolve(value);
    return true;
  }

  pendingRequests(sid) {
    return [...this.requests.entries()].filter(([, r]) => r.session === sid).map(([id, r]) => ({ requestId: id, kind: r.kind }));
  }

  status(sessionKey) {
    const a = this.active.get(sessionKey);
    const queued = this.store.queuedForSession(sessionKey).length;
    return { running: !!a && a.currentJobId != null, alive: !!a, queued, startedAt: a?.startedAt ?? null };
  }

  // Освободить сессию перед переносом в архив: ход идёт или ждёт — нельзя;
  // простаивающий процесс закрываем и ждём, пока он уйдёт (иначе допишет в перенесённый файл).
  async releaseSession(sessionKey, timeoutMs = 15_000) {
    const st = this.status(sessionKey);
    if (st.running || st.queued) return false;
    const a = this.active.get(sessionKey);
    if (!a) return true;
    this.closeProcess(a);
    const until = Date.now() + timeoutMs;
    while (this.active.get(sessionKey) === a && Date.now() < until) await new Promise(r => setTimeout(r, 200));
    return this.active.get(sessionKey) !== a;
  }

  runningSessions() {
    return [...this.active.entries()]
      .filter(([, a]) => a.currentJobId != null)
      .map(([k]) => k);
  }


  async getUsage() {
    // Свежие данные — только с живого процесса; иначе кэш
    for (const [, a] of this.active) {
      try {
        const u = await a.q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
        this.usageCache = { ...u, fetchedAt: Date.now() };
        this.store.kvSet('usage', this.usageCache);
        return this.usageCache;
      } catch { /* попробуем следующий или кэш */ }
    }
    return this.usageCache;
  }

  async getContext(sessionKey) {
    const a = this.active.get(sessionKey);
    if (a) {
      try {
        const c = await a.q.getContextUsage();
        const slim = { totalTokens: c.totalTokens, maxTokens: c.maxTokens, percentage: c.percentage, model: c.model, fetchedAt: Date.now() };
        this.contextCache.set(sessionKey, slim);
        this.store.kvSet('contextCache', Object.fromEntries(this.contextCache));
        return slim;
      } catch { /* кэш ниже */ }
    }
    return this.contextCache.get(sessionKey) ?? null;
  }

  getCommands() { return this.commandsCache ?? []; }

  // ---------- воркер ----------
  pump() {
    while (true) {
      const entries = [...this.active.entries()];
      const running = entries.filter(([, a]) => a.currentJobId != null).length;
      if (running >= this.cfg.maxConcurrent) return;
      // Занятые и закрывающиеся сессии пропускаем: у закрывающейся ход стартует,
      // когда процесс завершится (consume → finally → pump)
      const skip = new Set(entries.filter(([, a]) => a.currentJobId != null || a.closing).map(([k]) => k));
      const job = this.store.nextQueuedJob(skip, this.lastServed);
      if (!job) return;
      const warm = this.active.get(job.session_key);
      if (warm && warm.stale) { this.closeProcess(warm); continue; }   // настройки сменились
      if (!warm) {
        // Нужен новый процесс Claude — сначала сторож памяти
        const free = memAvailableMb();
        if (free < this.cfg.minFreeMemMb) {
          const idle = entries.filter(([, a]) => a.currentJobId == null && !a.closing);
          if (idle.length) { idle.forEach(([, a]) => this.closeProcess(a)); return; }  // освободим простаивающие и повторим
          this.emit('job.waiting', job.session_key, { jobId: job.id, reason: 'memory', freeMb: free, needMb: this.cfg.minFreeMemMb });
          if (!this.memTimer) this.memTimer = setTimeout(() => { this.memTimer = null; this.pump(); }, this.cfg.memoryRetryMs);
          return;
        }
      }
      this.lastServed.set(job.session_key, Date.now());
      this.runJob(job).catch(e => this.log('runJob fatal:', e));
    }
  }

  buildPrompt(job) {
    const atts = JSON.parse(job.attachments || '[]');
    const content = [];
    // Памятка канала — отдельным блоком в начале хода; history.mjs вырезает её из ленты
    const memo = job.channel ? this.cfg.channelMemos?.[job.channel] : null;
    if (memo) content.push({ type: 'text', text: `<${CHANNEL_TAG}>${memo}</${CHANNEL_TAG}>` });
    let text = job.text;
    const fileNotes = [];
    for (const att of atts) {
      if (att.kind === 'image') {
        content.push({ type: 'image', source: { type: 'base64', media_type: att.mime, data: att.base64 ?? '' } });
      } else {
        fileNotes.push(att.path);
      }
    }
    if (fileNotes.length) {
      text += '\n\n[Прикреплённые файлы: ' + fileNotes.join(', ') + ' — при необходимости прочитай их]';
    }
    content.push({ type: 'text', text });
    return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' };
  }

  async runJob(job) {
    const key = job.session_key;
    this.store.markJob(job.id, 'running');
    let a = this.active.get(key);
    if (a && !a.currentJobId && !a.closing) {
      // Тёплый живой процесс — шлём в него
      clearTimeout(a.idleTimer);
      a.currentJobId = job.id;
      a.startedAt = Date.now();
      this.emit('job.started', key, { jobId: job.id });
      a.input.push(this.buildPrompt(job));
      return;
    }
    // Новый процесс
    const isNew = key.startsWith('new-');
    const settings = this.store.getSettings(key) ?? {};
    const input = makeInput();
    // canUseTool ловит интерактивные вопросы модели (AskUserQuestion) и ждёт ответ
    // из приложения; всё остальное — разрешаем (режим «Авто»). AskUserQuestion
    // доходит сюда в любом режиме прав. Пл\.-режим строгих правок этим путём не
    // навязывается (осознанное упрощение, docs/decisions.md).
    const mode = settings.permission_mode ?? this.cfg.permissionMode;
    // canUseTool: решения, которые принимает человек в клиенте.
    //  • AskUserQuestion — вопрос с вариантами (любой режим);
    //  • ExitPlanMode — режим «План»: план на утверждение «Утвердить / Доработать»;
    //  • прочие инструменты — в режиме «С подтверждением» (default): «Да / Да, не спрашивать / Нет».
    //    В «Авто» (bypassPermissions) разрешаем без вопросов.
    const canUseTool = async (toolName, toolInput, opts = {}) => {
      const sid = a?.sessionId ?? key;
      if (toolName === 'ExitPlanMode') {
        const r = await this.ask(sid, 'plan', { plan: String(toolInput?.plan ?? '') });
        if (!r) return { behavior: 'deny', message: 'План не утверждён: ход прерван.' };
        if (r.approve) {
          // Дальше по плану — без вопросов. Режим «План» вернётся со следующего хода: процесс
          // пометим устаревшим, и следующий ход стартует заново с режимом из настроек.
          // SDK после выхода из плана переводит процесс в режим с подтверждениями — поэтому
          // «без вопросов до конца хода» держим сами флагом процесса (проверено 02-10-2026)
          a.planApproved = true;
          a.stale = true;
          return { behavior: 'allow', updatedInput: toolInput };
        }
        return { behavior: 'deny', message: 'Алексей попросил доработать план. Замечания: ' +
                 (r.feedback?.trim() || 'без конкретики — пересмотри и предложи вариант лучше') };
      }
      if (toolName !== 'AskUserQuestion') {
        if (mode === 'bypassPermissions' || a?.planApproved || a?.allowTools?.has(toolName)) {
          return { behavior: 'allow', updatedInput: toolInput };
        }
        const r = await this.ask(sid, 'permission', {
          tool: toolName, title: opts.title ?? null, displayName: opts.displayName ?? null,
          input: summarizeInput(toolInput),
        });
        if (!r || r.decision === 'deny') {
          return { behavior: 'deny', message: r ? 'Алексей запретил это действие.' : 'Запрос отменён.' };
        }
        if (r.decision === 'always') {
          (a.allowTools ??= new Set()).add(toolName);
          return { behavior: 'allow', updatedInput: toolInput, updatedPermissions: opts.suggestions ?? [] };
        }
        return { behavior: 'allow', updatedInput: toolInput };
      }
      const questions = toolInput?.questions ?? [];
      this.emit('question', sid, { questions });
      const answers = await new Promise(resolve => { this.pending.set(sid, { resolve }); });
      this.pending.delete(sid);
      if (answers == null) return { behavior: 'deny', message: 'Вопрос отменён' };
      return { behavior: 'allow', updatedInput: { questions, answers } };
    };
    const options = {
      cwd: this.cfg.cwd,
      permissionMode: settings.permission_mode ?? this.cfg.permissionMode,
      includePartialMessages: true,
      canUseTool,
      ...(settings.model ?? this.cfg.model ? { model: settings.model ?? this.cfg.model } : {}),
      ...(settings.effort ?? this.cfg.effort ? { effort: settings.effort ?? this.cfg.effort } : {}),
      ...(isNew ? {} : { resume: key }),
    };
    const q = query({ prompt: input, options });
    a = { q, input, sessionId: isNew ? null : key, idleTimer: null, currentJobId: job.id, startedAt: Date.now() };
    this.active.set(key, a);
    this.emit('job.started', key, { jobId: job.id });
    input.push(this.buildPrompt(job));
    this.consume(key, a).catch(e => this.log('consume fatal:', e));
  }

  async consume(key, a) {
    try {
      for await (const msg of a.q) {
        this.handleMessage(key, a, msg);
      }
    } catch (e) {
      this.log(`query [${key}] error:`, e.message);
      if (a.currentJobId != null) {
        // interrupt приводит к error_during_execution + исключению — это штатно
        const wasInterrupted = /interrupt|abort/i.test(e.message) || a.interrupted;
        this.store.markJob(a.currentJobId, wasInterrupted ? 'interrupted' : 'error', wasInterrupted ? null : e.message);
        this.emit(wasInterrupted ? 'job.interrupted' : 'job.error', a.sessionId ?? key, { jobId: a.currentJobId, error: wasInterrupted ? null : e.message });
        a.currentJobId = null;
      }
    } finally {
      clearTimeout(a.idleTimer);
      // После init новой сессии запись переехала с temp-ключа на реальный id —
      // удаляем по нему и только свою (на ключе мог уже подняться новый процесс)
      for (const k of [key, a.sessionId]) if (k && this.active.get(k) === a) this.active.delete(k);
      this.emit('session.closed', a.sessionId ?? key, {});
      setImmediate(() => this.pump());
    }
  }

  handleMessage(key, a, msg) {
    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init') {
          const sid = msg.session_id;
          if (key.startsWith('new-') && sid) {
            a.sessionId = sid;
            this.store.remapSession(key, sid);
            // Переключаем ключ в active на реальный id
            this.active.delete(key);
            this.active.set(sid, a);
            this.emit('session.created', sid, { tempKey: key, model: msg.model });
            key = sid;
          }
          this.emit('turn.init', a.sessionId ?? key, { model: msg.model, permissionMode: msg.permissionMode });
          // Список моделей — процесс уже живой, запрос бесплатный
          a.q.supportedModels().then(ms => this.cacheModels(ms)).catch(() => {});
          // Обновляем кэш слеш-команд
          a.q.supportedCommands().then(cmds => {
            this.commandsCache = cmds.map(c => ({ name: c.name, description: c.description, argumentHint: c.argumentHint }));
            this.store.kvSet('commands', this.commandsCache);
          }).catch(() => {});
        } else if (msg.subtype === 'status') {
          this.emit('turn.status', a.sessionId ?? key, { status: msg.status });
        } else if (msg.subtype === 'compact_boundary') {
          this.emit('turn.compacted', a.sessionId ?? key, {});
        }
        break;
      }
      case 'stream_event': {
        const ev = msg.event;
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          this.emit('delta', a.sessionId ?? key, { text: ev.delta.text });
        } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta') {
          this.emit('thinking', a.sessionId ?? key, { text: ev.delta.thinking });
        }
        break;
      }
      case 'assistant': {
        const blocks = normalizeBlocks(msg.message?.content);
        if (blocks.length) this.emit('assistant', a.sessionId ?? key, { uuid: msg.uuid, blocks });
        break;
      }
      case 'user': {
        // tool_result-ы от инструментов
        const blocks = normalizeBlocks(msg.message?.content).filter(b => b.type === 'tool_result');
        if (blocks.length) this.emit('tool_result', a.sessionId ?? key, { uuid: msg.uuid, blocks });
        break;
      }
      case 'result': {
        const sid = a.sessionId ?? key;
        const ok = msg.subtype === 'success';
        if (a.currentJobId != null) {
          this.store.markJob(a.currentJobId, ok ? 'done' : (a.interrupted ? 'interrupted' : 'error'), ok ? null : msg.subtype);
          this.emit('job.done', sid, {
            jobId: a.currentJobId, ok, subtype: msg.subtype,
            result: ok ? (msg.result ?? '').slice(0, 500) : null,
            costUsd: msg.total_cost_usd, turns: msg.num_turns, durationMs: msg.duration_ms,
          });
          a.currentJobId = null;
          a.interrupted = false;
        }
        // Обновляем usage/context в кэш, пока процесс жив
        this.refreshMeters(sid, a);
        // Есть ли следующий job этой сессии? Иначе — таймер на закрытие процесса
        const next = this.store.queuedForSession(sid)[0];
        if (a.stale) {
          this.closeProcess(a);   // настройки сменились во время хода — следующий ход в новом процессе
        } else if (!next) {
          a.idleTimer = setTimeout(() => this.closeProcess(a), this.cfg.idleProcessTimeoutMs);
        }
        // Слот освободился — очередь двигается сразу (ход другой сессии не ждёт простоя этой)
        setImmediate(() => this.pump());
        break;
      }
      default: break;
    }
  }

  async refreshMeters(sid, a) {
    try {
      const u = await a.q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
      this.usageCache = { ...u, fetchedAt: Date.now() };
      this.store.kvSet('usage', this.usageCache);
      this.emit('usage', sid, { usage: slimUsage(this.usageCache) });
    } catch { /* процесс мог закрыться */ }
    try {
      const c = await a.q.getContextUsage();
      const slim = { totalTokens: c.totalTokens, maxTokens: c.maxTokens, percentage: c.percentage, model: c.model, fetchedAt: Date.now() };
      this.contextCache.set(sid, slim);
      this.store.kvSet('contextCache', Object.fromEntries(this.contextCache));
      this.emit('context', sid, { context: slim });
    } catch { /* ок */ }
  }

  async markInterrupted(sessionKey) {
    const a = this.active.get(sessionKey);
    if (a) a.interrupted = true;
  }
}

// Краткое описание ввода инструмента для кнопки «Разрешить?» (без огромных содержимых файлов)
function summarizeInput(input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const k of ['command', 'description', 'file_path', 'path', 'pattern', 'url', 'query', 'notebook_path']) {
    if (input[k] != null) out[k] = String(input[k]).slice(0, 400);
  }
  if (input.old_string != null) out.old_string = String(input.old_string).slice(0, 300);
  if (input.new_string != null) out.new_string = String(input.new_string).slice(0, 300);
  if (input.content != null) out.content = String(input.content).slice(0, 300);
  return out;
}

export function slimUsage(u) {
  if (!u) return null;
  return {
    available: u.rate_limits_available,
    subscription: u.subscription_type,
    fiveHour: u.rate_limits?.five_hour ?? null,
    sevenDay: u.rate_limits?.seven_day ?? null,
    costUsd: u.session?.total_cost_usd ?? null,
    fetchedAt: u.fetchedAt,
  };
}

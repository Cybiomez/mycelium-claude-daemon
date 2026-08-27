// Менеджер: очередь ходов, живые query-процессы SDK, события для SSE
import { query } from '@anthropic-ai/claude-agent-sdk';
import crypto from 'node:crypto';
import { normalizeBlocks } from './history.mjs';

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
    this.listeners = new Set(); // SSE подписчики: fn(event)
    this.seq = 0;
    this.recent = [];          // кольцевой буфер последних событий для reconnect
    this.usageCache = store.kvGet('usage') ?? null;
    this.contextCache = new Map(Object.entries(store.kvGet('contextCache') ?? {}));
    this.commandsCache = store.kvGet('commands') ?? null;
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
  submit(sessionId, text, attachments) {
    const sessionKey = sessionId ?? ('new-' + crypto.randomUUID());
    const jobId = this.store.addJob(sessionKey, text, attachments);
    this.emit('job.queued', sessionKey, { jobId, text: text.slice(0, 200) });
    setImmediate(() => this.pump());
    return { jobId, sessionKey };
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
  }

  status(sessionKey) {
    const a = this.active.get(sessionKey);
    const queued = this.store.queuedForSession(sessionKey).length;
    return { running: !!a && a.currentJobId != null, alive: !!a, queued, startedAt: a?.startedAt ?? null };
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
      const busy = new Set([...this.active.keys()].filter(k => this.active.get(k).currentJobId != null));
      if (busy.size >= this.cfg.maxConcurrent) return;
      const job = this.store.nextQueuedJob(busy);
      if (!job) return;
      this.runJob(job).catch(e => this.log('runJob fatal:', e));
    }
  }

  buildPrompt(job) {
    const atts = JSON.parse(job.attachments || '[]');
    const content = [];
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
    if (a && !a.currentJobId) {
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
    const canUseTool = async (toolName, toolInput) => {
      if (toolName !== 'AskUserQuestion') return { behavior: 'allow', updatedInput: toolInput };
      const sid = a?.sessionId ?? key;
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
        this.emit(wasInterrupted ? 'job.interrupted' : 'job.error', key, { jobId: a.currentJobId, error: wasInterrupted ? null : e.message });
        a.currentJobId = null;
      }
    } finally {
      clearTimeout(a.idleTimer);
      this.active.delete(key);
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
        if (next) {
          setImmediate(() => this.pump());
        } else {
          a.idleTimer = setTimeout(() => { try { a.input.close(); } catch { /* уже закрыт */ } }, this.cfg.idleProcessTimeoutMs);
        }
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

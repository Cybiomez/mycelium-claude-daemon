// HTTP API демона. Только localhost. Авторизация: Bearer-токен из ~/.claude-pocket/token
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig, loadToken, UPLOADS_DIR } from './config.mjs';
import { openStore } from './store.mjs';
import { listSessions, readHistory, setCustomTitle } from './history.mjs';
import { Manager, slimUsage } from './manager.mjs';
import { forkSession } from '@anthropic-ai/claude-agent-sdk';
import { externalSessionPids } from './locks.mjs';
import { archiveSession, restoreSession, listArchive, purgeArchive } from './archive.mjs';

const VERSION = '0.4.1';
const log = (...a) => console.log(new Date().toISOString(), ...a);

const cfg = loadConfig();
// Сессии движка видны в VS Code наравне с остальными (см. config.entrypoint)
if (cfg.entrypoint && !process.env.CLAUDE_CODE_ENTRYPOINT) process.env.CLAUDE_CODE_ENTRYPOINT = cfg.entrypoint;
const token = loadToken();
const store = openStore();
const mgr = new Manager(cfg, store, log);

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// sessionKey из URL может быть temp-ключом, который уже переехал на реальный id
function resolveKey(key) {
  if (key.startsWith('new-')) return store.resolveAlias(key) ?? key;
  return key;
}

// Приводит документ папок к ожидаемому виду и самоисцеляется:
// выкидывает мусор, дубли id и привязки к несуществующим папкам.
function normalizeFolders(doc) {
  const seen = new Set();
  const folders = [];
  for (const f of Array.isArray(doc?.folders) ? doc.folders : []) {
    const id = typeof f?.id === 'string' ? f.id.trim() : '';
    const name = typeof f?.name === 'string' ? f.name.trim() : '';
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    folders.push({ id, name: name.slice(0, 60) });
  }
  const assignments = {};
  const src = doc?.assignments;
  if (src && typeof src === 'object' && !Array.isArray(src)) {
    for (const [sessionId, folderId] of Object.entries(src)) {
      if (typeof sessionId !== 'string' || typeof folderId !== 'string') continue;
      if (!seen.has(folderId)) continue;   // папку удалили — сессия уходит в общий список
      assignments[sessionId] = folderId;
    }
  }
  return { folders, assignments };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    // Авторизация (кроме health)
    if (p !== '/api/health') {
      const auth = req.headers.authorization ?? '';
      if (auth !== `Bearer ${token}`) return json(res, 401, { error: 'unauthorized' });
    }

    if (p === '/api/health') return json(res, 200, { ok: true, version: VERSION });

    if (p === '/api/sessions' && req.method === 'GET') {
      const sessions = await listSessions(cfg.cwd);
      const running = new Set(mgr.runningSessions());
      for (const s of sessions) {
        s.running = running.has(s.id);
        s.queued = store.queuedForSession(s.id).length;
      }
      return json(res, 200, { cwd: cfg.cwd, sessions });
    }

    let m;
    // Переименование сессии — пишем custom-title в транскрипт (как в Claude Code),
    // поэтому имя синхронизируется на все устройства. Пустая строка — сброс.
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/title$/)) && req.method === 'POST') {
      const key = resolveKey(m[1]);
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const ok = setCustomTitle(cfg.cwd, key, (body.title ?? '').toString().slice(0, 200));
      return json(res, ok ? 200 : 404, { ok });
    }
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/history$/)) && req.method === 'GET') {
      const key = resolveKey(m[1]);
      const items = await readHistory(cfg.cwd, key);
      return json(res, 200, { sessionId: key, items, status: mgr.status(key) });
    }

    // Ответ на живой опросник модели (AskUserQuestion)
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/answer$/)) && req.method === 'POST') {
      const key = resolveKey(m[1]);
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const ok = mgr.answerQuestion(key, body.answers ?? {});
      return json(res, 200, { ok });
    }
    // Решения человека: разрешение действия и утверждение плана (manager.ask)
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/permission$/)) && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const decision = ['allow', 'always', 'deny'].includes(body.decision) ? body.decision : 'deny';
      return json(res, 200, { ok: mgr.resolveRequest(String(body.requestId ?? ''), { decision }) });
    }
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/plan$/)) && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      return json(res, 200, { ok: mgr.resolveRequest(String(body.requestId ?? ''),
        { approve: !!body.approve, feedback: (body.feedback ?? '').toString().slice(0, 4000) }) });
    }
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/requests$/)) && req.method === 'GET') {
      return json(res, 200, { requests: mgr.pendingRequests(resolveKey(m[1])) });
    }
    // Развилка: копия сессии новой веткой (модель не вызывается)
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/fork$/)) && req.method === 'POST') {
      const key = resolveKey(m[1]);
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const r = await forkSession(key, { dir: cfg.cwd, ...(body.title ? { title: String(body.title).slice(0, 200) } : {}) });
      return json(res, 200, { sessionId: r.sessionId });
    }
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/interrupt$/)) && req.method === 'POST') {
      const key = resolveKey(m[1]);
      await mgr.markInterrupted(key);
      const ok = await mgr.interrupt(key);
      return json(res, 200, { ok });
    }

    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/context$/)) && req.method === 'GET') {
      const key = resolveKey(m[1]);
      return json(res, 200, { context: await mgr.getContext(key) });
    }

    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/settings$/))) {
      const key = resolveKey(m[1]);
      if (req.method === 'GET') {
        const s = store.getSettings(key);
        return json(res, 200, {
          permissionMode: s?.permission_mode ?? cfg.permissionMode,
          model: s?.model ?? cfg.model,
          effort: s?.effort ?? cfg.effort,
        });
      }
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        // Пустое значение — сброс к дефолту CLI; живой процесс перезапустится с новыми
        mgr.applySettings(key, body);
        return json(res, 200, { ok: true });
      }
    }

    if (p === '/api/messages' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const text = (body.text ?? '').toString();
      if (!text.trim()) return json(res, 400, { error: 'empty text' });
      const sessionId = body.sessionId ? resolveKey(body.sessionId) : null;
      const { jobId, sessionKey, position } = mgr.submit(sessionId, text, body.attachments ?? [], {
        settings: body.settings, channel: body.channel, priority: body.priority,
      });
      return json(res, 200, { jobId, sessionKey, position });
    }

    // Архив сессий (archive.mjs): полное удаление из рабочего пространства со сроком годности
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/archive$/)) && req.method === 'POST') {
      const key = resolveKey(m[1]);
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      if (externalSessionPids(key).length) return json(res, 409, { error: 'session is open in Claude Code (VS Code / CLI)' });
      if (!(await mgr.releaseSession(key))) return json(res, 409, { error: 'session is busy (turn running or queued)' });
      try {
        const manifest = await archiveSession(cfg, key, { reason: String(body.reason ?? 'delete').slice(0, 20), topic: body.topic ?? null });
        log(`архив: ${key.slice(0, 8)} «${manifest.title}» (${manifest.reason}) до ${new Date(manifest.expiresAt).toISOString().slice(0, 10)}`);
        return json(res, 200, manifest);
      } catch (e) { return json(res, e.code ?? 500, { error: e.message }); }
    }
    if (p === '/api/archive' && req.method === 'GET') {
      return json(res, 200, { archive: listArchive(cfg) });
    }
    if ((m = p.match(/^\/api\/archive\/([^/]+)\/restore$/)) && req.method === 'POST') {
      try {
        const r = restoreSession(cfg, m[1]);
        log(`архив: возвращена ${m[1].slice(0, 8)} «${r.title}»`);
        return json(res, 200, r);
      } catch (e) { return json(res, e.code ?? 500, { error: e.message }); }
    }
    if (p === '/api/archive/purge' && req.method === 'POST') {
      return json(res, 200, purgeArchive(cfg, store, log));
    }

    // Занята ли сессия внешним процессом Claude Code (VS Code / CLI) — см. locks.mjs
    if ((m = p.match(/^\/api\/sessions\/([^/]+)\/lock$/)) && req.method === 'GET') {
      const key = resolveKey(m[1]);
      const pids = key.startsWith('new-') ? [] : externalSessionPids(key);
      return json(res, 200, { locked: pids.length > 0, pids });
    }

    // Модели аккаунта (кэш supportedModels() из SDK) — клиенты строят по нему меню
    if (p === '/api/models' && req.method === 'GET') {
      return json(res, 200, mgr.getModels() ?? { models: [], fetchedAt: null });
    }

    // Очередь: что выполняется и что ждёт, по всем сессиям
    if (p === '/api/queue' && req.method === 'GET') {
      return json(res, 200, mgr.getQueue());
    }
    if ((m = p.match(/^\/api\/jobs\/(\d+)$/)) && req.method === 'DELETE') {
      return json(res, 200, { ok: mgr.cancelJob(Number(m[1])) });
    }

    // Папки сессий: раскладка живёт на сервере (kv в SQLite), поэтому одинакова
    // на любом устройстве и переживает переустановку приложения.
    // Документ: { folders: [{id, name}], assignments: { sessionId: folderId } }
    if (p === '/api/folders') {
      if (req.method === 'GET') {
        return json(res, 200, normalizeFolders(store.kvGet('folders')));
      }
      if (req.method === 'PUT') {
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        const doc = normalizeFolders(body);
        store.kvSet('folders', doc);
        return json(res, 200, doc);
      }
    }

    if (p === '/api/usage' && req.method === 'GET') {
      return json(res, 200, { usage: slimUsage(await mgr.getUsage()) });
    }

    if (p === '/api/commands' && req.method === 'GET') {
      return json(res, 200, { commands: mgr.getCommands() });
    }

    if (p === '/api/upload' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const name = (body.name ?? 'file').replace(/[^\w.\-]+/g, '_').slice(0, 80);
      const data = Buffer.from(body.base64 ?? '', 'base64');
      if (!data.length) return json(res, 400, { error: 'empty file' });
      const dir = path.join(UPLOADS_DIR, new Date().toISOString().slice(0, 10));
      fs.mkdirSync(dir, { recursive: true });
      const full = path.join(dir, crypto.randomBytes(4).toString('hex') + '-' + name);
      fs.writeFileSync(full, data);
      // Картинкой в диалог уходят только форматы, которые принимает API Claude;
      // остальное (включая heic и прочую экзотику) — файлом по пути
      const isImage = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(body.mime ?? '');
      return json(res, 200, {
        path: full,
        attachment: isImage
          ? { kind: 'image', mime: body.mime, base64: body.base64, path: full }
          : { kind: 'file', path: full },
      });
    }

    if (p === '/api/file' && req.method === 'GET') {
      // Read-only просмотр файлов в пределах HOME
      const reqPath = url.searchParams.get('path') ?? '';
      const full = path.resolve(cfg.cwd, reqPath);
      const home = path.resolve(cfg.cwd);
      if (!full.startsWith(home + path.sep) && full !== home) return json(res, 403, { error: 'outside home' });
      let st;
      try { st = fs.statSync(full); } catch { return json(res, 404, { error: 'not found' }); }
      if (st.isDirectory()) {
        const entries = fs.readdirSync(full, { withFileTypes: true })
          .filter(e => !e.name.startsWith('.git'))
          .map(e => ({ name: e.name, dir: e.isDirectory() }))
          .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
        return json(res, 200, { dir: true, path: full, entries: entries.slice(0, 500) });
      }
      if (st.size > 2 * 1024 * 1024) return json(res, 413, { error: 'file too large' });
      const buf = fs.readFileSync(full);
      const isText = !buf.subarray(0, 8000).includes(0);
      return json(res, 200, {
        dir: false, path: full, size: st.size,
        encoding: isText ? 'utf8' : 'base64',
        content: isText ? buf.toString('utf8') : buf.toString('base64'),
      });
    }

    if (p === '/api/stream' && req.method === 'GET') {
      const afterSeq = Number(req.headers['last-event-id'] ?? url.searchParams.get('afterSeq') ?? 0);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(':connected\n\n');
      const send = ev => res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      const unsub = mgr.subscribe(send, afterSeq);
      const ping = setInterval(() => res.write(':ping\n\n'), 20_000);
      req.on('close', () => { clearInterval(ping); unsub(); });
      return;
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    log('request error:', p, e.message);
    try { json(res, 500, { error: e.message }); } catch { /* headers sent */ }
  }
});

server.listen(cfg.port, cfg.host, () => {
  log(`mycelium-claude-daemon v${VERSION} слушает http://${cfg.host}:${cfg.port} (cwd=${cfg.cwd}, maxConcurrent=${cfg.maxConcurrent})`);
  // Чистая установка: списка моделей ещё нет — узнать его служебным процессом
  setTimeout(() => mgr.probeModels().catch(() => {}), 5_000);
  // Чистка архива: при старте и раз в 6 часов
  const purge = () => { try { purgeArchive(cfg, store, log); } catch (e) { log('архив: чистка не удалась:', e.message); } };
  setTimeout(purge, 60_000);
  setInterval(purge, 6 * 3600_000);
});

process.on('uncaughtException', e => log('uncaught:', e));
process.on('unhandledRejection', e => log('unhandled:', e));

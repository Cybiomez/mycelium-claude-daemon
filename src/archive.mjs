// Архив сессий: полное удаление сессии из рабочего пространства со сроком годности.
// Сессия = транскрипт <id>.jsonl + папка <id>/ (выводы инструментов, подагенты)
// + чек-лист session-todo/<id>.md. Всё переносится в отдельную папку архива вне
// ~/.claude: движок перестаёт видеть сессию (список строится по транскриптам),
// клиенты не воскрешают её тему. По истечении срока папка удаляется безвозвратно,
// вместе со строками сессии в базе движка. Пока срок не вышел — можно вернуть.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { projectsDir, readSessionMeta } from './history.mjs';

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = 86_400_000;

export function archiveDir(cfg) {
  return cfg.archiveDir || path.join(os.homedir(), 'archive', 'sessions');
}

// Части сессии на рабочем месте: [имя в архиве, путь на месте]
function parts(cwd, id) {
  const dir = projectsDir(cwd);
  return [
    ['transcript.jsonl', path.join(dir, id + '.jsonl')],
    ['files', path.join(dir, id)],
    ['todo.md', path.join(dir, 'session-todo', id + '.md')],
  ];
}

function safeName(s) {
  return (s || 'сессия').replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').trim().slice(0, 50) || 'сессия';
}

function readManifest(folder) {
  try { return JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8')); } catch { return null; }
}

export function listArchive(cfg) {
  const root = archiveDir(cfg);
  let names = [];
  try { names = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return []; }
  const out = [];
  for (const name of names) {
    const m = readManifest(path.join(root, name));
    if (m?.id) out.push({ ...m, folder: name });
  }
  return out.sort((a, b) => b.archivedAt - a.archivedAt);
}

function findFolder(cfg, id) {
  return listArchive(cfg).find(m => m.id === id) ?? null;
}

export async function archiveSession(cfg, id, { reason = 'delete', topic = null } = {}) {
  if (!ID_RE.test(id)) throw Object.assign(new Error('bad session id'), { code: 400 });
  const items = parts(cfg.cwd, id);
  if (!fs.existsSync(items[0][1])) throw Object.assign(new Error('session not found'), { code: 404 });
  const meta = await readSessionMeta(items[0][1]);
  // Открытые пункты чек-листа — клиенту (перенос в новую сессию при перезапуске темы)
  let openTodo = [];
  try { openTodo = fs.readFileSync(items[2][1], 'utf8').split('\n').filter(l => /^\s*- \[ \]/.test(l)); } catch { /* чек-листа нет */ }
  const now = Date.now();
  const days = Number(cfg.archiveRetentionDays) || 90;
  const root = archiveDir(cfg);
  const folder = path.join(root, `${new Date(now).toISOString().slice(0, 10)}_${id.slice(0, 8)}_${safeName(meta.title)}`);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const moved = [];
  for (const [name, src] of items) {
    if (!fs.existsSync(src)) continue;
    fs.renameSync(src, path.join(folder, name));
    moved.push(name);
  }
  const manifest = {
    id, title: meta.title, messageCount: meta.messageCount, reason, topic,
    archivedAt: now, expiresAt: now + days * DAY, parts: moved, openTodo,
  };
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  return manifest;
}

export function restoreSession(cfg, id) {
  if (!ID_RE.test(id)) throw Object.assign(new Error('bad session id'), { code: 400 });
  const m = findFolder(cfg, id);
  if (!m) throw Object.assign(new Error('not in archive'), { code: 404 });
  const folder = path.join(archiveDir(cfg), m.folder);
  const items = parts(cfg.cwd, id);
  for (const [, dst] of items) {
    if (fs.existsSync(dst)) throw Object.assign(new Error('session already exists in workspace'), { code: 409 });
  }
  for (const [name, dst] of items) {
    const src = path.join(folder, name);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(src, dst);
  }
  fs.rmSync(folder, { recursive: true, force: true });
  return { id, title: m.title, topic: m.topic };
}

// Удалить истёкшее безвозвратно. Итог — в .last-purge (по нему следит Console).
export function purgeArchive(cfg, store, log, now = Date.now()) {
  const root = archiveDir(cfg);
  const removed = [];
  for (const m of listArchive(cfg)) {
    if (!(m.expiresAt <= now)) continue;
    fs.rmSync(path.join(root, m.folder), { recursive: true, force: true });
    store.forgetSession(m.id);
    removed.push({ id: m.id, title: m.title });
    log(`архив: удалена безвозвратно ${m.id.slice(0, 8)} «${m.title}»`);
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const left = listArchive(cfg).length;
  fs.writeFileSync(path.join(root, '.last-purge'),
    JSON.stringify({ at: now, removed, left }, null, 2) + '\n', { mode: 0o600 });
  return { removed, left };
}

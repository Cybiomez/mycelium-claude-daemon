// SQLite: очередь сообщений (jobs) и настройки сессий
import Database from 'better-sqlite3';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

export function openStore() {
  const db = new Database(path.join(DATA_DIR, 'pocket.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,        -- реальный session_id или 'new-<uuid>' до первого init
      text TEXT NOT NULL,
      attachments TEXT,                 -- JSON-массив путей
      status TEXT NOT NULL DEFAULT 'queued',  -- queued | running | done | error | interrupted | cancelled
      error TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE TABLE IF NOT EXISTS session_settings (
      session_key TEXT PRIMARY KEY,
      permission_mode TEXT,
      model TEXT,
      effort TEXT
    );
    CREATE TABLE IF NOT EXISTS session_alias (
      temp_key TEXT PRIMARY KEY,        -- 'new-<uuid>'
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  // Миграции: колонки, добавленные после первой версии схемы
  const jobCols = new Set(db.prepare('PRAGMA table_info(jobs)').all().map(c => c.name));
  if (!jobCols.has('priority')) db.exec('ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 1');  // 1 — живой разговор, 0 — фоновые задания
  if (!jobCols.has('channel')) db.exec('ALTER TABLE jobs ADD COLUMN channel TEXT');                         // памятка канала на этот ход (см. manager.buildPrompt)
  return {
    db,
    addJob(sessionKey, text, attachments, { priority = 1, channel = null } = {}) {
      const r = db.prepare(
        'INSERT INTO jobs (session_key, text, attachments, created_at, priority, channel) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(sessionKey, text, JSON.stringify(attachments ?? []), Date.now(), priority, channel);
      return r.lastInsertRowid;
    },
    // Следующий ход: у каждой свободной сессии берём её первый queued-job, затем
    // выбираем по приоритету, а среди равных — сессию, которую дольше всех не
    // обслуживали (очередь по кругу: 5 сообщений одной темы не задерживают другую).
    nextQueuedJob(excludeKeys, lastServed = new Map()) {
      const rows = db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY id").all();
      const heads = new Map();
      for (const j of rows) {
        if (excludeKeys.has(j.session_key) || heads.has(j.session_key)) continue;
        heads.set(j.session_key, j);
      }
      let best = null;
      for (const j of heads.values()) {
        if (!best) { best = j; continue; }
        if (j.priority !== best.priority) { if (j.priority > best.priority) best = j; continue; }
        const a = lastServed.get(j.session_key) ?? 0, b = lastServed.get(best.session_key) ?? 0;
        if (a !== b) { if (a < b) best = j; continue; }
        if (j.id < best.id) best = j;
      }
      return best;
    },
    // Все ожидающие ходы в порядке поступления (для GET /api/queue)
    queuedJobs() {
      return db.prepare("SELECT id, session_key, text, priority, created_at FROM jobs WHERE status = 'queued' ORDER BY id").all();
    },
    // Убрать ход из очереди — только пока он не начался
    cancelJob(id) {
      return db.prepare("UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'queued'").run(Date.now(), id).changes > 0;
    },
    queuedForSession(sessionKey) {
      return db.prepare("SELECT * FROM jobs WHERE status = 'queued' AND session_key = ? ORDER BY id").all(sessionKey);
    },
    markJob(id, status, error = null) {
      const col = status === 'running' ? 'started_at' : 'finished_at';
      db.prepare(`UPDATE jobs SET status = ?, error = ?, ${col} = ? WHERE id = ?`).run(status, error, Date.now(), id);
    },
    getJob(id) { return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id); },
    remapSession(tempKey, sessionId) {
      db.prepare('INSERT OR REPLACE INTO session_alias (temp_key, session_id) VALUES (?, ?)').run(tempKey, sessionId);
      db.prepare('UPDATE jobs SET session_key = ? WHERE session_key = ?').run(sessionId, tempKey);
      const s = db.prepare('SELECT * FROM session_settings WHERE session_key = ?').get(tempKey);
      if (s) {
        db.prepare('DELETE FROM session_settings WHERE session_key = ?').run(tempKey);
        db.prepare('INSERT OR REPLACE INTO session_settings (session_key, permission_mode, model, effort) VALUES (?, ?, ?, ?)')
          .run(sessionId, s.permission_mode, s.model, s.effort);
      }
    },
    resolveAlias(tempKey) {
      return db.prepare('SELECT session_id FROM session_alias WHERE temp_key = ?').get(tempKey)?.session_id ?? null;
    },
    getSettings(sessionKey) {
      return db.prepare('SELECT * FROM session_settings WHERE session_key = ?').get(sessionKey) ?? null;
    },
    setSettings(sessionKey, { permissionMode, model, effort }) {
      const cur = this.getSettings(sessionKey) ?? {};
      db.prepare('INSERT OR REPLACE INTO session_settings (session_key, permission_mode, model, effort) VALUES (?, ?, ?, ?)')
        .run(sessionKey,
          permissionMode !== undefined ? permissionMode : cur.permission_mode ?? null,
          model !== undefined ? model : cur.model ?? null,
          effort !== undefined ? effort : cur.effort ?? null);
    },
    kvGet(key) {
      const v = db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value;
      return v ? JSON.parse(v) : null;
    },
    kvSet(key, value) {
      db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
    },
    // Окончательное удаление сессии (истёк срок в архиве): её строки больше не нужны
    forgetSession(sessionId) {
      db.prepare('DELETE FROM jobs WHERE session_key = ?').run(sessionId);
      db.prepare('DELETE FROM session_settings WHERE session_key = ?').run(sessionId);
      db.prepare('DELETE FROM session_alias WHERE session_id = ?').run(sessionId);
    },
    // На старте демона: подвисшие running-джобы -> error (демон перезапускался)
    recoverStale() {
      db.prepare("UPDATE jobs SET status = 'error', error = 'демон перезапущен во время выполнения' WHERE status = 'running'").run();
    },
  };
}

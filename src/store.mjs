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
      status TEXT NOT NULL DEFAULT 'queued',  -- queued | running | done | error | interrupted
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
  return {
    db,
    addJob(sessionKey, text, attachments) {
      const r = db.prepare(
        'INSERT INTO jobs (session_key, text, attachments, created_at) VALUES (?, ?, ?, ?)'
      ).run(sessionKey, text, JSON.stringify(attachments ?? []), Date.now());
      return r.lastInsertRowid;
    },
    nextQueuedJob(excludeKeys) {
      // Первый queued-job, чья сессия сейчас не занята
      const rows = db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY id").all();
      return rows.find(j => !excludeKeys.has(j.session_key)) ?? null;
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
    // На старте демона: подвисшие running-джобы -> error (демон перезапускался)
    recoverStale() {
      db.prepare("UPDATE jobs SET status = 'error', error = 'демон перезапущен во время выполнения' WHERE status = 'running'").run();
    },
  };
}

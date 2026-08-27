// Конфигурация демона: ~/.claude-pocket/config.json + токен
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const DATA_DIR = path.join(os.homedir(), '.claude-pocket');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

const DEFAULTS = {
  port: 8787,
  host: '127.0.0.1',
  cwd: os.homedir(),
  maxConcurrent: 2,
  // Режим по умолчанию для новых ходов; хранится и per-session в SQLite
  permissionMode: 'bypassPermissions',
  model: null,   // null = дефолт CLI
  effort: null,  // null = дефолт
  // Через сколько мс простоя закрывать живой CLI-процесс после ответа (экономия RAM)
  idleProcessTimeoutMs: 60_000,
};

export function loadConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(UPLOADS_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(DATA_DIR, 'config.json');
  let user = {};
  try { user = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* нет файла — дефолты */ }
  const cfg = { ...DEFAULTS, ...user };
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(DEFAULTS, null, 2) + '\n', { mode: 0o600 });
  return cfg;
}

// Токен авторизации: генерится один раз, права 600.
// Клиент забирает его по SSH (cat ~/.claude-pocket/token) после подключения.
export function loadToken() {
  const file = path.join(DATA_DIR, 'token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t) return t;
  } catch { /* создаём ниже */ }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  return token;
}

// '/home/alex' -> '-home-alex' (как кодирует Claude Code)
export function encodeCwd(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

// Чтение сессий из ~/.claude/projects/<encoded-cwd>/*.jsonl
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { encodeCwd } from './config.mjs';

export function projectsDir(cwd) {
  return path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwd));
}

// Быстрый список сессий: id, title, mtime. Заголовок — из записи ai-title/summary
// (ищем с конца файла), иначе первые слова первого user-сообщения.
export async function listSessions(cwd) {
  const dir = projectsDir(cwd);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
  } catch { return []; }
  const out = [];
  for (const f of files) {
    const full = path.join(dir, f);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.size === 0) continue;
    const id = f.replace(/\.jsonl$/, '');
    out.push({ id, mtime: st.mtimeMs, size: st.size, file: full });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  // Заголовки читаем только для 50 свежих (остальным лениво по запросу не нужны)
  const top = out.slice(0, 50);
  await Promise.all(top.map(async s => {
    const meta = await readSessionMeta(s.file);
    s.title = meta.title;
    s.lastText = meta.lastText;
    s.messageCount = meta.messageCount;
  }));
  return out.map(({ file, ...rest }) => rest);
}

async function readSessionMeta(file) {
  // customTitle — имя, заданное пользователем в Claude Code (CLI/десктоп), высший
  // приоритет. autoTitle — ai-title/summary. Берём последнюю запись каждого вида.
  let customTitle = null, autoTitle = null, lastText = null, firstUserText = null, messageCount = 0;
  try {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.type === 'custom-title' && rec.customTitle != null) customTitle = rec.customTitle;
      if (rec.type === 'ai-title' && rec.aiTitle) autoTitle = rec.aiTitle;
      if (rec.type === 'summary' && rec.summary) autoTitle = rec.summary;
      if (rec.isSidechain) continue;
      if (rec.type === 'user' && isInjectedUser(rec)) continue;
      if (rec.type === 'user' || rec.type === 'assistant') {
        messageCount++;
        const text = extractText(rec.message?.content);
        if (text) {
          lastText = text;
          if (!firstUserText && rec.type === 'user') firstUserText = text;
        }
      }
    }
  } catch { /* файл мог исчезнуть */ }
  // Пустой customTitle («») означает сброс к авто-имени
  const title = (customTitle && customTitle.trim())
    || autoTitle
    || (firstUserText && firstUserText.slice(0, 60))
    || null;
  return { title: title ?? '(без названия)', lastText: lastText?.slice(0, 120) ?? '', messageCount };
}

// Дописать запись custom-title в транскрипт — то же, что переименование в Claude Code.
// Пустая строка сбрасывает к авто-имени.
export function setCustomTitle(cwd, sessionId, customTitle) {
  const safe = path.basename(sessionId).replace(/\.jsonl$/, '');
  const file = path.join(projectsDir(cwd), safe + '.jsonl');
  if (!fs.existsSync(file)) return false;
  const rec = JSON.stringify({ type: 'custom-title', customTitle: String(customTitle), sessionId: safe });
  fs.appendFileSync(file, rec + '\n');
  return true;
}

// Служебные вставки Claude Code приходят записями роли user, но писал их не
// человек, и в ленту чата их пускать нельзя. Три независимых признака:
//   1) isMeta:true            — caveat'ы, system-reminder и подобное;
//   2) origin.kind не 'human' — уведомления фоновых задач (task-notification);
//      настоящий ввод — origin.kind === 'human' ЛИБО вовсе без origin (так шлёт
//      приложение), поэтому «не-human» ловим только когда origin реально задан;
//   3) текст-строка начинается с известного служебного тега — вывод и обёртки
//      слэш-команд (/compact, /exit) не помечены ни isMeta, ни origin, а поле
//      slug есть и у обычных сообщений, так что опознаём по самому тегу.
const INJECTED_TAG = /^﻿?\s*<\/?(task-notification|local-command-[a-z]+|command-(?:name|message|args)|system-reminder)[\s>]/i;

export function isInjectedUser(rec) {
  if (rec.isMeta) return true;
  const kind = rec.origin?.kind;
  if (typeof kind === 'string' && kind !== 'human') return true;
  const c = rec.message?.content;
  return typeof c === 'string' && INJECTED_TAG.test(c);
}

function extractText(content) {
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const texts = content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
  return texts || null;
}

// Полная история сессии в формате для клиента.
// Каждый элемент: { uuid, ts, role: 'user'|'assistant', blocks: [...] }
// Блоки: {type:'text',text} | {type:'thinking',text} | {type:'tool_use',id,name,input}
//        | {type:'tool_result',toolUseId,text,isError}
export async function readHistory(cwd, sessionId) {
  const file = path.join(projectsDir(cwd), sessionId + '.jsonl');
  const items = [];
  let rl;
  try {
    rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  } catch { return []; }
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.isSidechain) continue;
      if (rec.type !== 'user' && rec.type !== 'assistant') continue;
      // Служебные вставки (caveat, system-reminder, уведомления фоновых задач)
      // приходят как user-записи, но их писал не человек — в ленту не пускаем.
      if (rec.type === 'user' && isInjectedUser(rec)) continue;
      const msg = rec.message;
      if (!msg) continue;
      const blocks = normalizeBlocks(msg.content);
      if (!blocks.length) continue;
      // tool_result приходит внутри user-записей — не показываем их как сообщения юзера
      const onlyToolResults = blocks.every(b => b.type === 'tool_result');
      items.push({
        uuid: rec.uuid,
        ts: Date.parse(rec.timestamp) || 0,
        role: onlyToolResults ? 'tool' : rec.type,
        blocks,
      });
    }
  } catch { /* обрыв чтения — отдаём что есть */ }
  return items;
}

export function normalizeBlocks(content) {
  if (typeof content === 'string') {
    return content.trim() ? [{ type: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const b of content) {
    if (b.type === 'text' && b.text?.trim()) out.push({ type: 'text', text: b.text });
    else if (b.type === 'thinking' && b.thinking?.trim()) out.push({ type: 'thinking', text: b.thinking });
    else if (b.type === 'tool_use') out.push({ type: 'tool_use', id: b.id, name: b.name, input: safeInput(b.input) });
    else if (b.type === 'tool_result') out.push({
      type: 'tool_result',
      toolUseId: b.tool_use_id,
      text: toolResultText(b.content),
      isError: !!b.is_error,
    });
    else if (b.type === 'image') out.push({ type: 'text', text: '[изображение]' });
  }
  return out;
}

function safeInput(input) {
  try {
    const s = JSON.stringify(input);
    return s.length > 4000 ? { _truncated: s.slice(0, 4000) } : input;
  } catch { return {}; }
}

function toolResultText(content) {
  if (typeof content === 'string') return truncate(content);
  if (Array.isArray(content)) {
    return truncate(content.filter(b => b.type === 'text').map(b => b.text).join('\n'));
  }
  return '';
}

function truncate(s, n = 6000) {
  return s.length > n ? s.slice(0, n) + `\n… [обрезано, всего ${s.length} символов]` : s;
}

// Поиск внешних процессов Claude Code, открывших ту же сессию (VS Code, CLI).
// Два процесса, пишущие в один транскрипт, разводят историю — клиент должен
// предупредить человека. Собственные процессы демона (его потомки) не считаются.
import fs from 'node:fs';

function parentPid(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Поле comm в скобках может содержать пробелы — берём всё после последней ')'
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  } catch { return 0; }
}

function isOurDescendant(pid) {
  for (let p = pid, hops = 0; p > 1 && hops < 64; hops++) {
    if (p === process.pid) return true;
    p = parentPid(p);
  }
  return false;
}

// Возвращает PID внешних процессов, у которых в аргументах --resume <sessionId>
export function externalSessionPids(sessionId) {
  const found = [];
  let entries = [];
  try { entries = fs.readdirSync('/proc'); } catch { return found; }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    const pid = Number(e);
    let args;
    try { args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); } catch { continue; }
    const hit = args.some((a, i) => a === `--resume=${sessionId}` || (a === '--resume' && args[i + 1] === sessionId));
    if (hit && !isOurDescendant(pid)) found.push(pid);
  }
  return found;
}

// Свободная память по /proc/meminfo (MemAvailable), МБ
export function memAvailableMb() {
  try {
    const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m);
    return m ? Math.round(Number(m[1]) / 1024) : Infinity;
  } catch { return Infinity; }
}

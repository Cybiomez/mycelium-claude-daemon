# mycelium-claude-daemon — MyCelium ClaudeDaemon (движок сессий Claude)

**Общий движок сессий Claude Code** — ядро экосистемы MyCelium. HTTP-API на `127.0.0.1:8787`, за которым живут сессии Claude Code (создать/продолжить, поток ответов, история, прерывание, интерактивные вопросы).

Вынесен из [claude-pocket](https://github.com/Cybiomez/claude-pocket) как **независимый модуль**: одним ядром пользуются разные клиенты — мобильное приложение claude-pocket, Telegram-чат экосистемы, будущий оркестратор сессий.

## Что это

- Node.js-сервис на `@anthropic-ai/claude-agent-sdk`. Точка входа — `src/server.mjs`.
- API (Bearer-токен, только localhost):

  | Метод | Что |
  |---|---|
  | `POST /api/messages` | Ход в сессию (`sessionId=null` → новая). Необязательно: `settings` {model, effort, permissionMode} — применяются до запуска; `channel` — памятка канала; `priority` (1 разговор, 0 фон) |
  | `GET /api/stream` | Поток событий SSE (`job.queued` с позицией, `job.waiting`, `job.cancelled`, `models.changed`, …) |
  | `GET /api/sessions`, `…/:id/history`, `…/:id/title` | Список, история, переименование |
  | `GET/POST /api/sessions/:id/settings` | Модель / effort / режим; смена перезапускает живой процесс |
  | `GET /api/sessions/:id/lock` | Открыта ли сессия внешним Claude Code (VS Code, CLI) |
  | `POST /api/sessions/:id/archive` | Удалить сессию в архив (`~/archive/sessions`, 90 дней, потом безвозвратно) |
  | `GET /api/archive`, `POST /api/archive/:id/restore` | Что в архиве; вернуть сессию на место |
  | `POST …/:id/interrupt`, `…/:id/answer` | Прерывание, ответ на `AskUserQuestion` |
  | `GET /api/models` | Модели аккаунта и их уровни effort (кэш `supportedModels()`) |
  | `GET /api/queue`, `DELETE /api/jobs/:id` | Очередь; убрать ход, пока он не начался |
  | `GET /api/usage`, `…/:id/context`, `/api/commands`, `/api/upload`, `/api/file`, `/api/folders` | Лимиты, контекст, слеш-команды, файлы, папки |

- Очередь: один живой ход на весь демон (`maxConcurrent`), по кругу между сессиями, разговор впереди фоновых заданий. Сторож памяти: новый процесс Claude не стартует, пока `MemAvailable` < `minFreeMemMb`.
- Каталог данных — `~/.claude-pocket`, переопределяется `CLAUDE_DAEMON_DATA_DIR` (тестовый экземпляр рядом с рабочим).

## Установка

```bash
./deploy/install.sh
```
Ставит код в `~/.mycelium-claude-daemon/app`, поднимает systemd-сервис `mycelium-claude-daemon` на `127.0.0.1:8787`. Данные (config, token) — в `~/.claude-pocket` (совместимо с клиентом claude-pocket; существующий токен переиспользуется). Если на машине работает старый `claude-pocketd` — установщик его заменяет (тот же порт).

## Клиенты

- **claude-pocket** (Android) — подключается по SSH-туннелю к `:8787`, токен `~/.claude-pocket/token`.
- **Telegram-бот** экосистемы (в работе) — темы супергруппы = сессии демона.
- **Оркестратор** (позже) — несколько сессий через тот же API.

## Часть экосистемы

Слой L5 (инструменты). Реестр модуля — на дашборде MyCelium Console.

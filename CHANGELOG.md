# Changelog

## 0.3.0 — не выпущено

- Режим «С подтверждением»: событие `permission`, ответ `POST /api/sessions/:id/permission` (allow / always / deny).
- Режим «План»: событие `plan` (ExitPlanMode), ответ `POST /api/sessions/:id/plan` (approve, feedback); после утверждения — без вопросов до конца хода.
- `GET /api/sessions/:id/requests`, `POST /api/sessions/:id/fork` (развилка через `forkSession`).
- Установщик не перезапускает демон посреди хода.

## 0.2.0 — не выпущено

Подготовка к Telegram-клиенту (ТЗ `~/projects/notes/tz-claude-tg-bot.md`, §10).

- Список моделей аккаунта: кэш `supportedModels()`, `GET /api/models`, событие `models.changed`; при пустом кэше — служебный процесс только ради списка.
- `POST /api/messages` принимает `settings`, `channel`, `priority` и возвращает позицию в очереди.
- Смена настроек при живом процессе перезапускает его (сразу, если простаивает, иначе после хода).
- Очередь: `maxConcurrent: 1` по умолчанию, по кругу между сессиями, приоритеты, `GET /api/queue`, `DELETE /api/jobs/:id`, событие `job.cancelled`.
- Сторож памяти (`minFreeMemMb`, `memoryRetryMs`): событие `job.waiting`, простаивающие процессы закрываются первыми.
- `GET /api/sessions/:id/lock` — сессия открыта внешним Claude Code.
- Памятки каналов (`channelMemos`): добавляются к ходу блоком `<channel-context>`, из истории вырезаются.
- `CLAUDE_DAEMON_DATA_DIR` — переопределение каталога данных.
- Исправлено: запись процесса новой сессии не удалялась после его завершения (следующий ход уходил в мёртвый процесс); процесс, закрытый по простою, мог получить новый ход; после хода очередь не двигалась до закрытия процесса по простою.

## 0.1.0 — 27-08-2026

Ядро вынесено из claude-pocket в отдельный модуль.

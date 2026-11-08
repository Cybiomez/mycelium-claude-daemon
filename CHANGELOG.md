# Changelog

## 0.4.1 — не выпущено

- Сессии движка пишутся с меткой `local-agent` (настройка `entrypoint`), а не `sdk-ts`: расширение VS Code перестаёт их прятать — видны сессии из Telegram, ClaudePocket и после `/fresh`.

## 0.4.0 — не выпущено

Архив сессий (ТЗ `~/projects/notes/tz-session-archive.md`).

- `POST /api/sessions/:id/archive` (`reason`, `topic`) — сессия целиком (транскрипт, папка файлов, чек-лист `session-todo`) переносится в `~/archive/sessions/<дата>_<id8>_<название>/` с `manifest.json`; движок перестаёт её видеть. Отказ, если идёт или ждёт ход, или сессия открыта в Claude Code; простаивающий процесс закрывается.
- `GET /api/archive`, `POST /api/archive/:id/restore` — список и возврат на место.
- Чистка: при старте и раз в 6 часов истёкшее (по умолчанию 90 дней, `archiveRetentionDays`) удаляется безвозвратно вместе со строками сессии в базе; итог — `~/archive/sessions/.last-purge`, карточка в MyCelium Console. Ручной запуск — `POST /api/archive/purge`.

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

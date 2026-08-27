# mycelium-mind — движок сессий Claude

**Общий движок сессий Claude Code** — ядро экосистемы MyCelium. HTTP-API на `127.0.0.1:8787`, за которым живут сессии Claude Code (создать/продолжить, поток ответов, история, прерывание, интерактивные вопросы).

Вынесен из [claude-pocket](https://github.com/Cybiomez/claude-pocket) как **независимый модуль**: одним ядром пользуются разные клиенты — мобильное приложение claude-pocket, Telegram-чат экосистемы, будущий оркестратор сессий.

## Что это

- Node.js-сервис на `@anthropic-ai/claude-agent-sdk`. Точка входа — `src/server.mjs`.
- API (Bearer-токен, только localhost): `POST /api/messages` (создать/продолжить сессию), `GET /api/stream` (поток событий), `GET /api/sessions`, история, `interrupt`, `answer`, `usage`, `context`.
- Управляет несколькими сессиями одновременно (`sessionId=null` → новая).

## Установка

```bash
./deploy/install.sh
```
Ставит код в `~/.mycelium-mind/app`, поднимает systemd-сервис `mycelium-mind` на `127.0.0.1:8787`. Данные (config, token) — в `~/.claude-pocket` (совместимо с клиентом claude-pocket; существующий токен переиспользуется). Если на машине работает старый `claude-pocketd` — установщик его заменяет (тот же порт).

## Клиенты

- **claude-pocket** (Android) — подключается по SSH-туннелю к `:8787`, токен `~/.claude-pocket/token`.
- **Telegram-чат** экосистемы (в работе) — мост в одну выделенную сессию.
- **Оркестратор** (позже) — несколько сессий через тот же API.

## Часть экосистемы

Слой L5 (инструменты). Реестр модуля — на дашборде MyCelium Console.

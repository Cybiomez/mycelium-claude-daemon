#!/usr/bin/env bash
# Установка mycelium-claude-daemon — общего движка сессий Claude Code (ядро экосистемы).
# Ставит код в ~/.mycelium-claude-daemon/app, поднимает systemd-сервис на 127.0.0.1:8787.
# Данные (config, token) — в ~/.claude-pocket (совместимость с клиентом claude-pocket).
set -euo pipefail

INSTALL_DIR="$HOME/.mycelium-claude-daemon/app"
SERVICE=/etc/systemd/system/mycelium-claude-daemon.service

say() { printf '\033[1;36m[mycelium-claude-daemon]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[mycelium-claude-daemon]\033[0m %s\n' "$*" >&2; exit 1; }

# 1. Проверки
command -v node >/dev/null 2>&1 || die "Нужен Node.js >= 20"
[ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -ge 20 ] || die "Node.js слишком старый, нужен >= 20"
command -v npm >/dev/null 2>&1 || die "Не найден npm"
command -v claude >/dev/null 2>&1 || die "Не найден Claude Code CLI (npm i -g @anthropic-ai/claude-code && claude)"

# 2. Код ядра из репозитория
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
say "Ставлю код: $SRC_DIR → $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cp -r "$SRC_DIR/src" "$SRC_DIR/package.json" "$INSTALL_DIR/"
cp "$SRC_DIR/package-lock.json" "$INSTALL_DIR/" 2>/dev/null || true

# 3. Зависимости
say "Ставлю npm-зависимости…"
( cd "$INSTALL_DIR" && npm install --omit=dev --no-audit --no-fund --loglevel=error )

# 4. Конфиг и токен (DATA_DIR=~/.claude-pocket по config.mjs; существующий токен переиспользуется)
( cd "$INSTALL_DIR" && node -e "import('./src/config.mjs').then(m => { m.loadConfig(); m.loadToken(); console.log('ok'); })" )
chmod 600 "$HOME/.claude-pocket/token" 2>/dev/null || true

# 5. Миграция со старого claude-pocketd (тот же порт 8787 — иначе конфликт)
if systemctl is-active claude-pocketd >/dev/null 2>&1 || systemctl is-enabled claude-pocketd >/dev/null 2>&1; then
  say "Останавливаю старый claude-pocketd (заменяется на mycelium-claude-daemon)…"
  sudo systemctl disable --now claude-pocketd 2>/dev/null || true
fi

# 6. systemd-сервис (system-level, переживает logout)
say "Регистрирую systemd-сервис (нужен sudo)…"
sudo tee "$SERVICE" > /dev/null <<UNIT
[Unit]
Description=MyCelium Daemon — движок сессий Claude Code (общее ядро)
After=network.target

[Service]
Type=simple
User=$USER
Environment=HOME=$HOME
Environment=PATH=$PATH
WorkingDirectory=$INSTALL_DIR
ExecStart=$(command -v node) $INSTALL_DIR/src/server.mjs
Restart=always
RestartSec=3
# Слушает только 127.0.0.1 — наружу недоступен
[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable mycelium-claude-daemon

# Не перезапускать посреди хода: перезапуск обрывает идущие сессии Claude.
# Ждём до 3 минут; FORCE=1 — без ожидания.
busy() {
  local tok; tok="$(cat "$HOME/.claude-pocket/token" 2>/dev/null)" || return 1
  curl -s -m 5 -H "Authorization: Bearer $tok" http://127.0.0.1:8787/api/queue \
    | python3 -c 'import json,sys; q=json.load(sys.stdin); sys.exit(0 if q.get("running") or q.get("queued") else 1)' 2>/dev/null
}
if [ "${FORCE:-0}" != 1 ]; then
  for i in $(seq 1 36); do busy || break; [ "$i" = 1 ] && say "Идёт ход — жду, пока закончится…"; sleep 5; done
  busy && die "Ход всё ещё идёт — перезапуск отложен. Повторите позже или FORCE=1 ./deploy/install.sh"
fi
sudo systemctl restart mycelium-claude-daemon

# Манифест для дашборда MyCelium Console (модуль объявляет себя)
if [ -f "$SRC_DIR/registry.json" ]; then
  mkdir -p "$HOME/.config/eco/registry"
  cp "$SRC_DIR/registry.json" "$HOME/.config/eco/registry/07-mycelium-claude-daemon.json"
fi

say "Готово. Демон на http://127.0.0.1:8787 (токен: ~/.claude-pocket/token)."

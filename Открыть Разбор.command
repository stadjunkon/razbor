#!/bin/zsh
# Двойной щелчок запускает приложение и открывает его в браузере.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
cd "$(dirname "$0")"
URL="http://localhost:3170"
if curl -s -o /dev/null "$URL"; then
  open "$URL"
  exit 0
fi
(sleep 1; open "$URL") &
exec node tools/server.mjs

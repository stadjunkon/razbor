#!/bin/zsh
# Нужен один раз: без входа кнопка «Разобрать» не может запустить Claude.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
claude auth login
echo
if claude auth status 2>/dev/null | grep -q '"loggedIn": true'; then
  echo "Вход выполнен. Это окно можно закрыть, разбор в приложении запустится сам."
else
  echo "Вход не завершён. Запусти этот файл ещё раз и доведи вход в браузере до конца."
fi

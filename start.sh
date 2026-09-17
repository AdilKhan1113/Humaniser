#!/usr/bin/env bash
# One command to get Humaniser running on a Mac.
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed."
  echo
  echo "Install it with Homebrew:   brew install node"
  echo "Or download it from:        https://nodejs.org"
  exit 1
fi

major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 18 ]; then
  echo "Node $(node -v) is too old. Humaniser needs 18 or newer."
  echo "Upgrade with:  brew upgrade node"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies (once)…"
  npm install --silent
fi

PORT="${PORT:-8787}"

# Give the server a moment, then open the browser. macOS has `open`; Linux has
# `xdg-open`. If neither exists the URL is printed anyway.
(
  sleep 1.2
  if command -v open >/dev/null 2>&1; then
    open "http://127.0.0.1:${PORT}"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://127.0.0.1:${PORT}" >/dev/null 2>&1
  fi
) &

PORT="$PORT" exec node server.js

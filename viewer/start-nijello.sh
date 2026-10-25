#!/usr/bin/env bash
# Starts Nijello on the live arena (scrabblebot on maincloud). The first
# time, it asks for the bot token with hidden input; the client then saves
# it to ~/scrabblebot-evo/live/.token-Nijello and later starts need nothing.
set -euo pipefail
export PATH="$HOME/.local/node/current/bin:$PATH"
cd "$HOME/scrabblebot-evo/live"
if [ ! -s .token-Nijello ] && [ -z "${BOT_TOKEN:-}" ]; then
  read -rsp "Paste Nijello's token from the Team page (it stays hidden), then press Enter: " BOT_TOKEN
  echo
  export BOT_TOKEN
fi
BOT_NAME=Nijello exec npm start

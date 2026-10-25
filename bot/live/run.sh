#!/usr/bin/env bash
# Keeps the live bot running: restarts it a few seconds after any exit
# (disconnect, crash). Uses the token saved in .token-$BOT_NAME.
#   BOT_NAME=Nijello ./run.sh            lobby play
#   BOT_NAME=Nijello TOURNAMENT_ID=7 ./run.sh
set -u
cd "$(dirname "$0")"
export PATH="$HOME/.local/node/current/bin:$PATH"
while true; do
  npx tsx bot.ts 2>&1 | tee -a "${BOT_NAME}.log"
  echo "[$(date +%T)] bot exited; restarting in 3 s" | tee -a "${BOT_NAME}.log"
  sleep 3
done

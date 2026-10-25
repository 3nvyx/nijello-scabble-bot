#!/usr/bin/env bash
# Starts Nijello at boot (from the asus crontab, @reboot) in the tmux
# session "nijello", the same way it is started by hand: live/run.sh, which
# restarts the bot after any exit and logs to live/Nijello.log. Does nothing
# if the session already exists, so a running Nijello is never touched.
#
#   ~/scrabble-live/boot-nijello.sh
set -u
LIVE="$HOME/scrabblebot-evo/live"
LOG="$HOME/scrabble-live/start-web.log"
export PATH="$HOME/.local/node/current/bin:/usr/local/bin:/usr/bin:/bin"

log() { echo "$(date '+%F %T') [nijello] $*" >> "$LOG"; }

if tmux has-session -t nijello 2>/dev/null; then
  log "nijello session already running; nothing to do"
  exit 0
fi
if [ ! -s "$LIVE/.token-Nijello" ]; then
  log "no saved token in $LIVE/.token-Nijello; not started"
  exit 1
fi

# Up to 10 minutes for the network; run.sh retries on its own after that.
for _ in $(seq 1 120); do
  getent hosts maincloud.spacetimedb.com > /dev/null && break
  sleep 5
done

# PARAMS: the released strategy (ops/release.sh writes it); without it the
# client falls back to runs/main/best.json, an old generation-0 file.
# PLAN: look-ahead bidding in the last 12 auctions with a 450 ms budget.
tmux new-session -d -s nijello -c "$LIVE" \
  "BOT_NAME=Nijello PARAMS=$HOME/scrabblebot-evo/runs/live/params.json PLAN=12,450 ./run.sh"
log "started nijello (live/run.sh)"

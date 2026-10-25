#!/usr/bin/env bash
# Starts the live site (server.ts) in the tmux session "live-web", unless it
# is already running. Run at boot from the asus crontab (@reboot), so it
# first waits for the Tailscale address the site listens on.
#
#   ~/scrabble-live/start-web.sh
set -u
HOST="${LIVE_HOST:?set LIVE_HOST to the Tailscale IP of the machine}"
PORT=8090
DIR="$HOME/scrabble-live"
LOG="$DIR/start-web.log"
export PATH="$HOME/.local/node/current/bin:/usr/local/bin:/usr/bin:/bin"

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

if tmux has-session -t live-web 2>/dev/null; then
  log "live-web already running; nothing to do"
  exit 0
fi

# Up to 10 minutes for Tailscale to bring up its address after boot.
for _ in $(seq 1 120); do
  ip -o addr show 2>/dev/null | grep -q " $HOST/" && break
  sleep 5
done
if ! ip -o addr show | grep -q " $HOST/"; then
  log "Tailscale address $HOST never came up; site not started"
  exit 1
fi

tmux new-session -d -s live-web \
  "cd '$DIR' && nice -n 19 node server.ts --host $HOST --port $PORT 2>&1 | tee -a server.log"
log "started live-web on http://$HOST:$PORT"

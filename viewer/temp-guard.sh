#!/usr/bin/env bash
# Keeps the machine under its 104 C emergency shutdown. Reads the hottest
# thermal sensor every 10 s:
#
#   above STOP_C (100) two readings in a row: stop the training run (tmux
#                      session SESSION). It saves a checkpoint every
#                      generation; resume it with --resume once cool.
#   above KILL_C (102) one reading: also stop every other heavy job of this
#                      user (training, calibration, benchmarks, replays)
#                      and unload any Ollama model.
#
# Nijello (live/bot.ts) and the live site (server.ts) are never touched.
# Runs until stopped; log in ~/scrabble-live/temp-guard.log.
#
#   tmux new-session -d -s temp-guard ~/scrabble-live/temp-guard.sh
set -u
STOP_C="${STOP_C:-100}"
KILL_C="${KILL_C:-102}"
SESSION="${SESSION:-next-train}"
LOG="$HOME/scrabble-live/temp-guard.log"
export PATH="$HOME/.local/node/current/bin:/usr/local/bin:/usr/bin:/bin"
# Heavy jobs from the training project; the live bot and site don't match.
HEAVY='src/(train|profile|fit-styles|calibrate-bids|calibrate|bench|snapshots|fidelity)\.ts'

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }
hottest() { cat /sys/class/thermal/thermal_zone*/temp | sort -n | tail -1; }

stop_training() {
  tmux has-session -t "$SESSION" 2>/dev/null || return 0
  tmux kill-session -t "$SESSION"
  echo "[$(date +%T)] stopped by temp-guard at $1 C" >> "$HOME/scrabblebot-next/runs/v6-sizes.log"
  log "STOPPED training ($SESSION) at $1 C; resume with --resume once it has cooled"
}

stop_everything_heavy() {
  stop_training "$1"
  if pkill -u "$(id -u)" -f "$HEAVY"; then log "EMERGENCY at $1 C: killed heavy jobs matching $HEAVY"; fi
  local m
  for m in $(ollama ps 2>/dev/null | awk 'NR > 1 { print $1 }'); do
    ollama stop "$m" >/dev/null 2>&1 && log "EMERGENCY at $1 C: unloaded Ollama model $m"
  done
}

log "guard started: stop training above ${STOP_C} C (2 readings), stop all heavy jobs above ${KILL_C} C"
over=0
peak=0
last_ok=$SECONDS
while true; do
  t=$(( $(hottest) / 1000 ))
  (( t > peak )) && peak=$t
  if (( t > KILL_C )); then
    log "hottest sensor ${t} C, above ${KILL_C} C"
    stop_everything_heavy "$t"
    over=0
  elif (( t > STOP_C )); then
    over=$((over + 1))
    log "hottest sensor ${t} C, above ${STOP_C} C (reading $over of 2)"
    (( over >= 2 )) && { stop_training "$t"; over=0; }
  else
    over=0
  fi
  # Hourly line so the log shows the guard is alive.
  if (( SECONDS - last_ok >= 3600 )); then
    log "ok: now ${t} C, peak ${peak} C this hour"
    peak=0
    last_ok=$SECONDS
  fi
  sleep 10
done

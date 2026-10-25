#!/usr/bin/env bash
# Release gate for the live bot. Watches a training run's best.json and,
# each time it changes, replays our real matches (same opponents, profiled;
# src/profile.ts --check) with the live params and the candidate on
# identical tables. The candidate goes live only if it beats the live
# params by more than 2 paired standard errors of place.
#
#   ops/release.sh runs/v5-profiles [seconds between checks] [replays]
#
# The live bot reads runs/live/params.json at each match start, so a
# release takes effect at the next match and never mid-match.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/node/current/bin:$PATH"
RUN="${1:?training run directory}"
EVERY="${2:-300}"
REPS="${3:-6}"
LIVE=runs/live/params.json
SINCE="${SINCE:-1056}"
mkdir -p runs/live
[ -s "$LIVE" ] || { echo "$LIVE missing: copy the params the live bot plays now there first" >&2; exit 1; }

stamp() { node -e 'try { const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(`${j.gen}@${j.savedAt}`) } catch { console.log("") }' "$1"; }
last="$(stamp "$LIVE")"
while true; do
  cand="$(stamp "$RUN/best.json")"
  if [ -n "$cand" ] && [ "$cand" != "$last" ]; then
    last="$cand"
    out="$(nice -n 5 node src/profile.ts --check "$LIVE" "$RUN/best.json" --since "$SINCE" --reps "$REPS")"
    echo "[$(date +%T)] candidate gen ${cand%@*}"
    echo "$out" | tail -n 6
    read -r d se < <(echo "$out" | sed -n 's/.*B - A place: \([-+0-9.]*\) +- \([0-9.]*\).*/\1 \2/p')
    if node -e 'process.exit(Number(process.argv[1]) >= Number(process.argv[2]) ? 0 : 1)' "$d" "$se"; then
      cp "$LIVE" "runs/live/params.before.$(date +%H%M%S).json"
      cp "$RUN/best.json" "$LIVE.tmp" && mv "$LIVE.tmp" "$LIVE"
      echo "[$(date +%T)] RELEASED gen ${cand%@*}: place $d +- $se on replays of our live matches"
    else
      echo "[$(date +%T)] held back: place $d +- $se is not above 2 SE"
    fi
  fi
  sleep "$EVERY"
done

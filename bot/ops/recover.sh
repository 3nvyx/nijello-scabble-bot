#!/usr/bin/env bash
# Recovery after the DGX froze. Run on the DGX, one step at a time,
# checking the output before the next:
#   ops/recover.sh diag             what happened (reboot? OOM? what is still running)
#   ops/recover.sh evolve           continuous evolution (resumes the run if it has a checkpoint)
#   ops/recover.sh golive-when SEC  wait until the run has SEC seconds of training, then golive
#   ops/recover.sh golive           start Nijello on runs/live/params.json, the release gate and the plain monitor
#
# No LLM: both freezes (01:50, 02:23) came minutes after Qwen started
# generating on the GPU while training filled the CPU. Training alone ran
# for hours without trouble.
#
# Nothing here kills a process. Steps refuse to run if what they would start
# is already running; stop that by exact PID or tmux window yourself.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/node/current/bin:$PATH"
RUN=runs/v5-profiles

has_session() { tmux has-session -t "$1" 2>/dev/null; }
# A crash can leave a just-written file empty (it emptied src/monitor.ts).
valid_json() { node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$1" 2>/dev/null; }
has_window() { tmux list-windows -t evo -F '#W' 2>/dev/null | grep -qx "$1"; }
elapsed() { node -e 'try { console.log(Math.floor(JSON.parse(require("fs").readFileSync(process.argv[1])).elapsedBefore / 1000)) } catch { console.log(0) }' "$RUN/checkpoint.json"; }

golive() {
  valid_json runs/live/params.json || { echo "runs/live/params.json missing or corrupt" >&2; exit 1; }
  # Nijello reads runs/live/params.json at each match start. Only the
  # release gate (ops/release.sh) writes it, after a candidate beats the
  # live params on paired replays of our real matches, so changes go live at
  # the next match and never mid-match.
  # PLAN: look-ahead bidding in the last 12 auctions, 450 ms per decision
  # (src/planner.ts); it won +0.023 +- 0.006 place on replays of our matches.
  has_session nijello || tmux new-session -d -s nijello -c "$PWD/live" "BOT_NAME=Nijello PARAMS=$PWD/runs/live/params.json PLAN=${PLAN:-12,450} ./run.sh"
  has_window release || tmux new-window -d -t evo -n release "ops/release.sh $RUN 300 6 2>&1 | tee -a runs/release.log"
  has_session evo || tmux new-session -d -s evo -n shell
  has_window monitor || tmux new-window -d -t evo -n monitor \
    "export PATH=$PATH; nice -n 10 node src/monitor.ts --bot Nijello --no-llm 2>&1 | tee -a runs/monitor.log; echo EXITED; sleep 86400"
  tmux ls
}

case "${1:-}" in
diag)
  echo "== boot"; uptime; uptime -s; last -x reboot shutdown 2>/dev/null | head -4 || true
  echo "== previous boot, errors and OOM"
  journalctl -b -1 -p err --no-pager 2>/dev/null | tail -15 || echo "(no previous boot log readable)"
  journalctl -k -b -1 --no-pager 2>/dev/null | grep -iE 'oom|out of memory|thermal|watchdog|nvrm|xid' | tail -15 || true
  echo "== network"; ip -br addr | grep -v '^lo'; tailscale status 2>/dev/null | head -3 || true
  echo "== what is running"; tmux ls 2>/dev/null || echo "(no tmux server)"
  pgrep -af 'src/train.ts|src/monitor.ts|tsx bot.ts|ollama' || true
  echo "== files emptied by the crash"; find src live/bot.ts live/run.sh data runs -maxdepth 2 -type f -size 0 2>/dev/null || true
  echo "== resources"; free -g; nvidia-smi --query-gpu=utilization.gpu,temperature.gpu,power.draw --format=csv
  ;;
evolve)
  if pgrep -f 'node src/train.ts' >/dev/null; then echo "a training run is already running; not starting another" >&2; exit 1; fi
  ollama stop qwen3.5:27b 2>/dev/null || true
  node src/field.ts | tail -3
  mkdir -p "$RUN"
  # 18 workers leaves two cores for the live bot's 1 s auctions and the
  # release gate's replays.
  common="--workers 18 --lambda 64 --games 400 --hof-every 25 --hof-max 24 --bench-every 10 --out $RUN"
  if valid_json "$RUN/checkpoint.json"; then
    args="--resume --hours 10 $common"
  else
    echo "no usable checkpoint: starting fresh from runs/live/params.json"
    valid_json runs/live/params.json || { echo "runs/live/params.json missing or corrupt" >&2; exit 1; }
    cp runs/live/params.json "$RUN/init.json"
    args="--hours 10 --init $RUN/init.json --sigma 0.25 $common"
  fi
  has_session evo || tmux new-session -d -s evo -n shell
  # Half of all top-bot seats go to the strongest live bots' profiles.
  tmux new-window -d -t evo -n v5 "FOCUS=\"${FOCUS:-postturing,Chinese Dante}\" node src/train.ts $args 2>&1 | tee -a $RUN.log"
  # train.ts reloads data/field.json when it changes and re-measures its peak.
  has_window field || tmux new-window -d -t evo -n field "while true; do sleep 900; node src/field.ts; done"
  echo "evolution: node src/train.ts $args"
  ;;
golive-when)
  need="${2:?seconds}"
  until [ "$(elapsed)" -ge "$need" ]; do sleep 20; done
  echo "run has $(elapsed) s of training"
  golive
  ;;
golive)
  golive
  ;;
*)
  sed -n 2,9p "$0"; exit 2
  ;;
esac

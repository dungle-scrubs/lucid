#!/bin/zsh
# Bounded orchestrator for the three interactive spikes, using the verified
# hook-isolation fix (--setting-sources project + HERDR_ENV unset, baked into
# each drive.exp). Runs A-002 then A-003 sequentially with a hard per-run
# wall-clock cap so nothing can hang. Exact-PID teardown only - NEVER pkill.
set -u
cd "$(dirname "$0")"
LOG=run-interactive-spikes.log
: > "$LOG"

cap_run() {  # cap_run <seconds> <dir>
  local secs=$1 dir=$2
  print -r -- "=== $(date +%H:%M:%S) START $dir (cap ${secs}s) ===" >> "$LOG"
  ( cd "$dir" && zsh run.sh ) >> "$LOG" 2>&1 &
  local pid=$!
  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep 3; waited=$((waited+3))
    if (( waited >= secs )); then
      print -r -- "=== $(date +%H:%M:%S) CAP HIT for $dir, TERM pid $pid (exact) ===" >> "$LOG"
      kill -TERM "$pid" 2>/dev/null
      sleep 3; kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null
      break
    fi
  done
  wait "$pid" 2>/dev/null
  print -r -- "=== $(date +%H:%M:%S) END $dir ===" >> "$LOG"
}

cap_run 360 a002-hooks
cap_run 300 a003-bare
print -r -- "ALL DONE $(date +%H:%M:%S)" >> "$LOG"

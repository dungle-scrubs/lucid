#!/bin/zsh
set -u
cd "$(dirname "$0")"
chmod +x watch.sh drive.exp
rm -f pty.log queue.txt driver-events.log processes.log runner.log
rm -rf work .claude transcript-observation
mkdir -p work transcript-observation
print -r -- "Reply with exactly: COOP-DELIVERED" > queue.txt
find "$HOME/.claude/projects/-Users-kevin-dev-lucid-v2-spikes-a003-bare" -maxdepth 1 -type f -name '*.jsonl' -print 2>/dev/null > transcript-observation/transcripts-before.txt
print -r -- "RUN started_at=$(perl -MTime::HiRes=time -e 'printf "%.6f", time')" >> processes.log

zsh watch.sh transcript-observation &
watcher_pid=$!
print -r -- "SPAWN watcher pid=$watcher_pid purpose=read-only-transcript-observer" >> processes.log

expect drive.exp
status=$?
print -r -- "STOP watcher pid=$watcher_pid method=TERM reason=experiment-complete" >> processes.log
kill -TERM "$watcher_pid" 2>/dev/null || true
wait "$watcher_pid"; watcher_status=$?
print -r -- "EXIT watcher pid=$watcher_pid status=$watcher_status" >> processes.log
print -r -- "EXIT runner status=$status" >> processes.log
print -r -- "=== status === $status"
print -r -- "=== pty markers ==="; grep -a 'MARK:' pty.log || true
print -r -- "=== work dir ==="; find work -maxdepth 1 -type f -print | sort
print -r -- "=== transcript path ==="; sed -n '1p' transcript-observation/transcript-path.txt
print -r -- "=== arrivals ==="; sed -n '1,20p' transcript-observation/arrivals.ndjson
exit "$status"

#!/bin/zsh
# Bounded A-002 coordinator. Background helper PIDs are captured immediately.
set -u
cd "$(dirname "$0")"
chmod +x .claude/hooks/*.sh drive.exp
rm -f announce.log hooks-fired.log delivery.log queue.txt pty.log driver-events.log processes.log runner.log
rm -rf work
mkdir -p work
touch queue.txt
print -r -- "RUN started_at=$(perl -MTime::HiRes=time -e 'printf "%.6f", time')" >> processes.log

( while ! grep -q '"hook":"PostToolUse"' hooks-fired.log 2>/dev/null; do sleep 0.2; done
  print -r -- "Also create work/four.txt containing exactly extra. Then say exactly: FEEDBACK-ONE-APPLIED." > queue.txt
  print -r -- "QUEUE_ONE_WRITTEN $(perl -MTime::HiRes=time -e 'printf "%.6f", time')" >> driver-events.log
) &
dropper_one=$!
print -r -- "SPAWN dropper_one pid=$dropper_one purpose=queue-after-first-posttool" >> processes.log

( while ! grep -q 'TURN2_SUBMITTED' driver-events.log 2>/dev/null; do sleep 0.2; done
  sleep 1
  print -r -- "After the poem, say exactly: FEEDBACK-TWO-APPLIED." > queue.txt
  print -r -- "QUEUE_TWO_WRITTEN $(perl -MTime::HiRes=time -e 'printf "%.6f", time')" >> driver-events.log
) &
dropper_two=$!
print -r -- "SPAWN dropper_two pid=$dropper_two purpose=queue-for-stop-hook" >> processes.log

expect drive.exp
status=$?
wait "$dropper_one"; one_status=$?
wait "$dropper_two"; two_status=$?
print -r -- "EXIT dropper_one pid=$dropper_one status=$one_status" >> processes.log
print -r -- "EXIT dropper_two pid=$dropper_two status=$two_status" >> processes.log
print -r -- "EXIT runner status=$status" >> processes.log
print -r -- "=== status === $status"
print -r -- "=== announce.log ==="; [[ -f announce.log ]] && sed -n '1,20p' announce.log
print -r -- "=== delivery.log ==="; [[ -f delivery.log ]] && sed -n '1,20p' delivery.log
print -r -- "=== hook counts ==="; [[ -f hooks-fired.log ]] && jq -r .hook hooks-fired.log | sort | uniq -c
print -r -- "=== work dir ==="; find work -maxdepth 1 -type f -print | sort
print -r -- "=== driver events ==="; sed -n '1,80p' driver-events.log
exit "$status"

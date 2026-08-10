#!/bin/zsh
# A-005 part 2: what happens when you `--resume` a session that is LIVE
# (process alive, holding the session open)? Rule under test: never appends
# to the live conversation - refuses or forks.
set -u
cd "$(dirname "$0")"
LIVE=$(uuidgen | tr 'A-Z' 'a-z')
STORE=~/.claude/projects/-Users-kevin-dev-lucid-v2-spikes/$LIVE.jsonl
echo "live session id: $LIVE"

rm -f live.in; mkfifo live.in
# Hold the session's stdin open: first turn now, then keep the pipe alive.
( printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Reply with exactly: live ready"}]}}'; sleep 120 ) > live.in &
FEEDER=$!
claude -p --session-id "$LIVE" --input-format stream-json --output-format stream-json --verbose --model sonnet < live.in > live.out 2> live.err &
CPID=$!

# Wait for turn 1 to complete (result event lands in live.out).
for i in $(seq 1 60); do grep -q '"type":"result"' live.out 2>/dev/null && break; sleep 1; done
grep -q '"type":"result"' live.out || { echo "FAIL: live session never completed turn 1"; kill $CPID $FEEDER 2>/dev/null; exit 1; }
BEFORE=$(wc -l < "$STORE" | tr -d ' ')
echo "live turn 1 done; process alive: $(ps -p $CPID > /dev/null && echo yes); store lines: $BEFORE"

# The interference attempt: resume the live id from a second process.
echo "--- resume attempt against live session:"
RES=$(claude -p --resume "$LIVE" --model sonnet --output-format json "Reply with exactly: intruder" 2>&1)
echo "$RES" | jq -c '{session_id, result, is_error}' 2>/dev/null || echo "non-json: $RES"

sleep 2
AFTER=$(wc -l < "$STORE" | tr -d ' ')
echo "store lines before=$BEFORE after=$AFTER (delta $((AFTER-BEFORE)))"
echo "live process still alive: $(ps -p $CPID > /dev/null && echo yes || echo no)"
echo "intruder turn visible in live transcript: $(grep -c intruder "$STORE" 2>/dev/null || echo 0)"
ls ~/.claude/projects/-Users-kevin-dev-lucid-v2-spikes/*.jsonl | tail -3

kill $FEEDER 2>/dev/null; wait $CPID 2>/dev/null
echo "done"

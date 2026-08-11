#!/bin/zsh
# Stop: turn-end delivery fallback. Logs the fire; delivers queue if present.
IN=$(cat)
Q="$CLAUDE_PROJECT_DIR/queue.txt"
echo "$IN" | jq -c '{at: now, hook: "Stop"}' >> "$CLAUDE_PROJECT_DIR/hooks-fired.log"
if [ -s "$Q" ]; then
  msg=$(cat "$Q"); : > "$Q"
  echo "{\"at\": $(date +%s), \"delivered_by\": \"Stop\"}" >> "$CLAUDE_PROJECT_DIR/delivery.log"
  jq -n --arg r "HUMAN FEEDBACK (turn end): $msg" '{decision: "block", reason: $r}'
fi
exit 0

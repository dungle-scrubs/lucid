#!/bin/zsh
# lucid's PostToolUse block (hook #1 under PostToolUse). Boundary injection:
# if the queue holds a human message, deliver it as blocking feedback.
IN=$(cat)
Q="$CLAUDE_PROJECT_DIR/queue.txt"
echo "$IN" | jq -c '{at: now, hook: "PostToolUse", by: "lucid-inject", tool: .tool_name}' >> "$CLAUDE_PROJECT_DIR/hooks-fired.log"
if [ -s "$Q" ]; then
  msg=$(cat "$Q"); : > "$Q"
  echo "{\"at\": $(date +%s), \"delivered_by\": \"PostToolUse\", \"by\": \"lucid-inject\"}" >> "$CLAUDE_PROJECT_DIR/delivery.log"
  jq -n --arg r "HUMAN FEEDBACK (mid-turn): $msg" '{decision: "block", reason: $r}'
fi
exit 0

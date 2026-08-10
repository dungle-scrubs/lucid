#!/bin/zsh
# PostToolUse hook: the boundary-injection point. If the queue holds a human
# message, deliver it as feedback the model must act on, and clear the queue.
IN=$(cat)
Q="$CLAUDE_PROJECT_DIR/queue.txt"
echo "$IN" | jq -c '{at: now, hook: "PostToolUse", tool: .tool_name}' >> "$CLAUDE_PROJECT_DIR/hooks-fired.log"
if [ -s "$Q" ]; then
  msg=$(cat "$Q"); : > "$Q"
  echo "{\"at\": $(date +%s), \"delivered_by\": \"PostToolUse\"}" >> "$CLAUDE_PROJECT_DIR/delivery.log"
  jq -n --arg r "HUMAN FEEDBACK (mid-turn): $msg" '{decision: "block", reason: $r}'
fi
exit 0

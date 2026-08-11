#!/bin/zsh
# SessionStart: attach signal. Records identity + transcript path for tailing.
IN=$(cat)
echo "$IN" | jq -c '{at: now, hook: "SessionStart", session_id, transcript_path, source}' >> "$CLAUDE_PROJECT_DIR/announce.log"
exit 0

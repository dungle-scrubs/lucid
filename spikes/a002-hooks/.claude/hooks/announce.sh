#!/bin/zsh
# SessionStart hook: the adapter's attach signal. Records identity + transcript
# path so an external process can begin tailing without any agent cooperation.
IN=$(cat)
echo "$IN" | jq -c '{at: now, hook: "SessionStart", session_id, transcript_path, source}' >> "$CLAUDE_PROJECT_DIR/announce.log"
exit 0

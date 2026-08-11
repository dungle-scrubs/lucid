#!/bin/zsh
# A PRE-EXISTING project PostToolUse block (hook #2, NOT lucid's). Benign:
# it only writes a co-run marker. If this fires on the same event as
# lucid-inject.sh, --setting-sources project co-runs all project hooks
# (contract 2: lucid does NOT get exclusivity).
IN=$(cat)
echo "$IN" | jq -c '{at: now, hook: "PostToolUse", by: "other-project", tool: .tool_name}' >> "$CLAUDE_PROJECT_DIR/co-run.log"
exit 0

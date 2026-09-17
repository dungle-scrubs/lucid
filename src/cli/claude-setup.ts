import type { HookSetupResult } from "./hook-setup.js";
import { setupLucidHooks } from "./hook-setup.js";

/** Claude Code settings hooks: lifecycle identity, listening and parent-verified command commits. */
export function setupClaudeHooks(root: string, settingsFile: string): HookSetupResult {
  return setupLucidHooks(root, settingsFile, {
    entry: "_claude-hook",
    events: [
      {
        event: "SessionStart",
        statusMessage: "Preparing this session for Lucid feedback",
        timeout: 60,
      },
      { event: "UserPromptSubmit", timeout: 10 },
      {
        event: "Stop",
        statusMessage: "Listening for Lucid feedback (up to 45 seconds)",
        timeout: 60,
      },
      { event: "PostToolUse", matcher: "Bash", timeout: 30 },
    ],
    installedMessage:
      "Lucid hooks are configured in this Claude Code settings file. Accept workspace trust for the project folder, then start a new Claude Code session or run /clear so SessionStart can register it. Setup alone does not mean Lucid is listening.",
  });
}

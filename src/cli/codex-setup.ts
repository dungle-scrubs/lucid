import type { HookSetupResult } from "./hook-setup.js";
import { setupLucidHooks } from "./hook-setup.js";

/** Configuration installation does not establish native trust, registration or listening. */
export function setupCodexHooks(root: string, hooksFile: string): HookSetupResult {
  return setupLucidHooks(root, hooksFile, {
    entry: "_codex-hook",
    events: [
      {
        event: "SessionStart",
        statusMessage: "Preparing this session for Lucid feedback",
        timeout: 60,
      },
      {
        event: "Stop",
        statusMessage: "Listening for Lucid feedback (up to 45 seconds)",
        timeout: 60,
      },
      { event: "Interrupt", statusMessage: "Stopping Lucid feedback listening", timeout: 3 },
    ],
    installedMessage:
      "Lucid hooks are configured. Review and trust them in Codex /hooks, then start or resume the intended session so SessionStart can register it. Setup alone does not mean Lucid is listening.",
  });
}

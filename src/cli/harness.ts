/**
 * Harness resolution — the single seam that owns `name → HarnessDescriptor`.
 *
 * Before, `src/cli/runtime.ts` hardcoded `claudeCode` and the matrix
 * (`harness × mode`) could only be tested via fake injection — production
 * could not switch harness without a code change (one adapter = hypothetical).
 * Now the runtime takes a `HarnessDescriptor` and this module is the one
 * place that interprets a CLI flag, an env var, or a bare name into that
 * descriptor. The CLI mapping parses the flag, the runtime consumes the
 * descriptor, and the headless modes receive it.
 *
 * What it is NOT: it does not know the flock, the store, or the presence.
 */

import { claudeCode } from "@dungle-scrubs/harness-cli/src/knowledge/claude-code.js";
import { codexCli } from "@dungle-scrubs/harness-cli/src/knowledge/codex.js";
import type { HarnessDescriptor } from "@dungle-scrubs/harness-cli/src/knowledge/descriptor.js";
import { museCode } from "@dungle-scrubs/harness-cli/src/knowledge/muse.js";
import { piCli } from "@dungle-scrubs/harness-cli/src/knowledge/pi.js";

const BY_NAME: Record<string, HarnessDescriptor> = {
  claude: claudeCode,
  "claude-code": claudeCode,
  codex: codexCli,
  "codex-cli": codexCli,
  pi: piCli,
  "pi-coding-agent": piCli,
  muse: museCode,
  opencode: museCode,
  "opencode-ai": museCode,
};

/** Resolve a harness name (CLI flag, env, or bare name) to its descriptor. */
export const harnessForName = (name?: string): HarnessDescriptor => {
  const raw = name ?? process.env.LUCID_HARNESS;
  if (!raw || raw.trim() === "") return claudeCode;
  const key = raw.trim().toLowerCase();
  const found = BY_NAME[key];
  if (!found)
    throw new Error(`unknown harness "${raw}" (known: ${Object.keys(BY_NAME).join(", ")})`);
  return found;
};

export const harnessNames = (): readonly string[] => Object.keys(BY_NAME);

/** Whether this harness supports a persistent headless session (mode 2). */
export const supportsSession = (harness: HarnessDescriptor): boolean =>
  harness.sessionMode !== null && harness.capabilities.session === true;

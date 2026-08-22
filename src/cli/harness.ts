/**
 * Harness resolution — the single seam that owns `name -> HarnessName`, and
 * the one question lucid asks about a harness before choosing a profile.
 *
 * lucid used to import the normalizer's four descriptors and read
 * `sessionMode` off them. Those are internals of a package whose only
 * supported surface is its CLI, so lucid now validates a name and asks `hcn`
 * the capability question at runtime.
 *
 * What it is NOT: it does not know the flock, the store, or the presence.
 */
import type { HarnessName, HarnessRunner } from "../harness/runner.js";

const BY_NAME: Record<string, HarnessName> = {
  claude: "claude",
  "claude-code": "claude",
  codex: "codex",
  "codex-cli": "codex",
  pi: "pi",
  "pi-coding-agent": "pi",
  muse: "muse",
  opencode: "muse",
  "opencode-ai": "muse",
};

/** Resolve a harness name (CLI flag, env, or bare name) to hcn's name. */
export const harnessForName = (name?: string): HarnessName => {
  const raw = name ?? process.env.LUCID_HARNESS;
  if (!raw || raw.trim() === "") return "claude";
  const key = raw.trim().toLowerCase();
  const found = BY_NAME[key];
  if (!found)
    throw new Error(`unknown harness "${raw}" (known: ${Object.keys(BY_NAME).join(", ")})`);
  return found;
};

export const harnessNames = (): readonly string[] => Object.keys(BY_NAME);

/** Whether this harness supports a persistent headless session (mode 2).
 * Answered by hcn from the descriptor, so a harness that grows a session
 * mode is usable the day its descriptor declares one - no lucid release. */
export const supportsSession = async (
  runner: HarnessRunner,
  harness: HarnessName,
): Promise<boolean> => (await runner.inspect(harness)).session;

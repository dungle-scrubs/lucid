// An artifact somewhere the OS will NOT delete, and a way to watch what
// `open` would have launched.
//
// One module per capability, with its signatures final (D-014). The fan-out
// milestones add tests, never harness: an agent that needs to change something
// here has been scoped wrong, and the split is what makes that visible rather
// than a merge conflict nobody reads.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

/**
 * A run root OUTSIDE both the temp tree and `defaultRoots()`.
 *
 * Outside temp, because these scenarios are about the refusal that fires for
 * volatile paths - a fixture under `/tmp` would be refused before the thing
 * under test happened, and `LUCID_ALLOW_TEMP=1` (which the rest of the suite
 * relies on) would mask exactly the behaviour being measured.
 *
 * Outside `defaultRoots()` - which is `~/dev` plus the agent scratchpad
 * buckets - because a fixture inside them would appear in the developer's own
 * hub listing, and a suite that plants sessions in a human's real workspace is
 * a suite that gets turned off.
 *
 * `~/.lucid-e2e/<run-id>/` satisfies both, and `globalTeardown` already sweeps
 * roots there older than the run (gate.ts `sweepStaleRoots`), so nothing
 * survives a SIGKILLed test forever.
 */
export const DURABLE_ROOT = join(homedir(), ".lucid-e2e");

export interface DurableFixture {
  /** The directory holding the artifact. Removed by `cleanup()`. */
  readonly dir: string;
  /** Absolute path to the artifact - durable, so `open` will not refuse it. */
  readonly artifact: string;
  cleanup(): Promise<void>;
}

/** Write an artifact under a fresh durable directory. */
export const makeDurableArtifact = async (html: string): Promise<DurableFixture> => {
  await mkdir(DURABLE_ROOT, { recursive: true });
  const dir = await mkdtemp(join(DURABLE_ROOT, "run-"));
  const artifact = join(dir, "plan.html");
  await writeFile(artifact, html, "utf8");
  return {
    dir,
    artifact,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
};

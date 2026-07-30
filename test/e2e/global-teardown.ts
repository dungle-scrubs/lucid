import { join } from "node:path";
import { killSurvivors, releaseExclusiveRun } from "./gate.ts";

const REPO = join(import.meta.dirname, "..", "..");

/**
 * Kill anything the suite started and did not stop.
 *
 * A safety net, not the mechanism: a leaked server is a bug in whichever
 * fixture owned it, and M3.1's `use()` teardown is what should make this find
 * nothing. It reports every kill for that reason - a sweep that tidies up in
 * silence turns a leak into a thing nobody ever sees, and the leaks that matter
 * appear on the failure paths that only show up under parallel load.
 */
const globalTeardown = async (): Promise<void> => {
  await killSurvivors(join(REPO, "src", "cli", "main.ts"), (message) =>
    console.warn(`[e2e teardown] ${message}`),
  );
  // Last: the sweep above is exactly why only one run may be live, so the
  // claim is held until after it.
  releaseExclusiveRun();
};

export default globalTeardown;

import { realpathSync } from "node:fs";
import { readProcessOwner } from "../process-owner.js";
import type { ProcessOwner } from "../protocol/process-owner.js";
import { createHcnRunner } from "./hcn-runner.js";
import { nodeHarnessDeps } from "./node-deps.js";
import type { HarnessName } from "./runner.js";

/** Corroborate a hook's native ancestor using the executable named by hcn. */
export async function nativeOwner(harness: HarnessName): Promise<ProcessOwner | undefined> {
  try {
    const facts = await createHcnRunner(nodeHarnessDeps()).inspect(harness, {
      runtime: { cwd: process.cwd(), profile: "headless-turn" },
    });
    const executable = facts.runtime?.executable.path;
    if (!executable) return undefined;
    let pid = process.ppid;
    const visited = new Set<number>();
    while (pid > 1 && visited.size < 32 && !visited.has(pid)) {
      visited.add(pid);
      const owner = readProcessOwner(pid);
      if (!owner) return undefined;
      if (realpathSync(owner.executable) === realpathSync(executable)) return owner;
      pid = owner.parentPid;
    }
  } catch {
    /* Unknown ownership never becomes permission to take over. */
  }
  return undefined;
}

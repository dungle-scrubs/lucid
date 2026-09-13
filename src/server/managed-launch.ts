import { statSync } from "node:fs";
import { ownerPresence, terminalPresence } from "../process-owner.js";
import { nativeOwners } from "../protocol/connection.js";
import { viewConversation } from "../store/conversation-host.js";
import type { Discovery } from "../store/discovery.js";
import { pathsForDir } from "../store/errors.js";
import { workerCandidates } from "../store/managed-readiness.js";
import { presenceHeld } from "../store/presence.js";

export interface ManagedLaunch {
  readonly request: (root: string, conversationId: string, inputId: string) => void;
}

/** Reconciliation requests processes; only a worker may acquire execution authority. */
export function createManagedLaunchReconciler(
  root: string,
  launch: ManagedLaunch,
): (discovery: Discovery) => void {
  const states = new Map<
    string,
    { readonly fingerprint: string; readonly snapshot: ReturnType<typeof viewConversation> }
  >();
  return (discovery) => {
    const present = new Set(discovery.records.map((record) => record.dir));
    for (const dir of states.keys()) if (!present.has(dir)) states.delete(dir);
    for (const record of discovery.records) {
      try {
        if (
          discovery.identities.get(record.conversationId) !== record.dir ||
          presenceHeld(record.dir) !== false
        )
          continue;
        const info = statSync(pathsForDir(record.dir).logPath);
        const fingerprint = [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":");
        const cached = states.get(record.dir);
        const snapshot =
          cached?.fingerprint === fingerprint ? cached.snapshot : viewConversation(record.dir);
        states.set(record.dir, { fingerprint, snapshot });
        const state = snapshot.state;
        const owners = nativeOwners(state);
        if (
          owners.length > 0 &&
          terminalPresence(owners, (owner) => (owner ? ownerPresence(owner) : undefined)) !== false
        )
          continue;
        const inputId = workerCandidates(record.dir, state, snapshot.artifactHeads)[0];
        if (inputId !== undefined) launch.request(root, record.conversationId, inputId);
      } catch {
        states.delete(record.dir);
        // A damaged record must not prevent another record's work from starting.
      }
    }
  };
}

import { appliedRecovery } from "../protocol/execution.js";
import { HubError } from "../protocol/hub-errors.js";
import { viewConversation } from "../store/conversation-host.js";
import { LockError } from "../store/flock.js";
import { managedCandidates } from "../store/managed-readiness.js";
import { requestBackgroundWorker } from "./background-worker.js";
import { conversations } from "./record-addressing.js";
import type { RuntimeDeps } from "./runtime.js";
import { openDrivenConversation } from "./runtime.js";

export { workerEnvironment as managedWorkerEnvironment } from "./background-worker.js";

export function requestManagedWorker(root: string, conversationId: string, inputId: string): void {
  requestBackgroundWorker(["_managed-worker", root, conversationId, inputId], root);
}

export interface ManagedWorkerDeps extends RuntimeDeps {
  readonly idleMs?: number;
  readonly tickMs?: number;
}

export async function runManagedWorker(
  root: string,
  conversationId: string,
  inputId: string,
  deps: ManagedWorkerDeps = {},
): Promise<void> {
  const dir = conversations(root).dirFor(conversationId);
  const initial = viewConversation(dir);
  if (!managedCandidates(dir, initial.state, initial.artifactHeads).includes(inputId)) return;
  let running: Awaited<ReturnType<typeof openDrivenConversation>>;
  try {
    running = await openDrivenConversation({
      ...deps,
      rootDir: root,
      conversationId,
      managed: true,
    });
  } catch (cause) {
    if (
      cause instanceof LockError &&
      (cause.code === "lock-unavailable" || cause.code === "lock-timeout")
    )
      return;
    if (cause instanceof HubError) return;
    throw cause;
  }
  if (running.kind !== "running") return;
  const now = deps.now ?? Date.now;
  let idleSince = now();
  let stopped = false;
  void running.done.then(
    () => {
      stopped = true;
    },
    () => {
      stopped = true;
    },
  );
  try {
    while (!stopped) {
      const state = running.host.state();
      const busy = running.source.busy?.() === true;
      if (
        !busy &&
        managedCandidates(dir, state, running.host.artifactHeads()).some((id) => {
          const entry = state.executions[id];
          return entry?.kind === "held" || appliedRecovery(state, id);
        })
      )
        break;
      if (busy) idleSince = now();
      else if (now() - idleSince >= (deps.idleMs ?? 3000)) break;
      await Bun.sleep(deps.tickMs ?? 100);
    }
  } finally {
    running.abort();
    await running.done;
  }
}

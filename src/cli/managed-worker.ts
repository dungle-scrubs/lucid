import { classOfEventKind } from "../protocol/events.js";
import { appliedRecovery } from "../protocol/execution.js";
import { HubError } from "../protocol/hub-errors.js";
import { viewConversation } from "../store/conversation-host.js";
import { LockError } from "../store/flock.js";
import { workerCandidates } from "../store/managed-readiness.js";
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
  /** Review-hold length. Defaults to the configured hold or 30 minutes. */
  readonly holdMs?: number;
  /** Detach intent observed by the caller. When true, the hold ends at the turn boundary. */
  readonly detachRequested?: () => boolean;
  /** Abort grace after detach intent with an active turn. Defaults to 30 seconds. */
  readonly detachGraceMs?: number;
}

/** Durable activity: accepted inputs plus lossless events. Heartbeats, acks,
 * and detach frames never enter the transcript, so they cannot extend the hold. */
export function holdActivity(
  transcript: Pick<import("../store/log.js").Transcript, "events" | "inputs">,
): number {
  const live = transcript.inputs.filter((input) => input.status !== "cancelled").length;
  const lossless = transcript.events.filter(
    (row) => classOfEventKind((row.event as { kind?: unknown }).kind) === "lossless",
  ).length;
  return live + lossless;
}

export async function runManagedWorker(
  root: string,
  conversationId: string,
  inputId: string,
  deps: ManagedWorkerDeps = {},
): Promise<void> {
  const dir = conversations(root).dirFor(conversationId);
  const initial = viewConversation(dir);
  if (!workerCandidates(dir, initial.state, initial.artifactHeads).includes(inputId)) return;
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
  // Hold mode (explicit holdMs) tracks durable log appends, not busy-state:
  // preparation counting as busy inside the source must not extend a review
  // hold. The legacy idleMs path keeps busy-reset semantics unchanged.
  const holdMode = deps.holdMs !== undefined;
  const holdMs = deps.holdMs ?? deps.idleMs ?? 3000;
  const graceMs = deps.detachGraceMs ?? 30_000;
  let idleSince = now();
  let activity = holdActivity(running.host.snapshot().transcript);
  let detachSince: number | undefined;
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
        workerCandidates(dir, state, running.host.artifactHeads()).some((id) => {
          const entry = state.executions[id];
          return entry?.kind === "held" || appliedRecovery(state, id);
        })
      )
        break;
      const seen = holdActivity(running.host.snapshot().transcript);
      if (seen !== activity) {
        activity = seen;
        idleSince = now();
      }
      // Durable detach intent outranks the local flag: a `lucid detach`
      // in another process lands here through the log.
      const released = running.host.state().holdRelease !== null;
      if ((released || deps.detachRequested?.() === true) && detachSince === undefined)
        detachSince = now();
      if (detachSince !== undefined) {
        // Explicit detach: new work stops at once; the source leaves at the
        // turn boundary, or by abort past the grace bound (shutdown, not yield).
        if (!busy) break;
        if (now() - detachSince >= graceMs) {
          running.abort();
          break;
        }
      } else if (holdMode) {
        if (!busy && now() - idleSince >= holdMs) break;
      } else if (busy) idleSince = now();
      else if (now() - idleSince >= holdMs) break;
      await Bun.sleep(deps.tickMs ?? 100);
    }
  } finally {
    running.abort();
    await running.done;
  }
}

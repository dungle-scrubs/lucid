import { createHcnRunner } from "../harness/hcn-runner.js";
import { nodeHarnessDeps } from "../harness/node-deps.js";
import type { HarnessRunner } from "../harness/runner.js";
import type { NativeReconnectRunResult } from "../modes/native-reconnect.js";
import { runNativeReconnect } from "../modes/native-reconnect.js";
import { ownerPresence, readProcessOwner } from "../process-owner.js";
import { currentReconnect } from "../protocol/connection.js";
import { sameProcessOwner } from "../protocol/process-owner.js";
import { observeConnection } from "../store/connection-view.js";
import { createConversationHost, viewConversation } from "../store/conversation-host.js";
import { presenceHeld } from "../store/presence.js";
import { followRecord } from "../store/tailer.js";
import { listeningCommand } from "./invocation.js";
import type { Conversations } from "./record-addressing.js";
import { commandRecordDir } from "./record-addressing.js";

export interface ReconnectDeps {
  readonly follow?: typeof followRecord;
  readonly ownerPresence?: typeof ownerPresence;
  readonly runner?: HarnessRunner;
  readonly terminal?: boolean;
}

interface ReconnectOptions {
  readonly onProgress: (message: string) => void;
  readonly signal: AbortSignal;
}

export type ReconnectResult =
  | { readonly kind: "pending"; readonly message: string; readonly requestId: string }
  | { readonly kind: "cancelled"; readonly message: string }
  | NativeReconnectRunResult
  | {
      readonly kind: "held";
      readonly message: string;
      readonly reason: string;
    };

/** The terminal command owns the request; the native source owns its one process. */
export async function reconnectConversation(
  records: Conversations,
  conversationId: string,
  options: ReconnectOptions,
  deps: ReconnectDeps = {},
): Promise<ReconnectResult> {
  const { signal } = options;
  if (signal.aborted)
    return {
      kind: "cancelled",
      message: "Reconnect cancelled before reservation. Feedback is unchanged.",
    };
  if (!(deps.terminal ?? (process.stdin.isTTY && process.stdout.isTTY)))
    return {
      kind: "held",
      reason: "terminal-required",
      message:
        "Run reconnect in a terminal pane. It opens the saved native session there; connection status --json remains available without a terminal.",
    };
  const recordDir = commandRecordDir(records, conversationId);
  const probe = deps.ownerPresence ?? ownerPresence;
  const host = createConversationHost(recordDir, {
    executorLease: () => false,
    nativeSessionRoot: records.rootDir,
    now: Date.now,
    onEffect: () => {},
    onRecord: () => {},
    ownerPresence: probe,
    presence: () => undefined,
  });
  try {
    const requester = readProcessOwner(process.pid) ?? undefined;
    const existing = currentReconnect(host.state().connection);
    if (existing) {
      const sameRequester = sameProcessOwner(requester, existing.request.requester);
      const reconciled =
        existing.kind === "requested" && !sameRequester
          ? host.reconcileReconnect(existing.request.id)
          : undefined;
      if (reconciled?.verdict !== "accepted")
        return {
          kind: "pending",
          requestId: existing.request.id,
          message: `Reconnect request ${existing.request.id} already exists. It has not been launched again. Use connection status to inspect its progress or held result.`,
        };
    }
    const requested = host.controlReconnect({ kind: "request" });
    if (requested.verdict === "refused") {
      const status = observeConnection(requested.state, {
        executorPresent: presenceHeld(recordDir),
        now: Date.now(),
        ownerPresence: probe,
      });
      const instruction =
        requested.state.connection?.binding.interface === "codex-cli" &&
        status.state === "not-listening"
          ? ` In that native session, run: ${listeningCommand(records.rootDir, conversationId)}`
          : "";
      return {
        kind: "held",
        reason: requested.issue,
        message:
          status.state === "not-listening" ||
          status.state === "listening" ||
          status.state === "owner-unknown"
            ? `${status.message}${instruction}`
            : "Reconnect is held. Check the connection status before retrying; saved feedback is unchanged.",
      };
    }
    const requestId = requested.state.connection?.reconnectId;
    if (!requestId)
      return {
        kind: "held",
        reason: "connection-not-admitted",
        message: "No reconnect request was admitted.",
      };
    const request = requested.state.connection?.reconnects[requestId];
    if (!request || !sameProcessOwner(requester, request.request.requester))
      return {
        kind: "pending",
        requestId,
        message: `Another terminal reserved reconnect request ${requestId}. No second native session was started.`,
      };
    const runner = deps.runner ?? createHcnRunner(nodeHarnessDeps());
    const stopFollowing = new AbortController();
    const completion = Promise.withResolvers<ReconnectResult>();
    let active = false;
    let finished = false;
    let waitingReported = false;
    const finish = (result: ReconnectResult): void => {
      if (finished) return;
      finished = true;
      stopFollowing.abort();
      completion.resolve(result);
    };
    const advance = async (): Promise<void> => {
      if (active || finished) return;
      active = true;
      try {
        if (signal.aborted) {
          const cancelled = host.controlReconnect({ kind: "cancel", requestId });
          finish(
            cancelled.verdict === "accepted"
              ? {
                  kind: "cancelled",
                  message:
                    "Reconnect wait cancelled. Saved feedback and the current response are unchanged.",
                }
              : {
                  kind: "held",
                  reason: cancelled.issue,
                  message:
                    "Reconnect could not be cancelled. Check connection status for launch and cleanup evidence.",
                },
          );
          return;
        }
        const result = await runNativeReconnect(
          { recordDir, requestId, root: records.rootDir, signal },
          runner,
          { ownerPresence: probe },
        );
        if (
          result.kind === "held" &&
          (result.reason === "execution-blocked" || result.reason === "record-busy")
        ) {
          // A snapshot schedules another check only. The source repeats locked admission.
          const pending = currentReconnect(viewConversation(recordDir).state.connection);
          if (pending?.kind === "requested" && pending.request.id === requestId) {
            if (!waitingReported) {
              waitingReported = true;
              options.onProgress(
                "Waiting for the current response, delivery evidence and process cleanup. Ctrl+C cancels this wait before launch; saved feedback and current work remain intact.",
              );
            }
            return;
          }
        }
        finish(
          result.kind === "completed" && result.result.kind !== "closed"
            ? {
                kind: "held",
                reason: result.result.reason,
                message:
                  result.result.kind === "refused"
                    ? `Reconnect did not start a native session (${result.result.reason}). The request and saved feedback remain held.`
                    : `Reconnect creation or cleanup could not be verified (${result.result.reason}). The request and feedback remain held; it will not be retried automatically.`,
              }
            : result,
        );
      } catch {
        finish({
          kind: "held",
          reason: "reconnect-failed",
          message:
            "Reconnect is held because its state could not be verified. Check connection status before retrying.",
        });
      } finally {
        active = false;
        if (signal.aborted && !finished) queueMicrotask(() => void advance());
      }
    };
    const wake = (): void => {
      void advance();
    };
    signal.addEventListener("abort", wake, { once: true });
    const following = (deps.follow ?? followRecord)({
      dir: recordDir,
      signal: stopFollowing.signal,
      onTrigger: wake,
    });
    void following.catch(() =>
      finish({
        kind: "held",
        reason: "reconnect-failed",
        message: "Reconnect could not follow the record. Its request and feedback remain saved.",
      }),
    );
    try {
      return await completion.promise;
    } finally {
      signal.removeEventListener("abort", wake);
      stopFollowing.abort();
      await following.catch(() => {});
    }
  } finally {
    host.close();
  }
}

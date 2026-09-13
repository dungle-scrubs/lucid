import { listeningCommand } from "../cli/invocation.js";
import type { HarnessRunner, InteractiveHandle, InteractiveResult } from "../harness/runner.js";
import { HarnessRefusal } from "../harness/runner.js";
import { ownerPresence } from "../process-owner.js";
import { currentReconnect } from "../protocol/connection.js";
import type { ProtocolIssue } from "../protocol/frames.js";
import type { ConversationHost, HostDeps } from "../store/conversation-host.js";
import { createConversationHost } from "../store/conversation-host.js";
import type { StoreFailureCode } from "../store/errors.js";
import { classifyStoreFailure } from "../store/errors.js";
import type { PresenceHandle } from "../store/presence.js";
import { acquirePresence } from "../store/presence.js";

interface NativeReconnectOptions {
  readonly recordDir: string;
  readonly requestId: string;
  readonly root: string;
  readonly signal: AbortSignal;
}

export type NativeReconnectRunResult =
  | { readonly kind: "completed"; readonly launchId: string; readonly result: InteractiveResult }
  | {
      readonly kind: "held";
      readonly message: string;
      readonly reason:
        | ProtocolIssue
        | StoreFailureCode
        | "operation-unavailable"
        | "reconnect-failed";
    };

/** One admitted terminal launch. The outer command owns waiting and request selection. */
export async function runNativeReconnect(
  options: NativeReconnectOptions,
  runner: HarnessRunner,
  overrides: Partial<Pick<HostDeps, "now" | "onRecord" | "ownerPresence">> = {},
): Promise<NativeReconnectRunResult> {
  const held = (
    reason: Extract<NativeReconnectRunResult, { kind: "held" }>["reason"],
  ): NativeReconnectRunResult => ({
    kind: "held",
    message:
      "Reconnect could not complete. Saved feedback remains held; check the connection result before retrying.",
    reason,
  });
  if (!runner.openInteractive) return held("operation-unavailable");
  let host: ConversationHost | undefined;
  let lease: PresenceHandle | undefined;
  let handle: InteractiveHandle | undefined;
  let completed = false;
  try {
    host = createConversationHost(options.recordDir, {
      executorLease: () => lease?.held() ?? false,
      nativeSessionRoot: options.root,
      now: overrides.now ?? Date.now,
      onEffect: () => {},
      onRecord: overrides.onRecord ?? (() => {}),
      ownerPresence: overrides.ownerPresence ?? ownerPresence,
      presence: () => undefined,
    });
    const writer = host;
    const admission = writer.acquireExecutor(
      { kind: "reconnect", requestId: options.requestId },
      () => acquirePresence(options.recordDir, writer.conversationId, { timeoutMs: 0 }),
    );
    if (admission.verdict === "refused") return held(admission.issue);
    lease = admission.lease;
    const prepared = writer.prepareReconnect(options.requestId);
    if (prepared.verdict === "refused") return held(prepared.issue);
    const binding = prepared.state.connection?.binding;
    const request = currentReconnect(prepared.state.connection);
    if (!binding || request?.kind !== "intended") return held("connection-not-admitted");
    const launchId = request.launchId;
    handle = runner.openInteractive({
      cwd: binding.workingDirectory,
      dispatch: (invoke) => {
        const result = writer.dispatchReconnect(launchId, invoke);
        if (result.verdict === "refused")
          throw new HarnessRefusal(
            result.issue,
            "Reconnect admission changed before native invocation.",
          );
      },
      harness: binding.harness,
      interface: binding.interface,
      launchId,
      resume: binding.nativeSessionId,
      signal: options.signal,
      startupPrompt: [
        `Resume listening to Lucid conversation ${writer.conversationId}.`,
        "Run this command exactly once in this native session:",
        listeningCommand(options.root, writer.conversationId),
        "If the result is requested, finish this turn so the installed Stop hook can listen. If it is held, refused, or fails, report the result and stop. Do not retry or poll. Do not process saved feedback in this startup turn; feedback requires its own offer and receipt.",
      ].join("\n"),
    });
    for await (const control of handle.control) {
      if (control.kind !== "started") continue;
      // Only this normalized record from the owned transport supplies creation.
      // The host rechecks its target against the durable binding before writing.
      const recorded = writer.recordReconnectStarted(control);
      if (recorded.verdict === "refused") return held(recorded.issue);
      lease.release();
    }
    const result = await handle.settled;
    completed = true;
    const saved = writer.recordReconnectResult({ launchId, result });
    if (saved.verdict === "refused") return held(saved.issue);
    return { kind: "completed", launchId, result };
  } catch (cause) {
    return held(classifyStoreFailure(cause) ?? "reconnect-failed");
  } finally {
    try {
      if (handle && !completed) {
        handle.cancel();
        await handle.settled;
      }
    } finally {
      lease?.release();
      host?.close();
    }
  }
}

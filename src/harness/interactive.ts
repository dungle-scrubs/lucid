import { isInteractiveRefusalReason } from "../protocol/native-interactive.js";
import { parseProcessOwner } from "../protocol/process-owner.js";
import type { HarnessDeps, InteractiveHcnProcess } from "./process.js";
import { terminateHcn } from "./process.js";
import type {
  InteractiveControlRecord,
  InteractiveHandle,
  InteractiveResult,
  OpenInteractiveOptions,
} from "./runner.js";
import { HarnessRefusal } from "./runner.js";

const CONTROL_BYTES_MAX = 16_384;
const encoder = new TextEncoder();

class InvalidControl extends Error {}

async function* controlLines(chunks: AsyncIterable<string>): AsyncIterable<string> {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      if (encoder.encode(line).byteLength > CONTROL_BYTES_MAX) throw new InvalidControl();
      buffer = buffer.slice(newline + 1);
      if (line.trim()) yield line;
      newline = buffer.indexOf("\n");
    }
    if (encoder.encode(buffer).byteLength > CONTROL_BYTES_MAX) throw new InvalidControl();
  }
  if (buffer.length) throw new InvalidControl();
}

function parseControl(line: string, options: OpenInteractiveOptions): InteractiveControlRecord {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidControl();
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || record.operation !== "interactive" || record.launchId !== options.launchId)
    throw new InvalidControl();
  const base = { v: 1, operation: "interactive", launchId: options.launchId } as const;
  if (record.kind === "ready") return { ...base, kind: "ready" };
  if (
    record.kind === "refused" &&
    record.evidence === "spawn-not-attempted" &&
    isInteractiveRefusalReason(record.reason)
  )
    return { ...base, kind: "refused", evidence: record.evidence, reason: record.reason };
  if (
    record.kind === "closed" &&
    typeof record.cleanupComplete === "boolean" &&
    (record.exitCode === null ||
      (typeof record.exitCode === "number" &&
        Number.isSafeInteger(record.exitCode) &&
        record.exitCode >= 0))
  )
    return {
      ...base,
      kind: "closed",
      cleanupComplete: record.cleanupComplete,
      exitCode: record.exitCode,
    };
  if (
    record.kind === "started" &&
    record.sessionId === options.resume &&
    record.cwd === options.cwd &&
    record.interface === options.interface
  ) {
    const owner = parseProcessOwner(record.owner);
    if (owner?.executable.startsWith("/") && encoder.encode(owner.executable).byteLength <= 4096)
      return {
        ...base,
        kind: "started",
        sessionId: options.resume,
        cwd: options.cwd,
        interface: options.interface,
        owner,
      };
  }
  throw new InvalidControl();
}

function logLifecycle(deps: HarnessDeps, event: Record<string, unknown>): void {
  try {
    deps.log?.(event);
  } catch {
    // Diagnostics cannot interrupt owned process cleanup or replace control evidence.
  }
}

/** HCN owns native argv and supervision; this stream only interprets its caller control pipe. */
export function openInteractive(
  deps: HarnessDeps,
  options: OpenInteractiveOptions,
): InteractiveHandle {
  const completion = Promise.withResolvers<InteractiveResult>();
  let used = false;
  let closed = false;
  let cancelled = options.signal?.aborted === true;
  let invoked = false;
  let process: InteractiveHcnProcess | undefined;
  let termination: Promise<void> | undefined;
  const stop = (): void => {
    cancelled = true;
    const child = process;
    if (child)
      termination ??= (async () => {
        await terminateHcn(child, deps.refusalGraceMs ?? 12_000);
        await child.exited;
        child.disposeControl();
      })();
    else if (!used) {
      closed = true;
      options.signal?.removeEventListener("abort", stop);
      completion.resolve({ kind: "refused", evidence: "dispatch-not-called", reason: "cancelled" });
    }
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  if (cancelled) stop();
  return {
    cancel: stop,
    settled: completion.promise,
    control: {
      async *[Symbol.asyncIterator]() {
        if (used)
          throw new HarnessRefusal(
            "native-launch-already-opened",
            "This native launch already has a control reader.",
          );
        used = true;
        let drained = false;
        let phase: "new" | InteractiveControlRecord["kind"] = "new";
        let result: InteractiveResult = { kind: "uncertain", reason: "control-incomplete" };
        try {
          if (cancelled || closed || options.signal?.aborted) {
            result = { kind: "refused", evidence: "dispatch-not-called", reason: "cancelled" };
            return;
          }
          const spawn = deps.spawnInteractive;
          if (!spawn) {
            result = {
              kind: "refused",
              evidence: "dispatch-not-called",
              reason: "operation-unavailable",
            };
            return;
          }
          const invoke = (): undefined => {
            if (closed || cancelled || options.signal?.aborted || invoked)
              throw new HarnessRefusal(
                "native-launch-already-opened",
                "This native launch invocation is no longer available.",
              );
            invoked = true;
            process = spawn(
              [
                deps.bin,
                "interactive",
                options.harness,
                "--interface",
                options.interface,
                "--launch-id",
                options.launchId,
                "--resume",
                options.resume,
                "--cwd",
                options.cwd,
                "--control-fd",
                "3",
                ...(options.startupPrompt === undefined
                  ? []
                  : ["--startup-prompt", options.startupPrompt]),
              ],
              { cwd: options.cwd },
            );
          };
          if (options.dispatch) options.dispatch(invoke);
          else invoke();
          const child = process;
          if (!child) throw new InvalidControl();
          logLifecycle(deps, {
            event: "hcn_interactive",
            harness: options.harness,
            launchId: options.launchId,
          });
          for await (const line of controlLines(child.control)) {
            const record = parseControl(line, options);
            if (record.kind === "ready" && phase === "new") phase = "ready";
            else if (record.kind === "started" && phase === "ready") phase = "started";
            else if (record.kind === "refused" && (phase === "new" || phase === "ready")) {
              phase = "refused";
              result = { kind: "refused", evidence: record.evidence, reason: record.reason };
            } else if (record.kind === "closed" && phase === "started") {
              phase = "closed";
              result = record.cleanupComplete
                ? { kind: "closed", cleanupComplete: true, exitCode: record.exitCode }
                : { kind: "uncertain", reason: "cleanup-unconfirmed" };
            } else throw new InvalidControl();
            yield record;
          }
          await child.exited;
          drained = true;
        } catch {
          result = invoked
            ? { kind: "uncertain", reason: "control-unverified" }
            : { kind: "refused", evidence: "dispatch-not-called", reason: "dispatch-not-called" };
        } finally {
          closed = true;
          options.signal?.removeEventListener("abort", stop);
          if (!drained) {
            if (invoked) result = { kind: "uncertain", reason: "control-unverified" };
            stop();
          }
          try {
            await termination;
          } finally {
            process?.disposeControl();
            logLifecycle(deps, {
              event: "hcn_interactive_settled",
              harness: options.harness,
              launchId: options.launchId,
              phase,
              outcome: result.kind,
              ...(result.kind === "closed"
                ? { exitCode: result.exitCode }
                : { reason: result.reason }),
            });
            completion.resolve(result);
          }
        }
      },
    },
  };
}

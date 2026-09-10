import { EventKind } from "../protocol/events.js";
import { decodeHarnessLine } from "./events.js";
import { inspectedExecutable } from "./inspection-facts.js";
import type { HarnessDeps, HcnProcess } from "./process.js";
import { flag, terminateHcn } from "./process.js";
import type { ContextCount, ContextCountFailure, ContextCountOptions } from "./runner.js";

const MAX_RESPONSE = 65_536;
const PROBE_TIMEOUT_MS = 60_000;
// hcn owns a 30-second probe and up to ten seconds of native cleanup.
const CLEANUP_GRACE_MS = 12_000;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const unavailable = (reason: ContextCountFailure): ContextCount => ({
  status: "unavailable",
  reason,
});

function readCount(raw: string, options: ContextCountOptions): ContextCount {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return unavailable("invalid-accounting-response");
  }
  if (
    !record(value) ||
    value.v !== 1 ||
    value.harness !== options.harness ||
    value.mode !== options.profile ||
    !record(value.accounting)
  )
    return unavailable("invalid-accounting-response");
  const accounting = value.accounting;
  if (accounting.status === "unavailable") {
    const reasons: readonly ContextCountFailure[] = [
      "auth",
      "limit",
      "native-exit",
      "unverified-adapter",
      "unsupported-adapter",
      "transport-limit",
      "transport",
      "protocol",
      "timeout",
      "cancelled",
      "cleanup",
    ];
    return unavailable(
      reasons.find((reason) => reason === accounting.reason) ?? "unknown-accounting-failure",
    );
  }
  const executable = inspectedExecutable(value.executable);
  if (
    typeof accounting.model === "string" &&
    options.model !== undefined &&
    accounting.model !== options.model
  )
    return unavailable("model-divergence");
  if (
    accounting.status !== "available" ||
    accounting.method !== "native-context-estimate" ||
    executable.path === null ||
    typeof accounting.model !== "string" ||
    accounting.model.length === 0 ||
    !positive(accounting.inputLimitTokens) ||
    !positive(accounting.contextWindowTokens) ||
    accounting.inputLimitTokens > accounting.contextWindowTokens ||
    typeof accounting.totalTokens !== "number" ||
    !Number.isSafeInteger(accounting.totalTokens) ||
    accounting.totalTokens < 0
  ) {
    return unavailable("invalid-accounting-response");
  }
  return {
    status: "available",
    executable: { path: executable.path },
    method: "native-context-estimate",
    model: accounting.model,
    totalTokens: accounting.totalTokens,
    inputLimitTokens: accounting.inputLimitTokens,
  };
}

/** This command carries one prompt on stdin and one bounded response back.
 * It never reads descriptors or infers a model's token capacity. */
export async function countContext(
  deps: HarnessDeps,
  options: ContextCountOptions,
): Promise<ContextCount> {
  if (options.signal?.aborted) return unavailable("cancelled");
  const log = deps.log ?? (() => {});
  log({
    event: "hcn_context_probe_started",
    harness: options.harness,
    model: options.model,
    profile: options.profile,
  });
  const finish = (result: ContextCount): ContextCount => {
    log({ event: "hcn_context_probe_ended", harness: options.harness, result });
    return result;
  };
  let proc: HcnProcess;
  try {
    proc = deps.spawn(
      [
        deps.bin,
        "inspect",
        options.harness,
        "--context",
        "--json",
        "--mode",
        options.profile,
        ...flag("--model", options.model),
        ...flag("--effort", options.effort),
        ...flag("--provider", options.provider),
        ...flag("--resume", options.resume),
        ...flag("--isolation", options.isolation),
        ...(options.isolation ? ["--questions", "none"] : []),
        "--prompt-file",
        "-",
      ],
      options.cwd === undefined ? {} : { cwd: options.cwd },
    );
  } catch {
    return finish(unavailable("transport"));
  }
  let cancel!: (reason: ContextCountFailure) => void;
  const interrupted = new Promise<{ readonly reason: ContextCountFailure }>((resolve) => {
    cancel = (reason) => resolve({ reason });
  });
  const abort = (): void => cancel("cancelled");
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => cancel("timeout"), deps.accountingTimeoutMs ?? PROBE_TIMEOUT_MS);
  void proc.inputError?.then(() => cancel("transport"));
  let out = "";
  let overflow = false;
  const stdout = (async () => {
    for await (const chunk of proc.stdout) {
      if (overflow) continue;
      if (out.length + chunk.length > MAX_RESPONSE) {
        overflow = true;
        cancel("response-limit");
        continue;
      }
      out += chunk;
    }
  })();
  const stderr = (async () => {
    for await (const _ of proc.stderr) {
      /* Drain; never expose raw diagnostics. */
    }
  })();
  const complete = Promise.all([stdout, stderr, proc.exited]).then(
    ([, , code]) => ({ code }),
    () => ({ reason: "transport" as const }),
  );
  try {
    proc.write(options.prompt);
    proc.endInput();
  } catch {
    cancel("transport");
  }
  if (options.signal?.aborted) abort();
  const outcome = await Promise.race([complete, interrupted]);
  clearTimeout(timer);
  options.signal?.removeEventListener("abort", abort);
  if ("reason" in outcome) {
    const escalated = await terminateHcn(proc, deps.refusalGraceMs ?? CLEANUP_GRACE_MS);
    log({ event: "hcn_context_probe_stopped", harness: options.harness, escalated });
    proc.disposeOutput();
    return finish(unavailable(outcome.reason));
  }
  if (outcome.code !== 0) {
    const result = readCount(out, options);
    if (
      result.status === "unavailable" &&
      result.reason !== "invalid-accounting-response" &&
      result.reason !== "model-divergence"
    )
      return finish(result);
    for (const line of out.split("\n")) {
      const event = decodeHarnessLine(line);
      if (
        event?.kind === EventKind.failure &&
        event.class === "rejected" &&
        typeof event.issue === "string" &&
        /^[a-z][a-z0-9-]{0,63}$/.test(event.issue)
      )
        return finish({ status: "unavailable", reason: "accounting-refused", issue: event.issue });
    }
    return finish(unavailable("accounting-refused"));
  }
  return finish(readCount(out, options));
}

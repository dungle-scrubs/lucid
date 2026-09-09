/**
 * The production HarnessRunner: spawn `hcn --json`, decode its NDJSON.
 *
 * hcn's session stream is flat - one `turn` line opens a turn, its events
 * follow, a turn-scoped `done` ends it, and one `closed` line ends the
 * process. lucid's host consumes turns as nested iterables, so this regroups
 * the flat stream into them, reading each turn's input id off hcn's own
 * `turn` event rather than keeping a parallel queue.
 *
 * What it is NOT: it does not know the durable log, the flock, the presence
 * lock, or the protocol. It converts a subprocess's stdout into events.
 */

import { EventKind } from "../protocol/events.js";
import {
  diagnosticMessage,
  failureDiagnostic,
  refusalDetail,
  safeFact,
  selectionProblem,
} from "./compatibility.js";
import { countContext } from "./context-accounting.js";
import { decodeHarnessLine, type HarnessEvent } from "./events.js";
import {
  inspectedExecutable,
  nativeContextManagement,
  verifiedExecutable,
} from "./inspection-facts.js";
import type { HarnessDeps } from "./process.js";
import { flag, settlesWithin, terminateHcn } from "./process.js";
import { AsyncQueue } from "./queue.js";
import {
  type CapabilityResult,
  type Disposition,
  type HarnessFacts,
  type HarnessMode,
  type HarnessName,
  HarnessRefusal,
  type HarnessRunner,
  HarnessSpawnError,
  type HarnessTurn,
  HarnessVersionError,
  type HarnessVocabulary,
  type OpenSessionOptions,
  type SendResult,
  type SessionClosed,
  type SessionHandle,
  type StreamTurnOptions,
} from "./runner.js";
import { belowFloor, HCN_MIN_VERSION } from "./version.js";

/** Split a byte/'text' stream into lines, keeping a partial tail. */
async function* lines(chunks: AsyncIterable<string>): AsyncIterable<string> {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      yield buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
    }
  }
  // A final line without a trailing newline is still a line.
  if (buffer.trim() !== "") yield buffer;
}

/** How long `hcn session --json` may stay silent before lucid gives up on
 * the open. Generous: a cold harness start is slow, and the turn-level
 * budget (`--stall`) governs everything after this point. */
const OPEN_TIMEOUT_MS = 30_000;

/** hcn writes provenance and divergence to stderr. lucid does not read it,
 * but something must: an unread pipe fills at 64 KiB and the child then
 * blocks writing to it, which stalls stdout and looks like a harness hang. */
const drainStderr = (proc: { readonly stderr: AsyncIterable<string> }, _label: string): void => {
  void (async () => {
    try {
      for await (const _chunk of proc.stderr) {
        // Read and discard; the point is to keep the pipe empty.
      }
    } catch {
      // A closed stderr is not a failure of the turn.
    }
  })();
};

export const createHcnRunner = (deps: HarnessDeps): HarnessRunner => {
  const log = deps.log ?? (() => {});
  const safeRefusal = (
    event: HarnessEvent,
    choice: { readonly harness: string; readonly model?: string },
    origin: "execution-check" | "session-handshake",
  ): HarnessEvent => {
    const failure =
      event.kind === EventKind.failure ? event : "failure" in event ? event.failure : null;
    if (
      !failure ||
      typeof failure !== "object" ||
      !("class" in failure) ||
      failure.class !== "rejected"
    )
      return event;
    const diagnostic = selectionProblem(
      choice,
      deps.installation,
      "selection-unsupported",
      refusalDetail("issue" in failure ? failure.issue : null),
      origin,
    );
    const safe = { ...failure, message: diagnosticMessage(diagnostic), compatibility: diagnostic };
    return event.kind === EventKind.failure ? { ...event, ...safe } : { ...event, failure: safe };
  };

  /** Run hcn to completion and return its stdout lines. Used by the
   * inspection commands, which never spawn a harness. */
  const runToCompletion = async (
    argv: readonly string[],
    cwd?: string,
    signal?: AbortSignal,
  ): Promise<{ out: string[]; err: string[]; code: number | null }> => {
    if (signal?.aborted)
      throw new HarnessRefusal("inspection-cancelled", "hcn inspection cancelled");
    const proc = deps.spawn([deps.bin, ...argv], cwd === undefined ? {} : { cwd });
    const interrupted = Promise.withResolvers<never>();
    const cancel = (): void =>
      interrupted.reject(new HarnessRefusal("inspection-cancelled", "hcn inspection cancelled"));
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(
      () =>
        interrupted.reject(new HarnessRefusal("inspection-timeout", "hcn inspection timed out")),
      deps.inspectionTimeoutMs ?? OPEN_TIMEOUT_MS,
    );
    let size = 0;
    const read = async (chunks: AsyncIterable<string>): Promise<string[]> => {
      let text = "";
      for await (const chunk of chunks) {
        size += chunk.length;
        if (size > 1_048_576)
          throw new HarnessRefusal(
            "inspection-limit",
            "hcn inspection response exceeded its limit",
          );
        text += chunk;
      }
      return text.split("\n").filter((line) => line.trim() !== "");
    };
    const completed = Promise.all([read(proc.stdout), read(proc.stderr), proc.exited]);
    let success = false;
    try {
      const [out, err, code] = await Promise.race([completed, interrupted.promise]);
      success = true;
      return { out, err, code };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (!success) {
        const grace = deps.refusalGraceMs ?? 12_000;
        await terminateHcn(proc, grace);
        await settlesWithin(proc.exited, grace);
      }
      proc.disposeOutput();
    }
  };

  /** The dump's `vocabulary` and `turnOptions` projected to what RFC-12's
   * lists need. The dump is trusted for content and not for shape: a field
   * of the wrong type is dropped rather than cast, so a future hcn that
   * widens the vocabulary cannot make lucid serve a mangled list. */
  const vocabularyOf = (parsed: Record<string, unknown>): HarnessVocabulary | undefined => {
    const v = parsed.vocabulary;
    if (v === null || typeof v !== "object") return undefined;
    const strings = (x: unknown): readonly string[] =>
      Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];
    const turn = parsed.turnOptions;
    const turnMap =
      turn !== null && typeof turn === "object" ? (turn as Record<string, unknown>) : {};
    return {
      aliases: Object.fromEntries(
        Object.entries((v as { aliases?: object }).aliases ?? {}).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      models: strings((v as Record<string, unknown>).models),
      efforts: strings((v as Record<string, unknown>).efforts),
      extensible: (v as Record<string, unknown>).extensible === true,
      ...(turnMap.provider === undefined ? {} : { provider: true as const }),
    };
  };

  const inspectUnchecked: HarnessRunner["inspect"] = async (harness, choice) => {
    let runtime: HarnessFacts["runtime"];
    if (
      choice &&
      (choice.model !== undefined ||
        choice.effort !== undefined ||
        choice.provider !== undefined ||
        choice.isolation !== undefined ||
        choice.runtime !== undefined)
    ) {
      const check = await runToCompletion(
        [
          "inspect",
          harness,
          choice.runtime ? "--runtime" : "--argv",
          "--prompt",
          "Validate settings",
          ...flag("--model", choice.model),
          ...flag("--effort", choice.effort),
          ...flag("--provider", choice.provider),
          ...flag("--isolation", choice.isolation),
          ...flag("--resume", choice.runtime?.resume),
          ...flag("--mode", choice.runtime?.profile),
        ],
        choice.runtime?.cwd,
        choice.signal,
      );
      if (check.code !== 0) {
        const refusal = [...check.out, ...check.err]
          .map(decodeHarnessLine)
          .find((event) => event?.kind === EventKind.failure && event.class === "rejected");
        const diagnostic = selectionProblem(
          { harness, model: choice.model },
          deps.installation,
          refusal ? "selection-unsupported" : "inspection-unavailable",
          refusal ? refusalDetail("issue" in refusal ? refusal.issue : null) : undefined,
          choice.diagnosticOrigin,
        );
        throw new HarnessRefusal(
          "invalid-settings",
          diagnosticMessage(diagnostic),
          undefined,
          diagnostic,
        );
      }
      if (choice.runtime) {
        let value: unknown;
        try {
          value = JSON.parse(check.out.join("\n"));
        } catch {
          throw new HarnessRefusal(
            "invalid-settings",
            "hcn runtime inspection did not return valid JSON",
          );
        }
        if (value === null || typeof value !== "object" || Array.isArray(value))
          throw new HarnessRefusal(
            "invalid-settings",
            "hcn runtime inspection did not return an object",
          );
        const parsed = value as Record<string, unknown>;
        const executable = parsed.executable as Record<string, unknown> | undefined;
        const resume = parsed.resume as Record<string, unknown> | undefined;
        if (
          parsed.v === 1 &&
          executable &&
          resume &&
          Array.isArray(parsed.argv) &&
          parsed.argv.length > 0 &&
          parsed.argv.every((part) => typeof part === "string")
        ) {
          const { path, version } = inspectedExecutable(executable);
          runtime = {
            verifiedAgainst:
              typeof parsed.verifiedAgainst === "string" ? parsed.verifiedAgainst : null,
            executable: { path, version },
            resume: {
              status:
                resume.status === "supported" &&
                verifiedExecutable(executable, parsed.verifiedAgainst)
                  ? "supported"
                  : "unknown",
              reason: typeof resume.reason === "string" ? resume.reason : null,
            },
          };
        }
      }
    }
    if (choice?.signal?.aborted)
      throw new HarnessRefusal("inspection-cancelled", "hcn inspection cancelled");
    const facts = factCache.get(harness) ?? (await readFacts(harness, choice?.signal));
    factCache.set(harness, facts);
    return runtime === undefined ? facts : { ...facts, runtime };
  };
  const inspect: HarnessRunner["inspect"] = async (harness, choice) => {
    try {
      return await inspectUnchecked(harness, choice);
    } catch (error) {
      if (failureDiagnostic(error)) throw error;
      const issue = error instanceof HarnessRefusal ? error.issue : "inspect-failed";
      const detail =
        issue === "inspection-timeout"
          ? "harness inspection timed out"
          : issue === "inspection-limit"
            ? "harness inspection response exceeded its limit"
            : issue === "inspection-cancelled"
              ? "harness inspection cancelled"
              : "harness inspection is unavailable or returned malformed evidence";
      const diagnostic = selectionProblem(
        { harness, model: choice?.model },
        deps.installation,
        "inspection-unavailable",
        detail,
        choice?.diagnosticOrigin,
      );
      throw new HarnessRefusal(issue, diagnosticMessage(diagnostic), undefined, diagnostic);
    }
  };
  const factCache = new Map<HarnessName, HarnessFacts>();
  const readFacts = async (harness: HarnessName, signal?: AbortSignal): Promise<HarnessFacts> => {
    const { out, err, code } = await runToCompletion(
      ["inspect", harness, "--json"],
      undefined,
      signal,
    );
    if (code !== 0) {
      throw new HarnessRefusal("inspect-failed", err.join("\n") || `hcn inspect exited ${code}`);
    }
    const parsed = JSON.parse(out.join("\n")) as Record<string, unknown>;
    const vocabulary = vocabularyOf(parsed);
    return {
      name: String(parsed.name ?? harness),
      ...(nativeContextManagement(parsed.nativeContextManagement)
        ? { nativeContextManagement: true as const }
        : {}),
      ...(parsed.contextInspection !== null &&
      typeof parsed.contextInspection === "object" &&
      !Array.isArray(parsed.contextInspection)
        ? { contextAccounting: true as const }
        : {}),
      ...(typeof parsed.bin === "string" ? { binary: parsed.bin } : {}),
      // The descriptor's sessionMode is the runtime-verified answer to
      // "can this harness hold a persistent session" (PLAN D-008).
      session: parsed.sessionMode !== null && parsed.sessionMode !== undefined,
      verifiedAgainst: String(parsed.verifiedAgainst ?? "unknown"),
      ...(vocabulary === undefined ? {} : { vocabulary }),
    };
  };

  const capabilities = async (
    harness: HarnessName,
    model: string,
    mode: HarnessMode,
  ): Promise<CapabilityResult> => {
    const { out, err, code } = await runToCompletion([
      "inspect",
      harness,
      "--capabilities",
      "--mode",
      mode,
      ...flag("--model", model === "" ? undefined : model),
    ]);
    if (code !== 0) {
      throw new HarnessRefusal("capabilities-failed", err.join("\n") || `hcn exited ${code}`);
    }
    return JSON.parse(out.join("\n")) as CapabilityResult;
  };

  const streamTurn = (opts: StreamTurnOptions): AsyncIterable<HarnessEvent> => {
    if (opts.signal?.aborted) throw new HarnessRefusal("aborted", "The turn was canceled");
    if (opts.isolation && opts.resume !== undefined)
      throw new HarnessRefusal("invalid-isolation", "An isolated turn cannot resume a session");
    const argv = [
      deps.bin,
      "run",
      opts.harness,
      "--json",
      ...flag("--model", opts.model),
      ...flag("--provider", opts.provider),
      ...flag("--effort", opts.effort),
      ...flag("--resume", opts.resume),
      ...flag("--isolation", opts.isolation),
      ...flag(
        "--timeout",
        opts.timeoutSeconds === undefined
          ? opts.isolation
            ? "60"
            : undefined
          : String(opts.timeoutSeconds),
      ),
      ...(opts.isolation ? ["--questions", "none"] : []),
      "--prompt-file",
      "-",
    ];
    log({ event: "hcn_run", turnId: opts.turnId, harness: opts.harness });
    const proc = deps.spawn(argv, opts.cwd === undefined ? {} : { cwd: opts.cwd });
    let termination: Promise<void> | undefined;
    const terminate = (): void => {
      termination ??= (async () => {
        const grace = deps.refusalGraceMs ?? 12_000;
        await terminateHcn(proc, grace);
        await settlesWithin(proc.exited, grace);
        proc.disposeOutput();
      })();
    };
    const removeAbort = (): void => opts.signal?.removeEventListener("abort", terminate);
    opts.signal?.addEventListener("abort", terminate, { once: true });
    if (opts.signal?.aborted) terminate();
    void proc.inputError?.then(terminate);
    try {
      proc.write(opts.prompt);
      proc.endInput();
    } catch {
      terminate();
    }
    void proc.exited.then(removeAbort, removeAbort);
    // A pipe nobody reads fills, and a child blocked writing to it stops
    // producing stdout - a hang that looks exactly like a harness stall.
    drainStderr(proc, opts.turnId);
    return {
      async *[Symbol.asyncIterator]() {
        let drained = false;
        try {
          for await (const line of lines(proc.stdout)) {
            const event = decodeHarnessLine(line);
            if (event !== null) yield safeRefusal(event, opts, "execution-check");
          }
          drained = true;
          await proc.exited;
        } finally {
          // Abandonment is not an ending. A consumer that stops reading -
          // the host closing mid-turn, a `break`, a thrown error - leaves
          // this hcn child and the harness under it running with nobody to
          // stop them. Whoever walks away owns ending it.
          if (!drained) {
            log({ event: "hcn_run_abandoned", turnId: opts.turnId, harness: opts.harness });
            terminate();
          }
          await termination;
        }
      },
    };
  };

  const openSession = async (opts: OpenSessionOptions): Promise<SessionHandle> => {
    if (opts.signal?.aborted) throw new HarnessRefusal("aborted", "The session was canceled");
    const argv = [
      deps.bin,
      "session",
      opts.harness,
      "--json",
      // --resume continues a conversation; --session-id only names one, and
      // hcn refuses the two together. Resuming wins when both are known: the
      // caller asked to continue something specific.
      ...(opts.resume === undefined ? ["--session-id", opts.sessionId] : ["--resume", opts.resume]),
      ...flag("--model", opts.model),
      ...flag("--provider", opts.provider),
      // hcn >= 0.6.0 carries --effort on session, validated per
      // harness/model the same way the run path validates it (RFC-12).
      ...flag("--effort", opts.effort),
      ...flag("--stall", opts.stallSeconds === undefined ? undefined : String(opts.stallSeconds)),
    ];
    log({ event: "hcn_session_open", sessionId: opts.sessionId, harness: opts.harness });
    const proc = deps.spawn(argv, opts.cwd === undefined ? {} : { cwd: opts.cwd });

    drainStderr(proc, opts.sessionId);

    const turnsQueue = new AsyncQueue<HarnessTurn>();
    // One waiter per outstanding send, resolved by its disposition line.
    const pendingSends = new Map<string, (r: SendResult) => void>();
    let currentTurn: AsyncQueue<HarnessEvent> | null = null;
    let closedInfo: SessionClosed | null = null;
    let refusal: Error | null = null;
    let sawSession = false;
    // Events that arrive with no turn open. hcn's kinds are additive and the
    // decoder carries what it does not know, so dropping one here would undo
    // that promise one layer up. They ride into the next turn instead.
    const preTurnEvents: HarnessEvent[] = [];
    const PRE_TURN_MAX = 256;

    const settleAll = (result: SendResult): void => {
      for (const resolve of pendingSends.values()) resolve(result);
      pendingSends.clear();
    };

    // The handshake settles on the first thing that decides it: the session
    // line, a refusal, a close, or the process dying. Nothing polls.
    let settleOpen!: () => void;
    const opened = new Promise<void>((resolve) => {
      settleOpen = resolve;
    });

    const pump = (async () => {
      for await (const line of lines(proc.stdout)) {
        const event = decodeHarnessLine(line);
        if (event === null) continue;

        if (event.kind === "session") {
          const e = event as Extract<HarnessEvent, { kind: "session" }>;
          // The binary's own report of what it is. `hcn --version` was
          // checked once at resolution; this is the stream saying the same
          // thing, and it is the only check a `run` path could not make.
          if (typeof e.hcn === "string" && belowFloor(e.hcn)) {
            refusal = new HarnessVersionError(
              e.hcn,
              HCN_MIN_VERSION,
              deps.bin,
              deps.installation,
              "session-handshake",
            );
            settleOpen();
            continue;
          }
          sawSession = true;
          settleOpen();
          continue;
        }
        if (event.kind === "disposition") {
          const e = event as Extract<HarnessEvent, { kind: "disposition" }>;
          const waiter = pendingSends.get(e.id);
          if (waiter !== undefined) {
            pendingSends.delete(e.id);
            // Narrowed, not cast. hcn answers `started` or `rejected`; a
            // cast would let a third value through as one of those and
            // silently mark a turn started that never was. Anything else
            // is refused with the value in the reason, so an hcn that
            // grows a disposition says so in the log.
            const known = e.disposition === "started" || e.disposition === "rejected";
            waiter(
              known
                ? {
                    disposition: e.disposition as Disposition,
                    ...(e.disposition === "rejected"
                      ? { rejectionEvidence: "harness-refusal" as const }
                      : {}),
                    ...(e.reason === undefined ? {} : { reason: e.reason }),
                  }
                : { disposition: "rejected", reason: `unknown disposition: ${e.disposition}` },
            );
          }
          continue;
        }
        if (event.kind === "turn") {
          const e = event as Extract<HarnessEvent, { kind: "turn" }>;
          // A turn line while one is open means the previous turn produced
          // no terminal event. Close it rather than strand its consumer.
          currentTurn?.close();
          const queue = new AsyncQueue<HarnessEvent>();
          currentTurn = queue;
          for (const held of preTurnEvents.splice(0)) queue.push(held);
          const turn: HarnessTurn = Object.assign(queue as AsyncIterable<HarnessEvent>, {
            turnId: e.turnId,
            ...(e.id === undefined ? {} : { inputId: e.id }),
          });
          turnsQueue.push(turn);
          continue;
        }
        if (event.kind === "closed") {
          const e = event as Extract<HarnessEvent, { kind: "closed" }>;
          closedInfo = { exitCode: e.exitCode, cause: e.cause };
          currentTurn?.close();
          currentTurn = null;
          // Anything still waiting for a disposition never gets one: the
          // session is over. Settling here rather than at stream end means
          // a caller is not left holding a promise while the pipe drains.
          settleAll({ disposition: "rejected", reason: "closed" });
          settleOpen();
          continue;
        }
        if (event.kind === "failure" && !sawSession) {
          // A refusal before the session line: hcn writes failure + closed
          // and exits 2. Nothing was spawned; the caller must change options.
          const f = event as Extract<HarnessEvent, { kind: "failure" }>;
          const diagnostic =
            f.class === "rejected"
              ? selectionProblem(
                  opts,
                  deps.installation,
                  "selection-unsupported",
                  refusalDetail(f.issue),
                  "session-handshake",
                )
              : undefined;
          refusal = new HarnessRefusal(
            String(f.issue ?? "rejected"),
            diagnostic
              ? diagnosticMessage(diagnostic)
              : `HCN could not open the session (${safeFact(f.class) ?? "unknown"} failure).`,
            undefined,
            diagnostic,
          );
          settleOpen();
          continue;
        }
        if (currentTurn !== null) {
          currentTurn.push(safeRefusal(event, opts, "execution-check"));
          continue;
        }
        // No turn open: hold it for the next one rather than dropping it.
        preTurnEvents.push(event);
        if (preTurnEvents.length > PRE_TURN_MAX) preTurnEvents.shift();
      }
      currentTurn?.close();
      turnsQueue.close();
      settleAll({ disposition: "rejected", reason: "closed" });
      settleOpen();
      await proc.exited;
    })();

    // A child that never says anything must not hang the open. Racing
    // `proc.exited` would not do it - a silent-but-alive hcn never exits -
    // and it would race the pump, settling before the refusal it is about to
    // read. A deadline is the only thing that bounds the silent case, and
    // the pump settles every case that actually produces output.
    let closeRequested = false;
    const requestClose = (): void => {
      if (closeRequested) return;
      closeRequested = true;
      try {
        proc.write(`${JSON.stringify({ op: "close" })}\n`);
        proc.endInput();
      } catch {
        // The process may already have closed its input pipe.
      }
    };
    let closing: Promise<void> | undefined;
    const closeSession = (): Promise<void> => {
      requestClose();
      closing ??= (async () => {
        const grace = deps.refusalGraceMs ?? 1_000;
        if (await settlesWithin(pump, grace)) return;
        if (!(await terminateHcn(proc, grace, pump))) return;
        await settlesWithin(pump, grace);
      })();
      return closing;
    };
    const abort = (): void => {
      requestClose();
      if (!sawSession) {
        refusal = new HarnessRefusal("aborted", "The session was canceled before opening");
        settleOpen();
      } else {
        void closeSession();
      }
    };
    const removeAbort = (): void => opts.signal?.removeEventListener("abort", abort);
    opts.signal?.addEventListener("abort", abort, { once: true });
    void proc.exited.then(removeAbort, removeAbort);
    const deadline = setTimeout(() => {
      if (!sawSession && refusal === null && closedInfo === null) {
        refusal = new HarnessSpawnError(`hcn produced no session line within ${OPEN_TIMEOUT_MS}ms`);
      }
      settleOpen();
    }, OPEN_TIMEOUT_MS);
    // Never hold the process open on lucid's behalf.
    (deadline as unknown as { unref?: () => void }).unref?.();

    await opened;
    clearTimeout(deadline);
    if (refusal !== null) {
      const thrown = refusal;
      try {
        proc.endInput();
      } catch {}
      try {
        proc.kill("SIGTERM");
      } catch {}
      if (!(await settlesWithin(pump, deps.refusalGraceMs ?? 1_000))) {
        try {
          proc.kill("SIGKILL");
        } catch {}
        await settlesWithin(pump, deps.refusalGraceMs ?? 1_000);
      }
      throw thrown;
    }

    const dispatch = (op: "send" | "answer", id: string, text: string): Promise<SendResult> => {
      if (closedInfo !== null) {
        return Promise.resolve({ disposition: "rejected", reason: "closed" });
      }
      return new Promise<SendResult>((resolve) => {
        pendingSends.set(id, resolve);
        try {
          proc.write(`${JSON.stringify({ op, id, text })}\n`);
        } catch {
          pendingSends.delete(id);
          resolve({ disposition: "rejected", reason: "closed" });
        }
      });
    };

    return {
      turns: turnsQueue,
      send: (id, text) => dispatch("send", id, text),
      answer: (id, text) => dispatch("answer", id, text),
      async close(): Promise<SessionClosed> {
        await closeSession();
        return closedInfo ?? { exitCode: null, cause: "killed" };
      },
    };
  };

  return {
    installation: deps.installation,
    reportCompatibility: (diagnostic) => {
      deps.log?.({ event: "compatibility", diagnostic });
      console.error(
        `${diagnostic.severity === "error" ? "Error" : "Warning"}: ${diagnosticMessage(diagnostic)}`,
      );
    },
    openSession,
    streamTurn,
    inspect,
    capabilities,
    countContext: (options) => countContext(deps, options),
  };
};

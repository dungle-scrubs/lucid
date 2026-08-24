/**
 * ConversationHost — the deep module that owns the durable store's
 * read and write discipline.
 *
 * `src/store/store.ts` previously owned three things in one file:
 * `createConversationRecord` (mint), `openConversation` (transact +
 * snapshot + wire redaction + recovery), and the lock-free readers
 * `viewConversation` / `viewSnapshot`. Fixing a projection bug required
 * bouncing between the host's `snapshot()` and the free `viewSnapshot()`
 * — two derivations from the same fold — and the 10-method surface
 * (`handleFrame`/`enqueueInput`/`grantCredit`/`state`/`transcript`/
 * `status`/`snapshot`/`view*`/`close`) made the interface nearly as
 * wide as the implementation (shallow). The durable log itself was deep
 * (`ConversationLog`), the reducer was deep (3 ledgers), but the host
 * between them was not.
 *
 * Now one module owns the whole host discipline — record-file reading
 * (secret + identity, D-004), the single `transact` seam
 * (lock→catch-up→reduce→write→lease-gated effects→record, C01 + RFC-04
 * R2), secret redaction, recovery emission, and the single snapshot
 * derivation
 * (`log.state()` once → transcript + status from that same state +
 * injected clock/presence, 01). Callers see a small, deep interface:
 * `createConversationHost(dir, deps) → ConversationHost` with
 * `{snapshot, state, transcript, status, handleFrame, enqueueInput,
 * grantCredit, close}` plus lock-free `viewConversation` / `viewSnapshot`
 * that share the same fold seam. The mint (`createConversationRecord`)
 * stays in `store.ts` — this module is the host, not the mint.
 *
 * Deletion test: deleting this module would scatter secret-load,
 * redaction, transact, recovery, and snapshot derivation across every
 * CLI command, every hook, and every test that touches the log.
 *
 * What it is NOT: it does not own the log file (ConversationLog does),
 * the flock primitive, or the record mint.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Effect } from "../protocol/index.js";
import {
  type ChannelState,
  type ChannelStatus,
  channelStatus,
  type DecodeIssue,
  decodeFrame,
  enqueueInput,
  grantCredit,
  type InputMode,
  type Presence,
  type ReduceResult,
  reduce,
  type TransitionRecord,
} from "../protocol/index.js";
import { pathsForDir, type RecordPaths, StoreError } from "./errors.js";
import type { LockEvent } from "./lock.js";
import { type AppendEvent, type CollectedBatch, createLog, foldLog, type LogEntry } from "./log.js";

const REDACTED = "redacted";

export type {
  AppendEvent,
  CollectedBatch,
  CollectedEntry,
  LogEntry,
  Transcript,
  TranscriptEvent,
  TranscriptInput,
} from "./log.js";

export interface HostDeps {
  readonly now: () => number;
  /** The normalizer's ps-level INTERACTIVE-process probe. Liveness
   * arithmetic and the attach reducer's presence corroboration read it.
   * It is NOT flock ownership: a headless runtime that holds the record's
   * presence lock can still answer `undefined` here, and a living
   * interactive process says `true` while holding nothing. Ownership is
   * `executorLease` (RFC-04 M2: the two must never be conflated). */
  readonly presence: () => boolean | undefined;
  /** RFC-04 R2: does THIS process hold the record's presence lock — the
   * executor lease. The only gate on acting on effects: a process that
   * does not hold it still writes, and the effects stay on the result and
   * in the log for the holder to rediscover on its catch-up fold. The
   * runtime passes a closure over the `PresenceHandle` it actually holds;
   * callers that never acquire the lock state `() => false`. */
  readonly executorLease: () => boolean;
  readonly onEffect: (effect: Effect) => void;
  readonly onRecord: (record: HostRecord) => void;
  readonly onLockEvent?: (event: LockEvent) => void;
  readonly onAppendEvent?: (event: AppendEvent) => void;
}

export interface WireRecord {
  readonly verdict: "refused";
  readonly wire: true;
  readonly issue: DecodeIssue;
  readonly conversationId: string;
  readonly now: number;
}

export interface RecoveryRecord {
  readonly verdict: "recovered";
  readonly conversationId: string;
  readonly entries: number;
  readonly discardedBytes: number;
  /** Durable input entries the fold carried and the reducer refused -
   * RFC-05 B4's visibility: an input mode only a newer build knows is
   * refused and reported here, never applied and never fatal. */
  readonly refusedInputs: number;
  readonly seq: number;
  readonly epoch: number;
}

export type HostRecord = TransitionRecord | WireRecord | RecoveryRecord;

export interface HostSnapshot {
  readonly state: ChannelState;
  readonly transcript: import("./log.js").Transcript;
  readonly status: ChannelStatus;
}

export interface ViewSnapshot {
  readonly state: ChannelState;
  readonly transcript: import("./log.js").Transcript;
  readonly status: ChannelStatus;
  readonly goodBytes: number;
}

const ctxOf = (presence: boolean | undefined): { presence?: Presence } =>
  presence === undefined ? {} : { presence: { processAlive: presence } };

const HEX_SECRET = /^[0-9a-f]{16,}$/;

/** Single place the host, the lock-free readers, and the tailer load
 * the record (secret + identity + paths). Thrown per call, not at
 * construction, so a reader that starts before the record exists can
 * surface the error and pick the record up once it appears. */
export const readRecordFiles = (
  dir: string,
): { secret: string; conversationId: string; paths: RecordPaths } => {
  const paths = pathsForDir(dir);
  if (!existsSync(paths.secretPath))
    throw new StoreError("missing-secret", `no secret in record dir: ${paths.secretPath}`);
  const secret = readFileSync(paths.secretPath, "utf8").trim();
  if (!HEX_SECRET.test(secret))
    throw new StoreError("invalid-secret", `malformed secret file: ${paths.secretPath}`);
  const conversationId = existsSync(paths.metaPath)
    ? (JSON.parse(readFileSync(paths.metaPath, "utf8")) as { conversationId: string })
        .conversationId
    : basename(dir);
  return { secret, conversationId, paths };
};

export interface ConversationHost {
  readonly conversationId: string;
  readonly dir: string;
  /** Atomic snapshot: one `log.state()` read → transcript + status. */
  readonly snapshot: () => HostSnapshot;
  readonly state: () => ChannelState;
  readonly transcript: () => import("./log.js").Transcript;
  readonly status: () => ChannelStatus;
  readonly close: () => void;
  handleFrame(line: string): ReduceResult | { verdict: "refused"; wire: true; issue: DecodeIssue };
  enqueueInput(input: {
    readonly id: string;
    readonly text: string;
    readonly mode: InputMode;
    readonly turnId?: string;
  }): ReduceResult;
  grantCredit(tokens: number): ReduceResult;
  /** Fold the log under the append lock and collect effects from `fromOffset`.
   * Thin delegation to the log's seam — the lock, repair, and return-
   * never-dispatch discipline lives in `ConversationLog`. */
  collectEffects(fromOffset: number): CollectedBatch;
  /** The delivery cursor (RFC-04 R4). See `ConversationLog.cursor`. */
  cursor(): number;
  /** Durably advance the delivery cursor. See `ConversationLog.advanceCursor`. */
  advanceCursor(offset: number): void;
  /** Seek index built during the fold that already happens at open — reading
   * a version is a seek, not a fold. */
  artifactIndex(): ReadonlyMap<string, number>;
  /** Read an artifact version by seek. */
  readArtifact(artifactId: string, version: number): import("./log.js").ArtifactVersion | null;
  /** Append an artifact version. Over-size is refused and the record still
   * opens; hash is written for every version from the first. */
  writeArtifact(params: {
    readonly artifactId: string;
    readonly version: number;
    readonly author: string;
    readonly contentType: string;
    readonly bytes: string;
  }):
    | { verdict: "accepted"; version: import("./log.js").ArtifactVersion }
    | { verdict: "refused"; issue: "artifact-too-large" | "artifact-version-exists" };
}

export const createConversationHost = (dir: string, deps: HostDeps): ConversationHost => {
  const { secret, conversationId, paths } = readRecordFiles(dir);

  const log = createLog(paths, secret, conversationId, {
    onLockEvent: deps.onLockEvent,
    onAppendEvent: deps.onAppendEvent,
  });

  const rec = log.recovery();
  deps.onRecord({
    verdict: "recovered",
    conversationId,
    entries: rec.entries,
    discardedBytes: rec.discardedBytes,
    refusedInputs: rec.refusedInputs,
    seq: log.state().seq,
    epoch: log.state().epoch,
  });

  const transact = (
    entry: LogEntry | null,
    produce: (s: ChannelState) => {
      result: ReduceResult;
      frame: import("../protocol/index.js").Frame | null;
    },
  ): ReduceResult => {
    const result = log.append((s) => {
      const { result: r, frame } = produce(s);
      return { entry, result: r, frame };
    });
    // RFC-04 R2: only the presence-lock holder acts on effects. A
    // non-holder's write still lands and the reduce still returns its
    // effects — the holder rediscovers them on its catch-up fold — but
    // this process hands none to its own sink. The gate reads
    // `executorLease`, never `presence`: that probe reports the
    // interactive process's liveness, not this process's lock ownership.
    if (deps.executorLease()) for (const effect of result.effects) deps.onEffect(effect);
    deps.onRecord((result as unknown as { record: HostRecord }).record);
    return result;
  };

  const snapshot = (): HostSnapshot => {
    const s = log.state();
    return {
      state: s,
      transcript: log.transcript(),
      status: channelStatus(s, deps.now(), { processAlive: deps.presence() === true }),
    };
  };

  const collectEffects = (fromOffset: number): CollectedBatch => log.collectEffects(fromOffset);
  const cursor = (): number => log.cursor();
  const advanceCursor = (offset: number): void => log.advanceCursor(offset, deps.now());
  const artifactIndex = (): ReadonlyMap<string, number> => log.artifactIndex();
  const readArtifact = (
    artifactId: string,
    version: number,
  ): import("./log.js").ArtifactVersion | null => log.readArtifact(artifactId, version);
  const writeArtifact = (params: {
    readonly artifactId: string;
    readonly version: number;
    readonly author: string;
    readonly contentType: string;
    readonly bytes: string;
  }):
    | { verdict: "accepted"; version: import("./log.js").ArtifactVersion }
    | { verdict: "refused"; issue: "artifact-too-large" | "artifact-version-exists" } =>
    log.writeArtifact(params);

  return {
    conversationId,
    dir,
    snapshot,
    state: (): ChannelState => snapshot().state,
    close: (): void => log.close(),
    transcript: () => snapshot().transcript,
    status: (): ChannelStatus => snapshot().status,
    cursor,
    advanceCursor,
    collectEffects,
    artifactIndex,
    readArtifact,
    writeArtifact,
    handleFrame: (
      line: string,
    ): ReduceResult | { verdict: "refused"; wire: true; issue: DecodeIssue } => {
      const at = deps.now();
      let parsed: unknown | undefined;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        parsed = undefined;
      }
      const decoded =
        parsed === undefined
          ? ({ verdict: "refused", issue: "not-json" } as const)
          : decodeFrame(parsed);
      if (decoded.verdict !== "ok") {
        deps.onRecord({
          verdict: "refused",
          wire: true,
          issue: decoded.issue,
          conversationId,
          now: at,
        });
        // Exempt from the R2 gate: this never reached `transact` — it is a
        // local answer to a frame that would not decode, not conversation
        // work, and the sender is owed it whichever process read the wire.
        deps.onEffect({ type: "send", frame: { kind: "refused", issue: decoded.issue } });
        return { verdict: "refused", wire: true, issue: decoded.issue };
      }
      const presence = decoded.frame.kind === "attach" ? deps.presence() : undefined;
      const durable =
        decoded.frame.kind === "attach" ? { ...decoded.frame, secret: REDACTED } : decoded.frame;
      const entry: LogEntry = {
        v: 1,
        at,
        src: "frame",
        frame: durable as unknown as Record<string, unknown>,
        ...(presence === undefined ? {} : { presence }),
      };
      return transact(entry, (s) => {
        const r = reduce(s, decoded.frame, at, ctxOf(presence));
        return { result: r, frame: decoded.frame };
      });
    },
    enqueueInput: (input: {
      readonly id: string;
      readonly text: string;
      readonly mode: InputMode;
      readonly turnId?: string;
    }): ReduceResult => {
      const at = deps.now();
      const entry: LogEntry = { v: 1, at, src: "input", input };
      return transact(entry, (s) => {
        const r = enqueueInput(s, input, at);
        return { result: r, frame: null };
      });
    },
    grantCredit: (tokens: number): ReduceResult => {
      const at = deps.now();
      const entry: LogEntry = { v: 1, at, src: "credit", tokens };
      return transact(entry, (s) => {
        const r = grantCredit(s, tokens, at);
        return { result: r, frame: null };
      });
    },
  };
};

/** Alias so existing import sites (`openConversation`) keep compiling. */
export const openConversation = createConversationHost;

/**
 * Lock-free view of a conversation's durable state. Shares the same
 * `readRecordFiles + foldLog` seam the host uses, so there is one
 * reader discipline, not two (C01).
 */
export const viewConversation = (
  dir: string,
): { state: ChannelState; transcript: import("./log.js").Transcript; goodBytes: number } => {
  const { secret, conversationId, paths } = readRecordFiles(dir);
  const raw = existsSync(paths.logPath) ? readFileSync(paths.logPath) : Buffer.alloc(0);
  const folded = foldLog(conversationId, secret, raw);
  return {
    state: folded.state,
    transcript: {
      events: [...folded.transcript.events],
      inputs: [...folded.transcript.inputs],
      aborted: [...folded.transcript.aborted],
    },
    goodBytes: folded.goodBytes,
  };
};

/**
 * Lock-free snapshot for pure readers (watch, hooks, TUI). Hosts the
 * viewer's counterpart to `host.snapshot()` — same policy, no lock.
 */
export const viewSnapshot = (
  dir: string,
  opts: { now?: () => number; presence?: () => boolean | undefined } = {},
): ViewSnapshot => {
  const { state, transcript, goodBytes } = viewConversation(dir);
  const nowFn = opts.now ?? (() => Date.now());
  const presenceFn = opts.presence ?? (() => undefined);
  const status = channelStatus(state, nowFn(), { processAlive: presenceFn() === true });
  return { state, transcript, status, goodBytes };
};

/**
 * The durable conversation store: the impure shell that hosts the pure
 * protocol reducer and enforces its verdicts. Owns the record directory
 * (published atomically at creation with a 0600 secret - D-004: a first
 * attacher never mints, and a crash never leaves a half-built record),
 * the append-only NDJSON log that is the seq authority (append + fsync
 * BEFORE state advances and effects leave), and the structured boundary
 * record for every accepted/refused transition. The attach secret is
 * redacted before it is durable - the log must never be a second,
 * weaker copy of the credential. Clock, presence, and both sinks are
 * injected, so tests are deterministic while permissions, atomicity, and
 * torn-line repair are proven against the real filesystem. NOT
 * responsible for transport (deferred) or rendering.
 *
 * M1.2 - the append transaction (D-005, flock-only D-008):
 * every mutation that appends to `log.ndjson` serializes under a real
 * `flock(2)` on the sibling `log.ndjson.lock`. The transaction is:
 * acquire -> catch-up-fold -> reduce -> write-all -> fsync -> release.
 * The catch-up re-folds the log under the lock so the reduce sees
 * current state (a second writer's committed entry is visible).
 * The write loops on short `writeSync` returns; a partial write is
 * never counted complete. A write/fsync failure truncates to the byte
 * offset captured under the lock immediately before the write (never a
 * stale open-time offset) and raises `append-failed` (E005). A torn-
 * interior newline-terminated line seen under the lock is `corrupt-log`
 * (E002) - it can only mean an unlocked writer. The fold that
 * establishes the append offset or truncates holds the lock; a pure
 * read-only viewer may fold lock-free and tolerate a torn trailing
 * fragment.
 *
 * The transaction reuses the existing `foldLog` - no copy. Byte offsets
 * are byte-accurate (Buffer.length), not UTF-16, so non-ASCII content
 * never cascades into a bad truncate.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { Effect, Frame } from "../protocol/index.js";
import {
  type ChannelState,
  type ChannelStatus,
  channelStatus,
  type DecodeIssue,
  decodeFrame,
  enqueueInput,
  grantCredit,
  initialChannelState,
  type Presence,
  type ReduceResult,
  reduce,
  type TransitionRecord,
} from "../protocol/index.js";
import { acquireAppendLock, type LockEvent } from "./lock.js";

// ---------------------------------------------------------------------------
// Errors and record layout
// ---------------------------------------------------------------------------

const SECRET_BYTES = 32;
/** What replaces the credential in the durable log (fold re-injects the
 * real secret from the 0600 file before replaying an attach). */
const REDACTED = "redacted";

export class StoreError extends Error {
  override readonly name = "StoreError";
  constructor(
    readonly code:
      | "record-exists"
      | "invalid-conversation-id"
      | "missing-secret"
      | "invalid-secret"
      | "corrupt-log"
      | "fold-refused"
      | "append-failed",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface RecordPaths {
  readonly dir: string;
  readonly secretPath: string;
  readonly logPath: string;
  readonly metaPath: string;
  /** Sibling `log.ndjson.lock` - the flock target for the append transaction. */
  readonly lockPath: string;
}

/** The one place the record layout lives (including the lock sibling). */
export const pathsForDir = (dir: string): RecordPaths => {
  const logPath = join(dir, "log.ndjson");
  return {
    dir,
    secretPath: join(dir, "secret"),
    logPath,
    metaPath: join(dir, "meta.json"),
    lockPath: `${logPath}.lock`,
  };
};

export const recordPaths = (rootDir: string, conversationId: string): RecordPaths =>
  pathsForDir(join(rootDir, conversationId));

/** A conversation id must be a single, safe path component - anything
 * else could escape the record root or change identity on reopen. */
const validConversationId = (id: string): boolean =>
  id.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(id) && id !== "." && id !== "..";

/** Create the conversation record: dir 0700, secret 0600, empty log 0600,
 * meta carrying the identity - built in a temp sibling and published with
 * one atomic rename, so the record either exists complete or not at all,
 * and two racing creators cannot both mint (D-004). */
export const createConversationRecord = (
  rootDir: string,
  conversationId: string,
): { readonly secret: string; readonly paths: RecordPaths } => {
  if (!validConversationId(conversationId))
    throw new StoreError(
      "invalid-conversation-id",
      `conversation id is not a safe path component: ${JSON.stringify(conversationId)}`,
    );
  const paths = recordPaths(rootDir, conversationId);
  if (existsSync(paths.dir))
    throw new StoreError("record-exists", `conversation record already exists: ${paths.dir}`);
  mkdirSync(rootDir, { recursive: true });
  const staging = mkdtempSync(join(rootDir, ".create-"));
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(SECRET_BYTES))).toString("hex");
  try {
    const tmp = pathsForDir(staging);
    writeFileSync(tmp.secretPath, secret, { mode: 0o600 });
    writeFileSync(tmp.logPath, "", { mode: 0o600 });
    writeFileSync(tmp.metaPath, JSON.stringify({ v: 1, conversationId }), { mode: 0o600 });
    renameSync(staging, paths.dir);
  } catch (cause) {
    rmSync(staging, { recursive: true, force: true });
    throw new StoreError("record-exists", `could not publish record at ${paths.dir}`, { cause });
  }
  return { secret, paths };
};

// ---------------------------------------------------------------------------
// Log entry types and fold
// ---------------------------------------------------------------------------

/** One durable log entry: everything fold needs to reproduce the
 * transition deterministically - source, input, clock reading, and (for
 * attach) the presence sample that shaped the verdict. */
type LogEntry =
  | {
      readonly v: 1;
      readonly at: number;
      readonly src: "frame";
      readonly frame: Record<string, unknown>;
      readonly presence?: boolean;
    }
  | {
      readonly v: 1;
      readonly at: number;
      readonly src: "input";
      readonly input: {
        readonly id: string;
        readonly text: string;
        readonly mode: "queue" | "steer";
        readonly turnId?: string;
      };
    }
  | { readonly v: 1; readonly at: number; readonly src: "credit"; readonly tokens: number };

const ENTRY_SOURCES = ["frame", "input", "credit"] as const;

const validEntry = (raw: unknown): raw is LogEntry => {
  if (typeof raw !== "object" || raw === null) return false;
  const e = raw as Record<string, unknown>;
  return (
    e.v === 1 &&
    typeof e.at === "number" &&
    Number.isSafeInteger(e.at) &&
    e.at >= 0 &&
    typeof e.src === "string" &&
    (ENTRY_SOURCES as readonly string[]).includes(e.src)
  );
};

export interface HostDeps {
  /** Injected clock - the store performs zero wall-clock reads. */
  readonly now: () => number;
  /** Latest presence sample (normalizer isInteractive, injected).
   * undefined = the host could not corroborate. */
  readonly presence: () => boolean | undefined;
  /** Every effect the reducer emits, in order (transport wiring later). */
  readonly onEffect: (effect: Effect) => void;
  /** The always-on boundary record: one structured line per transition,
   * plus one recovery line per open. Logged verbatim by the caller. */
  readonly onRecord: (record: HostRecord) => void;
  /** Structured lock boundary events (lock.acquire / lock.timeout / lock.release). */
  readonly onLockEvent?: (event: LockEvent) => void;
  /** Structured append boundary events (append.start / append.ok / append.failed). */
  readonly onAppendEvent?: (event: AppendEvent) => void;
}

/** The boundary record for a line that never decoded into a frame. */
export interface WireRecord {
  readonly verdict: "refused";
  readonly wire: true;
  readonly issue: DecodeIssue;
  readonly conversationId: string;
  readonly now: number;
}

/** One canonical line per open: what fold replayed and what crash repair
 * discarded, so recovery is never invisible at the boundary. Outbound
 * effects of replayed entries are NOT re-emitted here - exactly-once
 * delivery across recovery is the M5.4 handoff oracle's ground. */
export interface RecoveryRecord {
  readonly verdict: "recovered";
  readonly conversationId: string;
  readonly entries: number;
  readonly discardedBytes: number;
  readonly seq: number;
  readonly epoch: number;
}

export type HostRecord = TransitionRecord | WireRecord | RecoveryRecord;

/** Structured append boundary events, always-on when a sink is wired,
 * keyed by conversationId and carrying the under-lock pre-write offset. */
export type AppendEvent =
  | { readonly event: "append.start"; readonly conversationId: string; readonly offset: number }
  | {
      readonly event: "append.ok";
      readonly conversationId: string;
      readonly offset: number;
      readonly bytes: number;
    }
  | {
      readonly event: "append.failed";
      readonly conversationId: string;
      readonly offset: number;
      readonly error: string;
    };

/** One rendered event in the durable order, stamped with the lucid seq
 * that makes exactly-once render possible: a consumer applies events in
 * seq order and resumes after the highest seq it durably applied. */
export interface TranscriptEvent {
  readonly seq: number;
  readonly epoch: number;
  readonly turnId: string;
  readonly event: Record<string, unknown>;
}

/** One human input in the durable order, with its LATEST disposition
 * outcome for rendering. This survives the reducer trimming an applied
 * input out of live ChannelState (only its id is kept there) - the
 * transcript is the conversation history, so an applied human message
 * stays visible with its ✓, and a rejected one is distinguishable from a
 * never-dispositioned one. */
export interface TranscriptInput {
  readonly seq: number;
  readonly id: string;
  readonly text: string;
  readonly mode: "queue" | "steer";
  /** The last disposition seen; "outstanding" until one arrives. Unlike
   * ChannelState.inputs (which resets a rejected input to outstanding and
   * removes an applied one), this records what actually last HAPPENED. */
  readonly status: "outstanding" | "queued" | "applied" | "rejected";
}

/** The conversation's rendered history: the ordered agent event stream and
 * the human input stream (both seq-stamped; interleave by seq), plus the
 * turnIds for which an abort-turn was emitted at a writer boundary. Seqs
 * are strictly-increasing, not contiguous (bookkeeping frames consume seqs
 * too, D-028). `aborted` is the raw abort signal, NOT a verdict: it
 * includes a clean detach's dangling turn and a takeover's aborted turn
 * alike, and the protocol cannot see turn completion, so a turn whose
 * `done` event is in `events` actually finished and its abort is a
 * host-reconciled no-op. Reconciling interrupted-vs-completed is the
 * renderer's job, against `done`. */
export interface Transcript {
  readonly events: readonly TranscriptEvent[];
  readonly inputs: readonly TranscriptInput[];
  readonly aborted: readonly string[];
}

const ctxOf = (presence: boolean | undefined): { presence?: Presence } =>
  presence === undefined ? {} : { presence: { processAlive: presence } };

/** Freeze a decoded event tree so the transcript shares no mutable state
 * with any caller (a mutation would diverge the live accumulator from a
 * post-reopen fold reconstruction). The tree is already plain JSON data
 * from the codec's round-trip, so a recursive freeze is total. */
const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
};

const applyEntry = (
  state: ChannelState,
  entry: LogEntry,
  secret: string,
): { result: ReduceResult; frame: Frame | null } => {
  switch (entry.src) {
    case "frame": {
      const raw = entry.frame.kind === "attach" ? { ...entry.frame, secret } : entry.frame;
      const decoded = decodeFrame(raw);
      if (decoded.verdict !== "ok")
        throw new StoreError("corrupt-log", `logged frame no longer decodes: ${decoded.issue}`);
      return {
        result: reduce(state, decoded.frame, entry.at, ctxOf(entry.presence)),
        frame: decoded.frame,
      };
    }
    case "input":
      return { result: enqueueInput(state, entry.input, entry.at), frame: null };
    case "credit":
      return { result: grantCredit(state, entry.tokens, entry.at), frame: null };
  }
};

/** Collect the render-visible history from one accepted transition: an
 * accepted event joins the ordered stream; an abort-turn effect marks its
 * turn superseded. Shared by fold (replay) and commit (live) so the
 * transcript is identical whether reconstructed or accumulated. */
interface TranscriptAcc {
  readonly events: TranscriptEvent[];
  readonly inputs: TranscriptInput[];
  readonly aborted: string[];
}

const collectTranscript = (
  acc: TranscriptAcc,
  entry: LogEntry,
  frameOrNull: Frame | null,
  result: ReduceResult,
): void => {
  if (result.verdict !== "accepted") return;
  if (frameOrNull?.kind === "event" && result.record.seq !== undefined)
    acc.events.push(
      deepFreeze({
        seq: result.record.seq,
        epoch: result.record.epoch,
        turnId: frameOrNull.turnId,
        event: frameOrNull.event,
      }),
    );
  if (entry.src === "input" && result.record.seq !== undefined)
    acc.inputs.push({
      seq: result.record.seq,
      id: entry.input.id,
      text: entry.input.text,
      mode: entry.input.mode,
      status: "outstanding",
    });
  if (frameOrNull?.kind === "disposition") {
    const at = acc.inputs.findIndex((i) => i.id === frameOrNull.inputId);
    if (at !== -1) {
      const prev = acc.inputs[at];
      if (prev !== undefined) acc.inputs[at] = { ...prev, status: frameOrNull.outcome };
    }
  }
  for (const effect of result.effects)
    if (effect.type === "abort-turn") acc.aborted.push(effect.turnId);
};

const NL = 0x0a;

/** Fold the log into state, BYTE-accurate (offsets feed truncate, and a
 * UTF-16 offset would cascade-delete good entries after non-ASCII
 * content). Pure over the bytes. The ONLY tolerated damage is a torn
 * trailing fragment with no newline (crash mid-append); a corrupt
 * newline-terminated line anywhere is corruption and throws. */
const foldLog = (
  conversationId: string,
  secret: string,
  raw: Buffer,
): {
  state: ChannelState;
  goodBytes: number;
  entries: number;
  transcript: TranscriptAcc;
} => {
  let state = initialChannelState({ conversationId, secret });
  let offset = 0;
  let entries = 0;
  const transcript: TranscriptAcc = { events: [], inputs: [], aborted: [] };
  while (offset < raw.length) {
    const nl = raw.indexOf(NL, offset);
    if (nl === -1) break; // torn trailing fragment: tolerated, repaired by caller
    const line = raw.toString("utf8", offset, nl);
    if (line.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (cause) {
        throw new StoreError("corrupt-log", `unparseable log line at byte ${offset}`, { cause });
      }
      if (!validEntry(parsed))
        throw new StoreError("corrupt-log", `malformed log entry at byte ${offset}`);
      const { result, frame } = applyEntry(state, parsed, secret);
      if (result.verdict !== "accepted")
        throw new StoreError(
          "fold-refused",
          `log entry at byte ${offset} refused on fold (${result.issue}): the log only holds accepted transitions`,
        );
      collectTranscript(transcript, parsed, frame, result);
      state = result.state;
      entries += 1;
    }
    offset = nl + 1;
  }
  return { state, goodBytes: offset, entries, transcript };
};

const HEX_SECRET = /^[0-9a-f]{16,}$/;

// ---------------------------------------------------------------------------
// Observability helpers (never throw into the transaction)
// ---------------------------------------------------------------------------

const emitAppend = (deps: HostDeps, event: AppendEvent): void => {
  try {
    deps.onAppendEvent?.(event);
  } catch {
    // observability must never corrupt the transaction
  }
};

// ---------------------------------------------------------------------------
// Durable write helpers (byte-accurate, loop on short writes)
// ---------------------------------------------------------------------------

/** Write the entire buffer to `fd`, looping on short returns. A partial
 * write is never counted complete - the caller must truncate on failure. */
const writeAllSync = (fd: number, buf: Buffer): void => {
  let off = 0;
  while (off < buf.length) {
    const n = writeSync(fd, buf, off, buf.length - off, null);
    if (n <= 0) throw new Error(`writeSync returned ${n} for ${buf.length - off} remaining`);
    off += n;
  }
};

// ---------------------------------------------------------------------------
// Record creation and opening
// ---------------------------------------------------------------------------

export const openConversation = (dir: string, deps: HostDeps) => {
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

  // Shared helper: read the log, fold it, and repair a torn trailing
  // fragment under the lock. The caller holds the lock, so the repair
  // is race-free. Reuses the existing `foldLog` - not a copy. A
  // torn-interior newline-terminated line under the lock will throw
  // corrupt-log (E002) directly from foldLog - it can only mean an
  // unlocked writer, so we do not catch it here.
  const readFoldRepair = (): { raw: Buffer; folded: ReturnType<typeof foldLog> } => {
    const raw: Buffer = existsSync(paths.logPath) ? readFileSync(paths.logPath) : Buffer.alloc(0);
    const folded = foldLog(conversationId, secret, raw);
    if (folded.goodBytes < raw.length) {
      try {
        truncateSync(paths.logPath, folded.goodBytes);
      } catch {
        // best-effort; in-memory goodBytes remains correct
      }
    }
    return { raw, folded };
  };

  // Establish initial state under the append lock so the offset and any
  // torn-tail repair are not races. A read-only viewer can use
  // `viewConversation` lock-free, but any handle that will append must
  // start from a lock-established offset.
  const { raw: initialRaw, folded: initialFolded } = (() => {
    const lock = acquireAppendLock(paths.lockPath, {
      label: conversationId,
      onEvent: deps.onLockEvent,
    });
    try {
      return readFoldRepair();
    } finally {
      lock.release();
    }
  })();

  const acc: TranscriptAcc = {
    events: [...initialFolded.transcript.events],
    inputs: [...initialFolded.transcript.inputs],
    aborted: [...initialFolded.transcript.aborted],
  };
  let curState = initialFolded.state;
  let curGoodBytes = initialFolded.goodBytes;

  deps.onRecord({
    verdict: "recovered",
    conversationId,
    entries: initialFolded.entries,
    discardedBytes: initialRaw.length - initialFolded.goodBytes,
    seq: curState.seq,
    epoch: curState.epoch,
  });

  // -----------------------------------------------------------------------
  // Append transaction (the M1.2 critical section)
  // -----------------------------------------------------------------------

  /** Run one transaction: acquire -> catch-up-fold -> reduce -> writeAll ->
   * fsync -> release. The reduce sees current state because the fold is
   * under the lock. Write loops on short returns; any write/fsync failure
   * truncates to the under-lock pre-write offset (never a stale open-time
   * offset) and raises append-failed (E005). A torn-interior line under
   * the lock throws corrupt-log (E002). */
  const transact = (
    produce: (s: ChannelState) => {
      entry: LogEntry | null;
      result: ReduceResult;
      frame: Frame | null;
    },
  ): ReduceResult => {
    const lock = acquireAppendLock(paths.lockPath, {
      label: conversationId,
      onEvent: deps.onLockEvent,
    });
    let preWriteOffset: number | undefined;
    try {
      // Catch-up-fold under the lock: re-read and re-fold so a second
      // writer's committed entry is visible before this reduce.
      const { folded } = readFoldRepair();
      // Adopt catch-up if the file grew (or shrank via repair).
      if (
        folded.goodBytes !== curGoodBytes ||
        folded.state.seq !== curState.seq ||
        folded.state.epoch !== curState.epoch
      ) {
        curState = folded.state;
        curGoodBytes = folded.goodBytes;
        acc.events.length = 0;
        acc.events.push(...folded.transcript.events);
        acc.inputs.length = 0;
        acc.inputs.push(...folded.transcript.inputs);
        acc.aborted.length = 0;
        acc.aborted.push(...folded.transcript.aborted);
      }

      preWriteOffset = curGoodBytes;
      emitAppend(deps, { event: "append.start", conversationId, offset: preWriteOffset });

      const { entry, result, frame } = produce(curState);

      // Refused (including wire-level) - no durability, but state still
      // advances for lease renewal and the boundary record is emitted.
      if (entry === null || result.verdict !== "accepted") {
        curState = result.state;
        // Even for refused, the reducer may have emitted effects that
        // the host must see (e.g. lease renewal), but transcript only
        // collects accepted transitions (see collectTranscript).
        for (const effect of result.effects) deps.onEffect(effect);
        deps.onRecord((result as unknown as { record: HostRecord }).record);
        emitAppend(deps, { event: "append.ok", conversationId, offset: preWriteOffset, bytes: 0 });
        return result;
      }

      // Accepted - durable commit: writeAll -> fsync, byte-accurate.
      const line = Buffer.from(`${JSON.stringify(entry)}\n`);
      const fd = openSync(paths.logPath, "a");
      let writeSucceeded = false;
      try {
        writeAllSync(fd, line);
        fsyncSync(fd);
        writeSucceeded = true;
      } catch (cause) {
        // Truncate to the under-lock pre-write offset (never a stale
        // open-time offset) and raise append-failed (E005).
        try {
          ftruncateSync(fd, preWriteOffset);
        } catch {
          try {
            truncateSync(paths.logPath, preWriteOffset);
          } catch {}
        }
        emitAppend(deps, {
          event: "append.failed",
          conversationId,
          offset: preWriteOffset,
          error: cause instanceof Error ? cause.message : String(cause),
        });
        throw new StoreError("append-failed", `could not append to ${paths.logPath}`, { cause });
      } finally {
        try {
          closeSync(fd);
        } catch {}
      }

      if (writeSucceeded) {
        curGoodBytes = preWriteOffset + line.length;
        curState = result.state;
        collectTranscript(acc, entry, frame, result);
        for (const effect of result.effects) deps.onEffect(effect);
        deps.onRecord(result.record);
        emitAppend(deps, {
          event: "append.ok",
          conversationId,
          offset: preWriteOffset,
          bytes: line.length,
        });
      }
      return result;
    } catch (e) {
      // Lock timeout (E001) and corrupt-log (E002) propagate as-is with
      // their typed codes. Append-failed (E005) is already wrapped.
      // Ensure a failed append does not also emit a spurious ok.
      if (e instanceof StoreError && e.code === "append-failed") throw e;
      if (
        preWriteOffset !== undefined &&
        !(e instanceof StoreError && e.code === "append-failed")
      ) {
        // For non-append failures after start, do not emit failed - the
        // start/ok pair already covers the non-durable path. Only write
        // failures emit failed (above).
      }
      throw e;
    } finally {
      lock.release();
    }
  };

  return {
    state: (): ChannelState => curState,
    close: (): void => {
      // No long-lived fd to close - per-transaction fds are closed
      // in transact. Kept for API compatibility.
    },
    transcript: (): Transcript => ({
      events: [...acc.events],
      inputs: [...acc.inputs],
      aborted: [...acc.aborted],
    }),
    status: (): ChannelStatus =>
      channelStatus(curState, deps.now(), { processAlive: deps.presence() === true }),

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
        // Wire-level refusal is not an append transaction - no lock, no
        // durability, just the boundary record and refused-send effect.
        deps.onRecord({
          verdict: "refused",
          wire: true,
          issue: decoded.issue,
          conversationId,
          now: at,
        });
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
      return transact((s) => {
        const result = reduce(s, decoded.frame, at, ctxOf(presence));
        return { entry, result, frame: decoded.frame };
      });
    },

    enqueueInput: (input: {
      readonly id: string;
      readonly text: string;
      readonly mode: "queue" | "steer";
      readonly turnId?: string;
    }): ReduceResult => {
      const at = deps.now();
      const entry: LogEntry = { v: 1, at, src: "input", input };
      return transact((s) => {
        const result = enqueueInput(s, input, at);
        return { entry, result, frame: null };
      });
    },

    grantCredit: (tokens: number): ReduceResult => {
      const at = deps.now();
      const entry: LogEntry = { v: 1, at, src: "credit", tokens };
      return transact((s) => {
        const result = grantCredit(s, tokens, at);
        return { entry, result, frame: null };
      });
    },
  };
};

/**
 * Lock-free view of a conversation's durable state. Tolerates a torn
 * trailing line (crash mid-append) without acquiring the append lock
 * and without repairing the file - the caller is a pure reader.
 * A fold that establishes an append offset or repairs must hold the
 * lock (see `openConversation`); this one is for `lucid watch` and
 * similar readers (M1.2: "a pure read-only viewer may fold lock-free").
 */
export const viewConversation = (
  dir: string,
): { state: ChannelState; transcript: Transcript; goodBytes: number } => {
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
  const raw: Buffer = existsSync(paths.logPath) ? readFileSync(paths.logPath) : Buffer.alloc(0);
  // Lock-free: fold tolerates torn trailing fragment (no throw, no truncate).
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

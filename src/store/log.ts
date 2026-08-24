/**
 * The conversation log: the deep module that owns the durable file.
 *
 * It owns the record layout (the file and its sibling `log.ndjson.lock`),
 * the byte-accurate offset, the fold, and the flock. No other module may
 * read, write, or truncate the log directly - all durability goes through
 * this seam. The store (the reducer host) calls into it with a pure
 * `reduce` closure; the log owns the locking, the catch-up re-fold, the
 * write-all loop, and the repair. What it is NOT: it does not know the
 * protocol's frame codecs beyond what `foldLog` needs to re-apply a
 * durable entry, and it does not emit effects or boundary records - the
 * store does that after a successful append.
 *
 * Depth comes from hiding the flock discipline: callers see `append`
 * as a single method, not `acquire -> catch-up -> reduce -> write`.
 * The deletion test passes: deleting this module would scatter byte
 * offsets, torn-tail handling, and flock retry across every writer.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readFileSync,
  truncateSync,
  writeSync,
} from "node:fs";
import type { ChannelState, InputMode, ProtocolIssue } from "../protocol/index.js";
import {
  decodeFrame,
  type Effect,
  enqueueInput,
  grantCredit,
  initialChannelState,
  type Presence,
  type ReduceResult,
  reduce,
} from "../protocol/index.js";
import { type RecordPaths, StoreError } from "./errors.js";
import { Flock, type LockEvent } from "./flock.js";

// ---------------------------------------------------------------------------
// Durable entry types (the log's own vocabulary)
// ---------------------------------------------------------------------------

/** One durable log entry: the verbatim input to `foldLog`. */
export type LogEntry =
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
        readonly mode: InputMode;
        readonly turnId?: string;
      };
    }
  | { readonly v: 1; readonly at: number; readonly src: "credit"; readonly tokens: number };

const ENTRY_SOURCES = ["frame", "input", "credit"] as const;

/** The envelope every entry carries, whatever its source. The fold checks
 * this much and no more before deciding whether it knows the source:
 * RFC-04 P1 makes an envelope-valid entry with an unrecognised `src`
 * skippable rather than corrupt, so the log vocabulary can grow without
 * making records written by a newer build unopenable. */
interface Envelope {
  readonly v: 1;
  readonly at: number;
  readonly src: string;
}

const validEntry = (raw: unknown): raw is Envelope => {
  if (typeof raw !== "object" || raw === null) return false;
  const e = raw as Record<string, unknown>;
  return (
    e.v === 1 &&
    typeof e.at === "number" &&
    Number.isSafeInteger(e.at) &&
    e.at >= 0 &&
    typeof e.src === "string"
  );
};

/** Narrow an envelope-valid entry to a source this build knows how to
 * fold. The payload is trusted exactly as far as `applyEntry` re-checks
 * it - the same contract the pre-P1 guard had. */
const knownEntry = (e: Envelope): e is LogEntry =>
  (ENTRY_SOURCES as readonly string[]).includes(e.src);

/** A durable input entry the reducer refused on the fold: carried (its
 * bytes count as good, later entries still fold), never applied, and
 * reported here rather than dropped. RFC-05 B4: the fold is where this
 * build meets payloads only a newer build understands - an input mode
 * this build does not know is the first of them, and refusing it MUST
 * NOT brick the record the way a refused frame entry still does. */
export interface FoldRefusal {
  readonly offset: number;
  readonly issue: ProtocolIssue;
}

// ---------------------------------------------------------------------------
// Delivery cursor (RFC-04 R3/R4, step 7)
// ---------------------------------------------------------------------------

/** The cursor entry is an ordinary log line, so it carries the same
 * envelope every entry does (`v`, `at`, `src`). Its `offset` is the
 * byte offset up to which the holder has finished dispatching — that is,
 * `goodBytes` at the time the cursor was written. An effect's identity
 * is the starting offset of the entry that produced it, so "have I
 * already done this" is "is its offset < cursor". */
export interface CursorEntry {
  readonly v: 1;
  readonly at: number;
  readonly src: "cursor";
  readonly offset: number;
}

const _isCursorEnvelope = (e: Envelope): boolean => e.src === "cursor";

const validCursorOffset = (raw: unknown): boolean => {
  if (typeof raw !== "object" || raw === null) return false;
  const o = (raw as Record<string, unknown>).offset;
  return typeof o === "number" && Number.isSafeInteger(o) && o >= 0;
};

/** Scan the good prefix of `raw` for cursor entries and return the
 * greatest offset among them, or 0 if none. A cursor whose offset is
 * past `goodBytes` is corruption: the holder claims to have dispatched
 * effects that are not in the good log, so a successor must refuse to
 * drive rather than reset and repeat from an unknown point. A torn
 * trailing cursor sits behind `goodBytes` and is not scanned — it reads
 * as an earlier cursor, and the repeat is absorbed by the dedup check. */
export const scanCursor = (raw: Buffer, goodBytes: number): number => {
  let cursor = 0;
  let offset = 0;
  while (offset < goodBytes) {
    const nl = raw.indexOf(NL, offset);
    if (nl === -1) break;
    // Only scan within the good prefix; torn tail is not good.
    if (nl + 1 > goodBytes) break;
    const line = raw.toString("utf8", offset, nl);
    if (line.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // foldLog would have thrown for unparseable line; cursor scan
        // is only called on good bytes, so this is unreachable — but
        // tolerate it as non-cursor rather than throwing a second error.
        offset = nl + 1;
        continue;
      }
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as Record<string, unknown>).src === "cursor"
      ) {
        // Envelope must be valid, otherwise the fold would have thrown
        // corrupt-log — treat same here.
        if (!validEntry(parsed)) {
          throw new StoreError("corrupt-log", `malformed log entry at byte ${offset}`);
        }
        if (!validCursorOffset(parsed)) {
          throw new StoreError("corrupt-log", `malformed cursor entry at byte ${offset}`);
        }
        const off = (parsed as CursorEntry).offset;
        if (off > goodBytes) {
          throw new StoreError(
            "corrupt-log",
            `cursor at byte ${offset} claims offset ${off} past good log end ${goodBytes}`,
          );
        }
        if (off > cursor) cursor = off;
      }
    }
    offset = nl + 1;
  }
  return cursor;
};

// ---------------------------------------------------------------------------
// Transcript (rendered history) - re-exported via store.ts for stability
// ---------------------------------------------------------------------------

export interface TranscriptEvent {
  readonly seq: number;
  readonly epoch: number;
  readonly turnId: string;
  readonly event: Record<string, unknown>;
}

export interface TranscriptInput {
  readonly seq: number;
  readonly id: string;
  readonly text: string;
  readonly mode: InputMode;
  readonly status: "outstanding" | "queued" | "applied" | "rejected";
}

export interface Transcript {
  readonly events: readonly TranscriptEvent[];
  readonly inputs: readonly TranscriptInput[];
  readonly aborted: readonly string[];
}

// ---------------------------------------------------------------------------
// Collected effects (RFC-04 step 5)
// ---------------------------------------------------------------------------

/** One entry's effects paired with the byte offset that produced them.
 * The offset is the entry's starting byte in log.ndjson — stable, ordered,
 * and already unique, so RFC-04 R4 can use it as the effect's identity
 * without a second structure. Effects are collected under the append lock
 * and returned, never dispatched inside the lock (a harness write appends,
 * so dispatching there would deadlock against the held lock). */
export interface CollectedEntry {
  readonly offset: number;
  readonly effects: readonly Effect[];
}

export interface CollectedBatch {
  readonly state: ChannelState;
  readonly transcript: Transcript;
  readonly goodBytes: number;
  /** In log order. A caller that wants each effect on its own flattens
   * this; a caller that advances a cursor per entry does not. */
  readonly entries: readonly CollectedEntry[];
}

interface TranscriptAcc {
  readonly events: TranscriptEvent[];
  readonly inputs: TranscriptInput[];
  readonly aborted: string[];
}

// ---------------------------------------------------------------------------
// Append observability
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Pure helpers (no I/O)
// ---------------------------------------------------------------------------

const _REDACTED = "redacted";

const ctxOf = (presence: boolean | undefined): { presence?: Presence } =>
  presence === undefined ? {} : { presence: { processAlive: presence } };

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
): { result: ReduceResult; frame: import("../protocol/index.js").Frame | null } => {
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

const collectTranscript = (
  acc: TranscriptAcc,
  entry: LogEntry,
  frameOrNull: import("../protocol/index.js").Frame | null,
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

/** Fold the log into state, byte-accurate. Three things are tolerated: a
 * torn trailing fragment (no newline), an envelope-valid entry whose
 * `src` this build does not recognise - RFC-04 P1: its bytes count as
 * read and its content contributes nothing - and a durable input entry
 * the reducer refuses (RFC-05 B4: an input mode only a newer build
 * knows is carried and reported through `refusedInputs`, never applied
 * and never fatal). Anything else corrupt throws. */
export const foldLog = (
  conversationId: string,
  secret: string,
  raw: Buffer,
): {
  state: ChannelState;
  goodBytes: number;
  entries: number;
  transcript: TranscriptAcc;
  refusedInputs: readonly FoldRefusal[];
} => {
  let state = initialChannelState({ conversationId, secret });
  let offset = 0;
  let entries = 0;
  const transcript: TranscriptAcc = { events: [], inputs: [], aborted: [] };
  const refusedInputs: FoldRefusal[] = [];
  while (offset < raw.length) {
    const nl = raw.indexOf(NL, offset);
    if (nl === -1) break;
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
      if (knownEntry(parsed)) {
        const { result, frame } = applyEntry(state, parsed, secret);
        if (result.verdict !== "accepted") {
          // lucid appends only entries its own reducer accepted, so a
          // refused FRAME or CREDIT entry is log/reducer disagreement -
          // corruption, and fatal. A refused INPUT entry is different:
          // it is a payload a newer build understood and this one does
          // not (RFC-05 B4), so it is carried - state advances to the
          // refusal's (unchanged) state, its bytes count as read - and
          // the refusal is reported, not thrown.
          if (parsed.src !== "input")
            throw new StoreError(
              "fold-refused",
              `log entry at byte ${offset} refused on fold (${result.issue})`,
            );
          refusedInputs.push({ offset, issue: result.issue });
          state = result.state;
        } else {
          collectTranscript(transcript, parsed, frame, result);
          state = result.state;
          entries += 1;
        }
      }
    }
    // An unrecognised src is carried, not applied: the offset advances
    // past its bytes either way, so a later entry still folds.
    offset = nl + 1;
  }
  return { state, goodBytes: offset, entries, transcript, refusedInputs };
};

// ---------------------------------------------------------------------------
// Pure collecting fold (RFC-04 step 5)
// ---------------------------------------------------------------------------

/** Pure fold that also collects per-entry effects. The state evolution is
 * identical to `foldLog`: an envelope-valid entry with an unrecognised
 * `src` is carried (bytes counted, no state change, no effects), and a
 * reducer refusal contributes no effects but still advances the state to
 * the refusal's state so a later entry folds against the right snapshot.
 * Refused INPUT entries are reported through `refusedInputs` exactly as
 * `foldLog` reports them - this is the same fold, not a second policy
 * (RFC-05 B4).
 * Only accepted entries with non-empty effects that start at or after
 * `fromOffset` are emitted, in log order. Does no I/O, takes no lock. */
export const foldCollect = (
  conversationId: string,
  secret: string,
  raw: Buffer,
  fromOffset = 0,
): {
  state: ChannelState;
  goodBytes: number;
  entries: number;
  transcript: TranscriptAcc;
  collected: CollectedEntry[];
  refusedInputs: readonly FoldRefusal[];
} => {
  let state = initialChannelState({ conversationId, secret });
  let offset = 0;
  let entries = 0;
  const transcript: TranscriptAcc = { events: [], inputs: [], aborted: [] };
  const collected: CollectedEntry[] = [];
  const refusedInputs: FoldRefusal[] = [];
  while (offset < raw.length) {
    const nl = raw.indexOf(NL, offset);
    if (nl === -1) break;
    const line = raw.toString("utf8", offset, nl);
    const entryOffset = offset;
    if (line.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (cause) {
        throw new StoreError("corrupt-log", `unparseable log line at byte ${offset}`, { cause });
      }
      if (!validEntry(parsed))
        throw new StoreError("corrupt-log", `malformed log entry at byte ${offset}`);
      if (knownEntry(parsed)) {
        const { result, frame } = applyEntry(state, parsed, secret);
        if (result.verdict === "accepted") {
          collectTranscript(transcript, parsed, frame, result);
          state = result.state;
          entries += 1;
          if (entryOffset >= fromOffset && result.effects.length > 0) {
            collected.push({
              offset: entryOffset,
              effects: Object.freeze([...result.effects]) as readonly Effect[],
            });
          }
        } else {
          // Refused entry contributes no effects and no transcript, but
          // its state still advances so the next entry folds correctly.
          // Never counted as an accepted entry: foldLog throws for a
          // refused FRAME or CREDIT entry and carries a refused INPUT one
          // (RFC-05 B4) - and reports it, as here.
          if (parsed.src === "input")
            refusedInputs.push({ offset: entryOffset, issue: result.issue });
          state = result.state;
        }
      }
    }
    offset = nl + 1;
  }
  return { state, goodBytes: offset, entries, transcript, collected, refusedInputs };
};

/** Convenience pure helper returning the same shape `foldLog` would but
 * with collected effects included. Thin alias over `foldCollect`. */

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

const writeAllSync = (fd: number, buf: Buffer): void => {
  let off = 0;
  while (off < buf.length) {
    const n = writeSync(fd, buf, off, buf.length - off, null);
    if (n <= 0) throw new Error(`writeSync returned ${n} for ${buf.length - off} remaining`);
    off += n;
  }
};

// ---------------------------------------------------------------------------
// The locked read (offered to the tailer; RFC-04 R1)
// ---------------------------------------------------------------------------

const readFoldRepair = (
  paths: RecordPaths,
  conversationId: string,
  secret: string,
): { raw: Buffer; folded: ReturnType<typeof foldLog> } => {
  const raw: Buffer = existsSync(paths.logPath) ? readFileSync(paths.logPath) : Buffer.alloc(0);
  const folded = foldLog(conversationId, secret, raw);
  if (folded.goodBytes < raw.length) {
    try {
      truncateSync(paths.logPath, folded.goodBytes);
    } catch {
      // best-effort
    }
  }
  return { raw, folded };
};

/** Shared append-lock wrapper — the single place the lock is acquired
 * for any locked read. Both `foldUnderAppendLock` (the tailer's read)
 * and `collectEffectsUnderAppendLock` (the range fold) go through here,
 * so there is one lock path, not two (ticket: reuse, not duplicate). */
const withAppendLock = <T>(
  paths: RecordPaths,
  conversationId: string,
  opts: { onLockEvent?: (e: LockEvent) => void },
  fn: () => T,
): T => {
  const flock = new Flock(paths.lockPath, conversationId);
  const lock = flock.acquire({ onEvent: opts.onLockEvent });
  try {
    return fn();
  } finally {
    lock.release();
  }
};

/** Read the log under the append lock: fold every good byte and repair a
 * torn trailing fragment - `append`'s catch-up discipline offered to
 * readers that act on what they read. The tailer's locked read (RFC-04
 * R1): a caller MUST NOT act on a tail it only peeked, because the
 * lock-free peek tolerates a torn trailing line without repairing it. */
export const foldUnderAppendLock = (
  paths: RecordPaths,
  conversationId: string,
  secret: string,
  opts: { onLockEvent?: (e: LockEvent) => void } = {},
): { state: ChannelState; transcript: Transcript; goodBytes: number } =>
  withAppendLock(paths, conversationId, opts, () => {
    const { raw, folded } = readFoldRepair(paths, conversationId, secret);
    // Cursor ahead of goodBytes is corruption — refuse to drive
    scanCursor(raw, folded.goodBytes);
    return {
      state: folded.state,
      transcript: {
        events: [...folded.transcript.events],
        inputs: [...folded.transcript.inputs],
        aborted: [...folded.transcript.aborted],
      },
      goodBytes: folded.goodBytes,
    };
  });

/** Collect the effects produced by log entries at or after `fromOffset`,
 * under the append lock. Reuses the same `readFoldRepair` discipline
 * `foldUnderAppendLock` does (and `append`'s catch-up does): the file is
 * read and folded while holding the flock, a torn trailing fragment is
 * repaired, and the lock is released before effects are returned — never
 * dispatched inside the lock, so a harness write (which appends) cannot
 * deadlock against it. The pure fold is `foldCollect`; this is its
 * locked I/O wrapper, not a second fold path. */
export const collectEffectsUnderAppendLock = (
  paths: RecordPaths,
  conversationId: string,
  secret: string,
  fromOffset: number,
  opts: { onLockEvent?: (e: LockEvent) => void } = {},
): CollectedBatch =>
  withAppendLock(paths, conversationId, opts, () => {
    const raw: Buffer = (() => {
      try {
        return readFileSync(paths.logPath);
      } catch {
        return Buffer.alloc(0);
      }
    })();
    // Use the collecting fold directly so we do not pay for a second pass,
    // but keep the repair discipline identical: fold, then truncate a torn
    // tail under the same lock.
    const { state, goodBytes, transcript, collected } = foldCollect(
      conversationId,
      secret,
      raw,
      fromOffset,
    );
    if (goodBytes < raw.length) {
      try {
        truncateSync(paths.logPath, goodBytes);
      } catch {}
    }
    // Cursor ahead of goodBytes is corruption — refuse to drive.
    // Scan only the good prefix, so a torn trailing cursor is not seen.
    scanCursor(raw, goodBytes);
    return {
      state,
      transcript: {
        events: [...transcript.events],
        inputs: [...transcript.inputs],
        aborted: [...transcript.aborted],
      },
      goodBytes,
      entries: collected as readonly CollectedEntry[],
    };
  });

// ---------------------------------------------------------------------------
// ConversationLog - the deep module
// ---------------------------------------------------------------------------

export interface LogDeps {
  readonly onLockEvent?: (e: LockEvent) => void;
  readonly onAppendEvent?: (e: AppendEvent) => void;
}

export interface ConversationLog {
  readonly paths: RecordPaths;
  readonly conversationId: string;
  state(): ChannelState;
  transcript(): Transcript;
  goodBytes(): number;
  /** The delivery cursor: the offset up to which effects have been
   * dispatched (RFC-04 R4). 0 if no cursor has been written. A cursor
   * whose offset is past `goodBytes` is corruption — the log claims
   * effects were dispatched that are not in the good log, so a successor
   * must refuse to drive rather than reset and repeat. */
  cursor(): number;
  /** Durably advance the delivery cursor to `offset`. The cursor is an
   * ordinary log entry (`{v:1, at, src:"cursor", offset}`), so it is
   * ordered against the entries it describes and fsynced. MUST be called
   * only after every effect at or before `offset` has been acted on —
   * writing it first would make a crash in the gap at-most-once (the
   * inverse of the guarantee). The offset must be \u2264 current
   * `goodBytes` at the time of the write; otherwise it would be a
   * cursor-ahead corruption. */
  advanceCursor(offset: number, at: number): void;
  /** Append via the lock-wrapped transaction. The `produce` closure is
   * called under the lock after the catch-up fold, so the reduce sees
   * current state. */
  append(
    produce: (state: ChannelState) => {
      entry: LogEntry | null;
      result: ReduceResult;
      frame: import("../protocol/index.js").Frame | null;
    },
  ): ReduceResult;
  /** Fold the log under the append lock and collect the effects produced
   * by entries at or after `fromOffset`, in log order. Each effect is
   * paired with the byte offset of the entry that produced it (RFC-04 R4:
   * the offset is the effect's identity). Unknown-source entries and
   * reducer-refused entries contribute no effects. The fold reuses the
   * same lock and repair discipline as `append`'s catch-up; effects are
   * returned, never dispatched inside the lock (a harness write appends,
   * so dispatching there would deadlock). */
  collectEffects(fromOffset: number): CollectedBatch;
  /** Lock-free view (tolerates torn trailing, does not repair). */
  view(): { state: ChannelState; transcript: Transcript; goodBytes: number };
  close(): void;
  /** Recovery info from the initial fold (for the store's boundary record). */
  recovery(): { entries: number; discardedBytes: number; refusedInputs: number };
}

export const createLog = (
  paths: RecordPaths,
  secret: string,
  conversationId: string,
  deps: LogDeps,
): ConversationLog => {
  const emitAppend = (event: AppendEvent): void => {
    try {
      deps.onAppendEvent?.(event);
    } catch {
      // observability must never corrupt the transaction
    }
  };

  // Establish initial state under the append lock, and validate
  // the delivery cursor (RFC-04: cursor past goodBytes is corruption).
  const {
    raw: initialRaw,
    folded: initialFolded,
    cursor: initialCursor,
  } = (() => {
    const flock = new Flock(paths.lockPath, conversationId);
    const lock = flock.acquire({ onEvent: deps.onLockEvent });
    try {
      const { raw, folded } = readFoldRepair(paths, conversationId, secret);
      const cursor = scanCursor(raw, folded.goodBytes);
      return { raw, folded, cursor };
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
  let curCursor = initialCursor;
  const recoveredEntries = initialFolded.entries;
  const discardedBytes = initialRaw.length - initialFolded.goodBytes;
  const refusedInputs = initialFolded.refusedInputs.length;

  // Expose recovery info for the store to emit
  const recovery = {
    entries: recoveredEntries,
    discardedBytes,
    refusedInputs,
    seq: curState.seq,
    epoch: curState.epoch,
  };

  const append: ConversationLog["append"] = (produce) => {
    const flock = new Flock(paths.lockPath, conversationId);
    const lock = flock.acquire({ onEvent: deps.onLockEvent });
    let preWriteOffset: number | undefined;
    try {
      const { raw: refreshedRaw, folded } = readFoldRepair(paths, conversationId, secret);
      curCursor = scanCursor(refreshedRaw, folded.goodBytes);
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
      emitAppend({ event: "append.start", conversationId, offset: preWriteOffset });

      const { entry, result, frame } = produce(curState);

      if (entry === null || result.verdict !== "accepted") {
        curState = result.state;
        emitAppend({ event: "append.ok", conversationId, offset: preWriteOffset, bytes: 0 });
        return result;
      }

      const line = Buffer.from(`${JSON.stringify(entry)}\n`);
      const fd = openSync(paths.logPath, "a");
      let writeSucceeded = false;
      try {
        writeAllSync(fd, line);
        fsyncSync(fd);
        writeSucceeded = true;
      } catch (cause) {
        try {
          ftruncateSync(fd, preWriteOffset);
        } catch {
          try {
            truncateSync(paths.logPath, preWriteOffset);
          } catch {}
        }
        emitAppend({
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
        emitAppend({
          event: "append.ok",
          conversationId,
          offset: preWriteOffset,
          bytes: line.length,
        });
      }
      return result;
    } catch (e) {
      if (e instanceof StoreError && e.code === "append-failed") throw e;
      throw e;
    } finally {
      lock.release();
    }
  };

  const view: ConversationLog["view"] = () => {
    const raw: Buffer = existsSync(paths.logPath) ? readFileSync(paths.logPath) : Buffer.alloc(0);
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

  const collectEffects: ConversationLog["collectEffects"] = (fromOffset) => {
    const batch = collectEffectsUnderAppendLock(paths, conversationId, secret, fromOffset, {
      onLockEvent: deps.onLockEvent,
    });
    // Refresh cursor from the same raw the batch saw — collectEffectsUnderAppendLock
    // already validated torn tail, but need cursor scan. Re-read raw for cursor.
    try {
      const raw = readFileSync(paths.logPath);
      curCursor = scanCursor(raw, batch.goodBytes);
    } catch {}
    // Keep the host's cached snapshot consistent with what the locked fold
    // just saw, so a subsequent state()/transcript() call does not go stale
    // after another process appended.
    curState = batch.state;
    curGoodBytes = batch.goodBytes;
    acc.events.length = 0;
    acc.events.push(...batch.transcript.events);
    acc.inputs.length = 0;
    acc.inputs.push(...batch.transcript.inputs);
    acc.aborted.length = 0;
    acc.aborted.push(...batch.transcript.aborted);
    return batch;
  };

  const cursor: ConversationLog["cursor"] = () => curCursor;

  const advanceCursor: ConversationLog["advanceCursor"] = (offset, at) => {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new StoreError(
        "corrupt-log",
        `cursor offset must be a non-negative safe integer, got ${offset}`,
      );
    }
    const flock = new Flock(paths.lockPath, conversationId);
    const lock = flock.acquire({ onEvent: deps.onLockEvent });
    try {
      const { raw, folded } = readFoldRepair(paths, conversationId, secret);
      // Validate existing cursor before advancing — corruption must be reported
      const current = scanCursor(raw, folded.goodBytes);
      curCursor = current;
      curState = folded.state;
      curGoodBytes = folded.goodBytes;
      acc.events.length = 0;
      acc.events.push(...folded.transcript.events);
      acc.inputs.length = 0;
      acc.inputs.push(...folded.transcript.inputs);
      acc.aborted.length = 0;
      acc.aborted.push(...folded.transcript.aborted);

      if (offset > folded.goodBytes) {
        throw new StoreError(
          "corrupt-log",
          `cursor advance to ${offset} past good log end ${folded.goodBytes}`,
        );
      }
      // Monotonicity is not strictly required for safety (going back
      // just repeats), but advancing past goodBytes is always wrong.
      // Allow idempotent re-advance to same offset.
      if (offset < curCursor) {
        // Going backwards is allowed but wasteful — still write? No, just return
        // without writing, since the later cursor already covers this.
        return;
      }
      if (offset === curCursor && offset !== 0) {
        // Already at this cursor — check if a cursor entry at this offset
        // already exists at the tail to avoid duplicate lines? Still
        // idempotent: no need to write again.
        // But if curCursor came from scan, there is already a cursor entry
        // for it. We can skip writing to avoid duplicate cursor lines.
        // To decide, scan tail for duplicate — simpler to just skip.
        return;
      }

      const entry: CursorEntry = { v: 1, at, src: "cursor", offset };
      const line = Buffer.from(`${JSON.stringify(entry)}\n`);
      const fd = openSync(paths.logPath, "a");
      let writeSucceeded = false;
      try {
        writeAllSync(fd, line);
        fsyncSync(fd);
        writeSucceeded = true;
      } catch (cause) {
        try {
          ftruncateSync(fd, folded.goodBytes);
        } catch {}
        try {
          truncateSync(paths.logPath, folded.goodBytes);
        } catch {}
        throw new StoreError("append-failed", `could not advance cursor to ${offset}`, { cause });
      } finally {
        try {
          closeSync(fd);
        } catch {}
      }
      if (writeSucceeded) {
        curGoodBytes = folded.goodBytes + line.length;
        curCursor = offset;
      }
    } finally {
      lock.release();
    }
  };

  return {
    paths,
    conversationId,
    state: () => curState,
    transcript: () => ({
      events: [...acc.events],
      inputs: [...acc.inputs],
      aborted: [...acc.aborted],
    }),
    goodBytes: () => curGoodBytes,
    cursor,
    advanceCursor,
    append,
    collectEffects,
    view,
    close: () => {},
    recovery: () => ({
      entries: recovery.entries,
      discardedBytes: recovery.discardedBytes,
      refusedInputs: recovery.refusedInputs,
    }),
  };
};

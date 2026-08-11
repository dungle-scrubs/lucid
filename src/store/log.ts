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
import type { ChannelState } from "../protocol/index.js";
import {
  decodeFrame,
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
  readonly mode: "queue" | "steer";
  readonly status: "outstanding" | "queued" | "applied" | "rejected";
}

export interface Transcript {
  readonly events: readonly TranscriptEvent[];
  readonly inputs: readonly TranscriptInput[];
  readonly aborted: readonly string[];
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

/** Fold the log into state, byte-accurate. Only a torn trailing fragment
 * (no newline) is tolerated; a corrupt newline-terminated line throws. */
export const foldLog = (
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
      const { result, frame } = applyEntry(state, parsed, secret);
      if (result.verdict !== "accepted")
        throw new StoreError(
          "fold-refused",
          `log entry at byte ${offset} refused on fold (${result.issue})`,
        );
      collectTranscript(transcript, parsed, frame, result);
      state = result.state;
      entries += 1;
    }
    offset = nl + 1;
  }
  return { state, goodBytes: offset, entries, transcript };
};

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
  /** Lock-free view (tolerates torn trailing, does not repair). */
  view(): { state: ChannelState; transcript: Transcript; goodBytes: number };
  close(): void;
  /** Recovery info from the initial fold (for the store's boundary record). */
  recovery(): { entries: number; discardedBytes: number };
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

  const readFoldRepair = (): { raw: Buffer; folded: ReturnType<typeof foldLog> } => {
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

  // Establish initial state under the append lock
  const { raw: initialRaw, folded: initialFolded } = (() => {
    const flock = new Flock(paths.lockPath, conversationId);
    const lock = flock.acquire({ onEvent: deps.onLockEvent });
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
  const recoveredEntries = initialFolded.entries;
  const discardedBytes = initialRaw.length - initialFolded.goodBytes;

  // Expose recovery info for the store to emit
  const recovery = {
    entries: recoveredEntries,
    discardedBytes,
    seq: curState.seq,
    epoch: curState.epoch,
  };

  const append: ConversationLog["append"] = (produce) => {
    const flock = new Flock(paths.lockPath, conversationId);
    const lock = flock.acquire({ onEvent: deps.onLockEvent });
    let preWriteOffset: number | undefined;
    try {
      const { folded } = readFoldRepair();
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
    append,
    view,
    close: () => {},
    recovery: () => ({ entries: recovery.entries, discardedBytes: recovery.discardedBytes }),
  };
};

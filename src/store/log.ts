import { createReadStream } from "node:fs";
import { initializeNaming } from "./conversation-naming.js";
import { pathsForDir } from "./errors.js";
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

import { createHash } from "node:crypto";
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
import { reduceContextCoverage } from "../protocol/context-coverage.js";
import { reduceExecution } from "../protocol/execution.js";
import { ARTIFACT_BYTES_MAX } from "../protocol/frames.js";
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
import { enqueueManagedInput } from "../protocol/reducer.js";
import { putBlob } from "./blobs.js";
import { type RecordPaths, StoreError } from "./errors.js";
import type { LockEvent } from "./flock.js";

import { withRecordLock } from "./record-identity.js";

// ---------------------------------------------------------------------------
// Durable entry types (the log's own vocabulary)
// ---------------------------------------------------------------------------

/** One durable log entry: the verbatim input to `foldLog`. */
export type LogEntry =
  | CursorEntry
  | {
      readonly v: 1;
      readonly at: number;
      readonly src: "execution";
      readonly payloadVersion: 1;
      readonly fact: import("../protocol/execution.js").ExecutionFact;
    }
  | {
      readonly v: 1;
      readonly at: number;
      readonly src: "context";
      readonly payloadVersion: 1;
      readonly fact: import("../protocol/context-coverage.js").ContextFact;
    }
  | {
      readonly v: 1;
      readonly at: number;
      readonly src: "managed-input";
      readonly namingEligible: true;
      readonly payloadVersion: 1;
      readonly input: { readonly id: string; readonly text: string; readonly mode: "queue" };
      readonly intent: { readonly kind: "requested"; readonly attempt: 0 };
    }
  | {
      readonly v: 1;
      readonly at: number;
      readonly src: "frame";
      readonly ownersDeparted?: true;
      readonly frame: Record<string, unknown>;
      readonly presence?: boolean;
      readonly owner?: import("../protocol/process-owner.js").ProcessOwner;
    }
  | {
      readonly v: 1;
      readonly at: number;
      readonly src: "input";
      readonly namingEligible?: true;
      readonly input: {
        readonly id: string;
        readonly text: string;
        readonly mode: InputMode;
        readonly turnId?: string;
      };
    }
  | { readonly v: 1; readonly at: number; readonly src: "credit"; readonly tokens: number }
  | {
      readonly v: 1;
      readonly at: number;
      readonly src: "artifact";
      readonly artifactId: string;
      readonly version: number;
      readonly author: string;
      readonly contentType: string;
      readonly hash: string;
      readonly bytes: string;
      /** The version this one was working from. Present on a save; absent on
       * an agent emission. A save based on a version since replaced is
       * accepted and records what it was working from — the agent
       * reconciles, lucid does not merge. */
      readonly basedOn?: number;
      /** Values of the controls the agent authored, at save time. Ticking a
       * box and rewriting a sentence are different acts, and neither form
       * expresses the other, so the document and this both travel. */
      readonly values?: Readonly<Record<string, string>>;
    }
  /** A fact about an artifact rather than about one of its versions.
   *
   * Naming a document is not a change to the document, so it must not
   * create a version of it: a rename that appended a version would put a
   * second copy of the bytes in the log and move `replaces` under the agent
   * mid-conversation.
   *
   * `artifactId` never moves. It is identity in two places - the agent names
   * it to revise, and every annotation batch carries it - so changing it
   * would orphan existing notes and break the next revision (RFC-07 R11). */
  | {
      readonly v: 1;
      readonly at: number;
      readonly src: "artifact-meta";
      readonly artifactId: string;
      /** What the page displays. Absent means the page displays the id. */
      readonly title?: string;
      /** RFC-07 R12, withdrawn by RFC-09. Kept on the type so a record
       * written while retire existed still describes itself, and so nobody
       * re-adds the field thinking it is new. Nothing reads it: the fold
       * ignores it, and an artifact that carries it behaves as though it
       * were never retired. */
      readonly retired?: boolean;
    }
  /** A file a person attached (RFC-11). The bytes are NOT here: they are a
   * blob beside the log, at `files/<hash>`, and this names it.
   *
   * Measured, not assumed. Folding a 67 MB log costs 19 ms and 335 MB of
   * resident memory, because a fold holds what it reads. Time is not the
   * problem; memory is. */
  | {
      readonly v: 1;
      readonly at: number;
      readonly src: "attach";
      /** sha256 hex of the blob, lowercase. The blob's name. */
      readonly hash: string;
      /** Size of the blob in bytes. */
      readonly bytes: number;
      /** As received from the browser. A claim, not evidence. */
      readonly contentType: string;
      /** What the person called it. */
      readonly name: string;
      /** Whether the bytes may be inlined into an input. Decided on the
       * bytes when the file arrives, and recorded so the decision is not
       * re-made differently later. */
      readonly text: boolean;
    };

const ENTRY_SOURCES = [
  "execution",
  "context",
  "frame",
  "input",
  "managed-input",
  "credit",
  "artifact",
  "artifact-meta",
  "attach",
  "cursor",
] as const;

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
// Artifact versions (RFC-06 storage) — the bytes live in their own entry kind
// ---------------------------------------------------------------------------

import { isArtifactTitle } from "../protocol/artifact-title.js";

export { ARTIFACT_TITLE_MAX, isArtifactTitle } from "../protocol/artifact-title.js";

/** RFC-06: an artifact is capped at 1 MB, the same bound TEXT_MAX guards. */
export { ARTIFACT_BYTES_MAX } from "../protocol/frames.js";

/** One stored version of an artifact — the bytes and their hash. */
export interface ArtifactVersion {
  readonly artifactId: string;
  readonly version: number;
  readonly author: string;
  readonly contentType: string;
  readonly hash: string;
  readonly bytes: string;
  readonly at: number;
  readonly basedOn?: number;
  readonly values?: Readonly<Record<string, string>>;
}

/** Hash of artifact bytes: sha256 hex, written for every version from the first. */
export const hashArtifactBytes = (bytes: string): string =>
  createHash("sha256").update(bytes, "utf8").digest("hex");

/** Wire-safe field: non-empty, <=128, no control chars — mirrors isWireId. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: artifact fields must not contain control chars — mirrors frames.ts guard
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
export const isArtifactField = (v: unknown): boolean =>
  typeof v === "string" && v.length > 0 && v.length <= 128 && !CONTROL_CHARS.test(v);

/**
 * The rule the fold applies to an `artifactId`, exported so that anything
 * accepting one from outside applies the same rule and not a different one.
 *
 * Deliberately NOT `validConversationId`. That is a path-safe alphabet,
 * because a conversation id names a directory. An artifact id names nothing
 * on disk - it is an index key - and it is far wider: `plan/日本語` is a
 * valid artifact id that the fold indexes today and that
 * `validConversationId` rejects. Checking one with the other would hide
 * artifacts the record already holds.
 */
export const validArtifactId = (v: unknown): boolean => isArtifactField(v);
const isHashHex = (v: unknown): boolean => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

/** Key for the (artifactId, version) -> offset index. \0 is safe because ids have no control chars. */
export interface VersionHeader {
  readonly afterSeq: number;
  readonly at: number;
  readonly author: string;
  readonly basedOn?: number;
  readonly offset: number;
}
export type ArtifactVersions = ReadonlyMap<string, ReadonlyMap<number, VersionHeader>>;
const copyVersions = (versions: ArtifactVersions): Map<string, Map<number, VersionHeader>> =>
  new Map([...versions].map(([id, rows]) => [id, new Map(rows)]));
const indexVersion = (
  versions: Map<string, Map<number, VersionHeader>>,
  heads: Map<string, number>,
  artifactId: string,
  version: number,
  header: VersionHeader,
): void => {
  let rows = versions.get(artifactId);
  if (rows === undefined) {
    rows = new Map();
    versions.set(artifactId, rows);
  }
  if (rows.has(version)) return;
  rows.set(version, Object.freeze(header));
  heads.set(artifactId, Math.max(heads.get(artifactId) ?? 0, version));
};

const artifactKey = (artifactId: string, version: number): string => `${artifactId}\0${version}`;

export type ArtifactIndex = ReadonlyMap<string, number>;

/** Validate an envelope-valid entry claiming src artifact. Returns the typed entry or throws corrupt-log. */
/**
 * Read an `attach` entry, or refuse the record (RFC-11).
 *
 * Strict, like `coerceArtifactEntry` and unlike `applyArtifactMeta`. A meta
 * entry carries an opinion about a document and losing one is recoverable by
 * writing it again; an attach entry is the only thing that says a blob
 * exists and what it is. A record whose attach entry cannot be read is a
 * record that cannot find its own files.
 */
const coerceAttachEntry = (raw: unknown, offset: number): LogEntry & { src: "attach" } => {
  const r = raw as Record<string, unknown>;
  if (!isHashHex(r.hash))
    throw new StoreError("corrupt-log", `malformed attach entry at byte ${offset}: hash`);
  if (typeof r.bytes !== "number" || !Number.isSafeInteger(r.bytes) || r.bytes < 0)
    throw new StoreError("corrupt-log", `malformed attach entry at byte ${offset}: bytes`);
  if (!isArtifactField(r.contentType))
    throw new StoreError("corrupt-log", `malformed attach entry at byte ${offset}: contentType`);
  if (!isArtifactField(r.name))
    throw new StoreError("corrupt-log", `malformed attach entry at byte ${offset}: name`);
  if (typeof r.text !== "boolean")
    throw new StoreError("corrupt-log", `malformed attach entry at byte ${offset}: text`);
  const at = (r as { at: unknown }).at;
  return {
    v: 1,
    at: typeof at === "number" ? at : 0,
    src: "attach",
    hash: r.hash as string,
    bytes: r.bytes,
    contentType: r.contentType as string,
    name: r.name as string,
    text: r.text,
  };
};

const coerceArtifactEntry = (raw: unknown, offset: number): LogEntry & { src: "artifact" } => {
  const r = raw as Record<string, unknown>;
  const artifactId = r.artifactId;
  const version = r.version;
  const author = r.author;
  const contentType = r.contentType;
  const hash = r.hash;
  const bytes = r.bytes;
  const at = (r as { at: unknown }).at;
  // Additive fields. A save records the version it was working from and the
  // values of the controls the agent authored; an agent emission has
  // neither. Older readers never looked at them, and the fold ignores what
  // it does not name, so nothing needed a version bump.
  const basedOn = r.basedOn;
  const values = r.values;
  if (!isArtifactField(artifactId))
    throw new StoreError("corrupt-log", `malformed artifact entry at byte ${offset}: artifactId`);
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1)
    throw new StoreError("corrupt-log", `malformed artifact entry at byte ${offset}: version`);
  if (!isArtifactField(author))
    throw new StoreError("corrupt-log", `malformed artifact entry at byte ${offset}: author`);
  if (!isArtifactField(contentType))
    throw new StoreError("corrupt-log", `malformed artifact entry at byte ${offset}: contentType`);
  // Hash must be present for every version from the first — cannot be added later.
  if (!isHashHex(hash))
    throw new StoreError("corrupt-log", `malformed artifact entry at byte ${offset}: hash`);
  if (typeof bytes !== "string")
    throw new StoreError("corrupt-log", `malformed artifact entry at byte ${offset}: bytes`);
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at < 0)
    throw new StoreError("corrupt-log", `malformed artifact entry at byte ${offset}: at`);
  return {
    v: 1,
    at: at as number,
    src: "artifact",
    artifactId: artifactId as string,
    version: version as number,
    author: author as string,
    contentType: contentType as string,
    hash: hash as string,
    bytes: bytes as string,
    ...(typeof basedOn === "number" && Number.isSafeInteger(basedOn) ? { basedOn } : {}),
    ...(values !== null && typeof values === "object" && !Array.isArray(values)
      ? { values: values as Record<string, string> }
      : {}),
  };
};

/** An artifact entry that was carried but refused because bytes exceeded the size limit. */
export interface ArtifactRefusal {
  readonly offset: number;
  readonly issue: "artifact-too-large";
  readonly artifactId: string;
  readonly version: number;
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

const coerceCursorEntry = (raw: Envelope, offset: number): CursorEntry => {
  const value = (raw as unknown as Record<string, unknown>).offset;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new StoreError("corrupt-log", `malformed cursor entry at byte ${offset}`);
  return { v: 1, at: raw.at, src: "cursor", offset: value };
};

// ---------------------------------------------------------------------------
// Transcript (rendered history) - re-exported via store.ts for stability
// ---------------------------------------------------------------------------

export interface TranscriptEvent {
  readonly harness?: import("../protocol/frames.js").HarnessName;
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
  readonly cursor: number;
  /** Every artifact version in the log, by `artifactKey` -> offset. Complete
   * regardless of `fromOffset`: the fold walks the whole log for state, and
   * the offset only scopes effect collection. */
  readonly artifactIndex: ReadonlyMap<string, number>;
  readonly artifactVersions: ArtifactVersions;
  readonly artifactHeads: ReadonlyMap<string, number>;
  readonly artifactTitles: ReadonlyMap<string, string>;
  readonly artifactRefusals: readonly ArtifactRefusal[];
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

const ctxOf = (presence: boolean | undefined): { presence?: Presence } =>
  presence === undefined ? {} : { presence: { processAlive: presence } };

const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
};

/** Apply one `artifact-meta` entry to the title map, tolerantly.
 *
 * A malformed meta entry MUST NOT make a record fail to open (RFC-07). An
 * artifact entry's malformed fields are `corrupt-log` because the bytes and
 * their hash ARE the document; a meta entry carries an opinion about a
 * document. Losing an opinion is recoverable by writing it again. Losing the
 * record is not.
 *
 * So each field is judged on its own merits and what cannot be used is
 * ignored, leaving any earlier value standing. With no usable `artifactId`
 * the whole entry is ignored, because there is nothing to attach it to.
 *
 * Whether the artifact exists is not checked here. The endpoint refuses what
 * it can see; the fold stays total over records it did not write, so a
 * hand-edited log still opens. An entry naming an artifact with no versions
 * simply never reaches a reader, because readers look up titles by an id
 * they already hold. */
const applyArtifactMeta = (raw: unknown, titles: Map<string, string>): void => {
  const e = raw as Record<string, unknown>;
  if (!isArtifactField(e.artifactId)) return;
  const id = e.artifactId as string;
  // Absent is not the same as invalid: absent says nothing about the field,
  // and an earlier value stands either way. Each field on its own merits, so
  // an entry with a good title and a bad `retired` still names the artifact.
  if (e.title !== undefined && isArtifactTitle(e.title)) titles.set(id, e.title);
  // `retired` is read by nothing since RFC-09 withdrew it. An older record
  // carrying it folds exactly as one without it.
};

const applyEntry = (
  state: ChannelState,
  entry: Extract<
    LogEntry,
    { src: "frame" | "input" | "managed-input" | "execution" | "context" | "credit" }
  >,
  secret: string,
): { result: ReduceResult; frame: import("../protocol/index.js").Frame | null } => {
  switch (entry.src) {
    case "execution":
      if (entry.payloadVersion !== 1)
        throw new StoreError("corrupt-log", "Unsupported execution payload");
      return { result: reduceExecution(state, entry.fact, entry.at, true), frame: null };
    case "context":
      if (entry.payloadVersion !== 1)
        throw new StoreError("corrupt-log", "Unsupported context payload");
      return { result: reduceContextCoverage(state, entry.fact, entry.at, true), frame: null };
    case "frame": {
      const raw = entry.frame.kind === "attach" ? { ...entry.frame, secret } : entry.frame;
      const decoded = decodeFrame(raw);
      if (decoded.verdict !== "ok")
        throw new StoreError("corrupt-log", `logged frame no longer decodes: ${decoded.issue}`);
      return {
        result: reduce(state, decoded.frame, entry.at, {
          ...ctxOf(entry.presence),
          ...(entry.ownersDeparted === true ? { ownersDeparted: true } : {}),
          ...(entry.owner === undefined ? {} : { owner: entry.owner }),
        }),
        frame: decoded.frame,
      };
    }
    case "input":
      return { result: enqueueInput(state, entry.input, entry.at), frame: null };
    case "managed-input":
      if (
        entry.payloadVersion !== 1 ||
        entry.intent?.kind !== "requested" ||
        entry.intent.attempt !== 0
      )
        throw new StoreError("corrupt-log", "Unsupported managed input payload");
      return { result: enqueueManagedInput(state, entry.input, entry.at), frame: null };
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
        ...(result.state.attachment?.harness === undefined
          ? {}
          : { harness: result.state.attachment.harness }),
        event: frameOrNull.event,
      }),
    );
  if ((entry.src === "input" || entry.src === "managed-input") && result.record.seq !== undefined)
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
const walk = (
  conversationId: string,
  secret: string,
  raw: Buffer,
  collectFrom?: number,
): {
  state: ChannelState;
  cursor: number;
  collected: CollectedEntry[];
  goodBytes: number;
  entries: number;
  transcript: TranscriptAcc;
  namingEligible: boolean;
  refusedInputs: readonly FoldRefusal[];
  artifactIndex: Map<string, number>;
  /** Per artifact version, the seq of the last frame before it. Its place in
   * the conversation, since an artifact entry carries no seq of its own. */
  artifactVersions: ArtifactVersions;
  artifactHeads: ReadonlyMap<string, number>;
  artifactTitles: Map<string, string>;
  artifactRefusals: readonly ArtifactRefusal[];
} => {
  let state = initialChannelState({ conversationId, secret });
  let offset = 0;
  let cursor = 0;
  const collected: CollectedEntry[] = [];
  let entries = 0;
  const transcript: TranscriptAcc = { events: [], inputs: [], aborted: [] };
  let namingEligible = false;
  const refusedInputs: FoldRefusal[] = [];
  const artifactIndex = new Map<string, number>();
  /** Where each artifact version sits in the conversation: the seq of the
   * last frame accepted before it. An artifact entry gets no seq of its own,
   * because the fold does not reduce it into state - but the log is one
   * ordered file, so the seq at the moment it is read IS its place. Without
   * this a saved version can only be shown after everything, which reads as
   * a thing that just happened however long ago it was. */
  const artifactVersions = new Map<string, Map<number, VersionHeader>>();
  const artifactHeads = new Map<string, number>();
  /** artifactId -> the title last written for it. */
  const artifactTitles = new Map<string, string>();
  const artifactRefusals: ArtifactRefusal[] = [];
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
        // Artifact entries are validated and indexed here — they do not
        // reduce into ChannelState or the transcript, reusing the same
        // carry path an unknown src uses for state (bytes count, no
        // effect), but still building the seek index during the fold
        // that already happens at open (RFC-06 storage).
        if (parsed.src === "cursor") {
          cursor = Math.max(cursor, coerceCursorEntry(parsed, offset).offset);
        } else if (parsed.src === "artifact-meta") {
          // Log order, last write winning per field.
          applyArtifactMeta(parsed, artifactTitles);
        } else if (parsed.src === "attach") {
          // Validated so a bad entry is a corrupt log rather than a silent
          // reference to a blob that is not described. Nothing is indexed:
          // an attachment is found through the input that names it.
          coerceAttachEntry(parsed, offset);
        } else if (parsed.src === "artifact") {
          const art = coerceArtifactEntry(parsed, offset);
          // Size limit: oversize is refused but the record still opens —
          // the entry is carried (bytes counted) yet not indexed, so a
          // later valid version still folds. This is the only artifact
          // refusal that is not corruption.
          if (art.bytes.length > ARTIFACT_BYTES_MAX) {
            artifactRefusals.push({
              offset,
              issue: "artifact-too-large",
              artifactId: art.artifactId,
              version: art.version,
            });
          } else {
            // Every artifact version must carry its hash; coerceArtifactEntry
            // already enforced presence and hex shape. Index is built here
            // so reading a version is a seek, not a fold.
            const key = artifactKey(art.artifactId, art.version);
            // First writer wins for a given (id, version) — later duplicate
            // is ignored rather than overwriting, since versions are never
            // rewritten (RFC-06: every version is a new entry).
            if (!artifactIndex.has(key)) {
              artifactIndex.set(key, offset);
              indexVersion(artifactVersions, artifactHeads, art.artifactId, art.version, {
                offset,
                afterSeq: state.seq,
                at: art.at,
                author: art.author,
                ...(art.basedOn === undefined ? {} : { basedOn: art.basedOn }),
              });
            }
          }
        } else {
          const { result, frame } = applyEntry(state, parsed, secret);
          if (result.verdict !== "accepted") {
            // lucid appends only entries its own reducer accepted, so a
            // refused FRAME or CREDIT entry is log/reducer disagreement -
            // corruption, and fatal. A refused INPUT entry is different:
            // it is a payload a newer build understood and this one does
            // not (RFC-05 B4), so it is carried - state advances to the
            // refusal's (unchanged) state, its bytes count as read - and
            // the refusal is reported, not thrown.
            if (parsed.src !== "input" && parsed.src !== "managed-input")
              throw new StoreError(
                "fold-refused",
                `log entry at byte ${offset} refused on fold (${result.issue})`,
              );
            refusedInputs.push({ offset, issue: result.issue });
            state = result.state;
          } else {
            if (
              (parsed.src === "input" || parsed.src === "managed-input") &&
              "namingEligible" in parsed &&
              parsed.namingEligible === true
            )
              namingEligible = true;
            collectTranscript(transcript, parsed as LogEntry, frame, result);
            state = result.state;
            entries += 1;
            if (collectFrom !== undefined && offset >= collectFrom && result.effects.length > 0)
              collected.push({ offset, effects: Object.freeze([...result.effects]) });
          }
        }
      }
    }
    // An unrecognised src is carried, not applied: the offset advances
    // past its bytes either way, so a later entry still folds.
    offset = nl + 1;
  }
  if (cursor > offset)
    throw new StoreError(
      "corrupt-log",
      `cursor claims offset ${cursor} past good log end ${offset}`,
    );
  return {
    state,
    cursor,
    collected,
    goodBytes: offset,
    entries,
    transcript,
    refusedInputs,
    namingEligible,
    artifactIndex,
    artifactVersions,
    artifactHeads,
    artifactTitles,
    artifactRefusals,
  };
};

export const foldLog = (conversationId: string, secret: string, raw: Buffer) => {
  const { collected: _collected, ...folded } = walk(conversationId, secret, raw);
  return folded;
};

export const foldCollect = (conversationId: string, secret: string, raw: Buffer, fromOffset = 0) =>
  walk(conversationId, secret, raw, fromOffset);

// ---------------------------------------------------------------------------
// Artifact seek (RFC-06 storage: reading a version is a seek, not a fold)
// ---------------------------------------------------------------------------

/** Seek to `offset` in `raw` and return the artifact version there, or null
 * if the line at that offset is not an artifact entry. Validates hash
 * presence and that the stored hash matches the bytes — a mismatch is
 * corruption, since slice three's snapshot guard relies on the hash to
 * detect unreadable bytes (RFC-06 error handling). */
export const readArtifactAtOffset = (raw: Buffer, offset: number): ArtifactVersion | null => {
  if (offset < 0 || offset >= raw.length) return null;
  const nl = raw.indexOf(NL, offset);
  if (nl === -1) return null;
  const line = raw.toString("utf8", offset, nl);
  if (line.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!validEntry(parsed)) return null;
  if ((parsed as { src: string }).src !== "artifact") return null;
  const art = coerceArtifactEntry(parsed, offset);
  if (art.bytes.length > ARTIFACT_BYTES_MAX) return null;
  return {
    artifactId: art.artifactId,
    version: art.version,
    author: art.author,
    contentType: art.contentType,
    hash: art.hash,
    bytes: art.bytes,
    at: art.at,
    ...(art.basedOn === undefined ? {} : { basedOn: art.basedOn }),
    ...(art.values === undefined ? {} : { values: art.values }),
  };
};

/** Seek an artifact version by (artifactId, version) using an index built
 * during the fold that already happens at open. Returns null if not found.
 * The index maps `artifactKey(id, version) -> offset`, so this is a seek,
 * not a fold — it reads one line. */
export const readArtifactVersion = (
  raw: Buffer,
  artifactId: string,
  version: number,
  index: ReadonlyMap<string, number>,
): ArtifactVersion | null => {
  const key = artifactKey(artifactId, version);
  const offset = index.get(key);
  if (offset === undefined) return null;
  return readArtifactAtOffset(raw, offset);
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
// The locked read (offered to the tailer; RFC-04 R1)
// ---------------------------------------------------------------------------

const readFoldRepair = (
  paths: RecordPaths,
  conversationId: string,
  secret: string,
  collectFrom?: number,
): { raw: Buffer; folded: ReturnType<typeof walk> } => {
  const raw: Buffer = existsSync(paths.logPath) ? readFileSync(paths.logPath) : Buffer.alloc(0);
  const folded = walk(conversationId, secret, raw, collectFrom);
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
  return withRecordLock(paths, conversationId, fn, opts.onLockEvent);
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
    const { folded } = readFoldRepair(paths, conversationId, secret);
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
    const { folded } = readFoldRepair(paths, conversationId, secret, fromOffset);
    return { ...folded, entries: folded.collected };
  });

// ---------------------------------------------------------------------------
// ConversationLog - the deep module
// ---------------------------------------------------------------------------

export interface LogDeps {
  readonly now: () => number;
  readonly onLockEvent?: (e: LockEvent) => void;
  readonly onAppendEvent?: (e: AppendEvent) => void;
}

export interface LockedRecordSnapshot {
  readonly artifacts: readonly ArtifactVersion[];
  readonly state: ChannelState;
  readonly transcript: Transcript;
}

export interface ConversationLog {
  /** Catch up and read one coherent record under the append lock. */
  inspect<TValue>(read: (snapshot: LockedRecordSnapshot) => TValue): TValue;
  readonly paths: RecordPaths;
  readonly conversationId: string;
  state(): ChannelState;
  transcript(): Transcript;
  acceptedInput(id: string): TranscriptInput | undefined;
  goodBytes(): number;
  /** Seek index for (artifactId, version) -> offset, built during the fold
   * that already happens when the record opens. Reading a version is a seek,
   * not a fold (RFC-06 storage). */
  artifactIndex(): ReadonlyMap<string, number>;
  artifactHeads(): ReadonlyMap<string, number>;
  artifactVersions(): ArtifactVersions;
  /** artifactId -> its title, for every artifact one has been written for.
   * An id absent from this map has no title and displays as its id. */
  artifactTitles(): ReadonlyMap<string, string>;
  /** Read an artifact version by seek using the fold-built index. Returns
   * null if that version was never written or was refused for size. */
  readArtifact(artifactId: string, version: number): ArtifactVersion | null;
  /** Append an artifact version. Validates size (TEXT_MAX) and that the hash
   * is computed from bytes — a version over the size limit is refused and
   * the record still opens (the oversize entry is carried but not indexed).
   * The hash is written for every version from the first; missing hash is
   * corruption and cannot be added later. */
  writeArtifact(params: {
    readonly artifactId: string;
    readonly version: number;
    readonly author: string;
    readonly contentType: string;
    readonly bytes: string;
    readonly basedOn?: number;
    readonly values?: Readonly<Record<string, string>>;
  }):
    | { verdict: "accepted"; version: ArtifactVersion }
    | { verdict: "refused"; issue: "artifact-too-large" | "artifact-version-exists" };
  /** Append a fact about an artifact: today a title (RFC-07 R11).
   *
   * Never a version. Naming a document is not a change to the document, so
   * this appends no bytes and moves no version number - which is what lets
   * a rename happen mid-conversation without shifting `replaces` under the
   * agent.
   *
   * Whether the artifact exists is the caller's question, not this one's:
   * the endpoint refuses what it can see, and this stays as total as the
   * fold that reads it back. */
  /** Store an attachment and record that it exists (RFC-11).
   *
   * The blob is written and flushed before the entry is appended, so a crash
   * between them leaves an orphan rather than a log that refers to bytes that
   * are not there. Returns the hash the blob is stored under. */
  writeAttachment(params: {
    readonly bytes: Uint8Array;
    readonly contentType: string;
    readonly name: string;
    readonly text: boolean;
  }):
    | { verdict: "accepted"; hash: string }
    | { verdict: "refused"; issue: "attachment-too-large" | "attachment-invalid" };
  writeArtifactMeta(params: {
    readonly artifactId: string;
    readonly title?: string;
  }): { verdict: "accepted" } | { verdict: "refused"; issue: "artifact-title-invalid" };
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
  advanceCursor(offset: number): void;
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
    } catch {}
  };
  const locked = <T>(fn: () => T): T => withAppendLock(paths, conversationId, deps, fn);
  const initial = locked(() => readFoldRepair(paths, conversationId, secret));
  let curState = initial.folded.state;
  let curGoodBytes = initial.folded.goodBytes;
  let curCursor = initial.folded.cursor;
  let acc: TranscriptAcc = { events: [], inputs: [], aborted: [] };
  let curArtifactIndex = new Map<string, number>();
  let curArtifactVersions = new Map<string, Map<number, VersionHeader>>();
  let curArtifactHeads = new Map<string, number>();
  let curArtifactTitles = new Map<string, string>();

  const install = (
    folded: Pick<
      CollectedBatch,
      | "state"
      | "goodBytes"
      | "cursor"
      | "transcript"
      | "artifactIndex"
      | "artifactVersions"
      | "artifactHeads"
      | "artifactTitles"
    >,
  ): void => {
    curState = folded.state;
    curGoodBytes = folded.goodBytes;
    curCursor = folded.cursor;
    acc = {
      events: [...folded.transcript.events],
      inputs: [...folded.transcript.inputs],
      aborted: [...folded.transcript.aborted],
    };
    curArtifactIndex = new Map(folded.artifactIndex);
    curArtifactVersions = copyVersions(folded.artifactVersions);
    curArtifactHeads = new Map(folded.artifactHeads);
    curArtifactTitles = new Map(folded.artifactTitles);
  };
  install(initial.folded);

  const transaction = <T>(
    fn: (
      folded: ReturnType<typeof walk>,
      raw: Buffer,
    ) => { line: Buffer | null; result: T; onWritten?: (offset: number) => void },
  ): T =>
    locked(() => {
      const { raw, folded } = readFoldRepair(paths, conversationId, secret);
      install(folded);
      const offset = curGoodBytes;
      emitAppend({ event: "append.start", conversationId, offset });
      let prepared: ReturnType<typeof fn>;
      try {
        prepared = fn(folded, raw);
      } catch (cause) {
        emitAppend({
          event: "append.failed",
          conversationId,
          offset,
          error: cause instanceof Error ? cause.message : String(cause),
        });
        throw cause;
      }
      const { line, result, onWritten } = prepared;
      if (line !== null) {
        let fd: number | undefined;
        try {
          fd = openSync(paths.logPath, "a");
          writeAllSync(fd, line);
          fsyncSync(fd);
        } catch (cause) {
          if (fd !== undefined) {
            try {
              ftruncateSync(fd, offset);
            } catch {
              try {
                truncateSync(paths.logPath, offset);
              } catch {}
            }
          }
          emitAppend({
            event: "append.failed",
            conversationId,
            offset,
            error: cause instanceof Error ? cause.message : String(cause),
          });
          throw new StoreError("append-failed", `could not append to ${paths.logPath}`, { cause });
        } finally {
          if (fd !== undefined) {
            try {
              closeSync(fd);
            } catch {}
          }
        }
        curGoodBytes = offset + line.length;
        onWritten?.(offset);
      }
      emitAppend({ event: "append.ok", conversationId, offset, bytes: line?.length ?? 0 });
      return result;
    });
  const lineOf = (entry: LogEntry): Buffer => Buffer.from(`${JSON.stringify(entry)}\n`);

  const transcript = (): Transcript => ({
    events: [...acc.events],
    inputs: [...acc.inputs],
    aborted: [...acc.aborted],
  });
  const lockedSnapshot = (raw: Buffer): LockedRecordSnapshot => {
    const artifacts: ArtifactVersion[] = [];
    for (const [id, version] of curArtifactHeads) {
      const artifact = readArtifactVersion(raw, id, version, curArtifactIndex);
      if (artifact === null || artifact.artifactId !== id || artifact.version !== version)
        throw new StoreError(
          "corrupt-log",
          "The current artifact could not be read during context capture",
        );
      artifacts.push(artifact);
    }
    return { artifacts, state: curState, transcript: transcript() };
  };
  const inspect = <TValue>(read: (snapshot: LockedRecordSnapshot) => TValue): TValue =>
    transaction((_folded, raw) => ({ line: null, result: read(lockedSnapshot(raw)) }));

  const append: ConversationLog["append"] = (produce) =>
    transaction(() => {
      const { entry, result, frame } = produce(curState);
      if (entry === null || result.verdict !== "accepted") {
        curState = result.state;
        return { line: null, result };
      }
      return {
        line: lineOf(entry),
        result,
        onWritten: () => {
          curState = result.state;
          collectTranscript(acc, entry, frame, result);
          if ((entry.src === "input" || entry.src === "managed-input") && entry.namingEligible) {
            try {
              initializeNaming(paths.dir, acc.inputs);
            } catch {
              // The prompt is durable. The worker retries this derived write from the marker.
            }
          }
        },
      };
    });

  const collectEffects: ConversationLog["collectEffects"] = (fromOffset) => {
    const batch = collectEffectsUnderAppendLock(paths, conversationId, secret, fromOffset, {
      onLockEvent: deps.onLockEvent,
    });
    install(batch);
    return batch;
  };

  const writeAttachment: ConversationLog["writeAttachment"] = (params) => {
    if (!isArtifactField(params.contentType) || !isArtifactField(params.name))
      return { verdict: "refused", issue: "attachment-invalid" };
    return transaction<ReturnType<ConversationLog["writeAttachment"]>>(() => {
      let hash: string;
      try {
        hash = putBlob(paths.dir, params.bytes);
      } catch {
        return { line: null, result: { verdict: "refused", issue: "attachment-too-large" } };
      }
      const entry: LogEntry = {
        v: 1,
        at: deps.now(),
        src: "attach",
        hash,
        bytes: params.bytes.byteLength,
        contentType: params.contentType,
        name: params.name,
        text: params.text,
      };
      return { line: lineOf(entry), result: { verdict: "accepted", hash } };
    });
  };

  const writeArtifactMeta: ConversationLog["writeArtifactMeta"] = (params) => {
    if (
      !isArtifactField(params.artifactId) ||
      params.title === undefined ||
      !isArtifactTitle(params.title)
    )
      return { verdict: "refused", issue: "artifact-title-invalid" };
    const entry: LogEntry = {
      v: 1,
      at: deps.now(),
      src: "artifact-meta",
      artifactId: params.artifactId,
      title: params.title,
    };
    return transaction(() => ({
      line: lineOf(entry),
      result: { verdict: "accepted" },
      onWritten: () => applyArtifactMeta(entry, curArtifactTitles),
    }));
  };

  const advanceCursor: ConversationLog["advanceCursor"] = (offset) => {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new StoreError(
        "corrupt-log",
        `cursor offset must be a non-negative safe integer, got ${offset}`,
      );
    transaction((folded) => {
      if (offset > folded.goodBytes)
        throw new StoreError(
          "corrupt-log",
          `cursor advance to ${offset} past good log end ${folded.goodBytes}`,
        );
      return {
        line: offset <= curCursor ? null : lineOf({ v: 1, at: deps.now(), src: "cursor", offset }),
        result: undefined,
        onWritten: () => {
          curCursor = offset;
        },
      };
    });
  };

  const readArtifact: ConversationLog["readArtifact"] = (artifactId, version) => {
    const key = artifactKey(artifactId, version);
    const offset = curArtifactIndex.get(key);
    if (offset === undefined) return null;
    const raw = readFileSync(paths.logPath);
    if (offset < raw.length) {
      const found = readArtifactAtOffset(raw, offset);
      if (found !== null && found.artifactId === artifactId && found.version === version)
        return found;
    }
    return locked(() => {
      const { raw: refreshed, folded } = readFoldRepair(paths, conversationId, secret);
      install(folded);
      const retry = curArtifactIndex.get(key);
      return retry === undefined ? null : readArtifactAtOffset(refreshed, retry);
    });
  };

  const writeArtifact: ConversationLog["writeArtifact"] = (params) => {
    if (params.bytes.length > ARTIFACT_BYTES_MAX)
      return { verdict: "refused", issue: "artifact-too-large" };
    if (
      !isArtifactField(params.artifactId) ||
      !isArtifactField(params.author) ||
      !isArtifactField(params.contentType)
    )
      throw new StoreError("corrupt-log", "malformed artifact fields on write");
    if (!Number.isSafeInteger(params.version) || params.version < 1)
      throw new StoreError("corrupt-log", "malformed artifact version on write");
    const hash = hashArtifactBytes(params.bytes);
    const at = deps.now();
    const entry: LogEntry = { v: 1, at, src: "artifact", ...params, hash };
    return transaction<ReturnType<ConversationLog["writeArtifact"]>>((_folded, raw) => {
      const key = artifactKey(params.artifactId, params.version);
      const existingOffset = curArtifactIndex.get(key);
      if (existingOffset !== undefined) {
        const existing = readArtifactAtOffset(raw, existingOffset);
        return {
          line: null,
          result:
            existing !== null && existing.bytes === params.bytes && existing.hash === hash
              ? { verdict: "accepted", version: existing }
              : { verdict: "refused", issue: "artifact-version-exists" },
        };
      }
      const version: ArtifactVersion = { ...params, hash, at };
      return {
        line: lineOf(entry),
        result: { verdict: "accepted", version },
        onWritten: (offset) => {
          curArtifactIndex.set(key, offset);
          indexVersion(curArtifactVersions, curArtifactHeads, params.artifactId, params.version, {
            offset,
            afterSeq: curState.seq,
            at,
            author: params.author,
            ...(params.basedOn === undefined ? {} : { basedOn: params.basedOn }),
          });
        },
      };
    });
  };

  return {
    inspect,
    paths,
    conversationId,
    state: () => curState,
    acceptedInput: (id) => acc.inputs.find((entry) => entry.id === id),
    transcript,
    goodBytes: () => curGoodBytes,
    artifactIndex: () => new Map(curArtifactIndex),
    artifactHeads: () => new Map(curArtifactHeads),
    artifactVersions: () => copyVersions(curArtifactVersions),
    artifactTitles: () => new Map(curArtifactTitles),
    readArtifact,
    writeArtifact,
    writeArtifactMeta,
    writeAttachment,
    cursor: () => curCursor,
    advanceCursor,
    append,
    collectEffects,
    view: () => {
      const folded = foldLog(
        conversationId,
        secret,
        existsSync(paths.logPath) ? readFileSync(paths.logPath) : Buffer.alloc(0),
      );
      return { state: folded.state, transcript: folded.transcript, goodBytes: folded.goodBytes };
    },
    close: () => {},
    recovery: () => ({
      entries: initial.folded.entries,
      discardedBytes: initial.raw.length - initial.folded.goodBytes,
      refusedInputs: initial.folded.refusedInputs.length,
    }),
  };
};

/** Recover only submission-marked work, never migrate a record because it was discovered. */
export async function recoverConversationNaming(dir: string, id: string): Promise<void> {
  const paths = pathsForDir(dir);
  // Scan bounded chunks. Legacy logs can contain large artifact histories.
  const marker = Buffer.from('"namingEligible":true');
  let tail = Buffer.alloc(0);
  let marked = false;
  for await (const chunk of createReadStream(paths.logPath, { highWaterMark: 32768 })) {
    const bytes = Buffer.concat([tail, chunk]);
    if (bytes.includes(marker)) {
      marked = true;
      break;
    }
    tail = bytes.subarray(Math.max(0, bytes.length - marker.length + 1));
  }
  if (!marked) return;
  withRecordLock(paths, id, () => {
    const secret = readFileSync(paths.secretPath, "utf8").trim();
    const { folded } = readFoldRepair(paths, id, secret);
    if (folded.namingEligible) initializeNaming(dir, folded.transcript.inputs);
  });
}

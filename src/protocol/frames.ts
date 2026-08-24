/**
 * Frame codecs: the chat session protocol's wire vocabulary (PLAN.md 4.3),
 * validated at the boundary. decodeFrame turns an untrusted record into a
 * typed Frame or a refused verdict with a NAMED issue, and CONSTRUCTS the
 * result field by field from validated values - it never casts the raw
 * record through, so extra/prototype-carried/getter-backed keys cannot
 * ride into the durable log, and a value validated is the value used.
 * A refused verdict is the only operator-visible auth/validation signal,
 * so its issue names the exact reason and no frame is ever half-applied.
 *
 * Shapes follow PLAN.md exactly. `epoch` is the fencing token: every
 * post-attach frame carries it (a takeover increments it; stale-epoch
 * frames are refused, which is what makes the lease enforceable). `seq` is
 * lucid's durable log authority; `n` is the source's per-epoch counter;
 * `covers` references lucid's `seq`.
 */

export const FRAME_KINDS = [
  "attach",
  "event",
  "ack",
  "disposition",
  "heartbeat",
  "detach",
  "attach-ok",
  "refused",
  "event-ack",
  "input",
  "control",
  "lease",
  "credit",
] as const;

export type FrameKind = (typeof FRAME_KINDS)[number];

export type AttachProfile = "interactive" | "headless-session" | "headless-turn";

/** The harnesses lucid can drive, as hcn names them. Closed on purpose: a
 * harness name partitions attribution in the log, so a typo that decoded
 * would silently make a record un-resumable instead of failing loudly
 * (RFC-03 R007). Kept here rather than imported from src/harness so the
 * protocol layer depends on nothing below it. */
export const HARNESS_NAMES = ["claude", "codex", "pi", "muse"] as const;
export type HarnessName = (typeof HARNESS_NAMES)[number];
export type Disposition = "applied" | "queued" | "rejected";
export type DetachReason = "yield" | "shutdown";
export type InputMode = "queue" | "steer";
export type ControlAction = "pause" | "end" | "switch-path";

/** Issues a codec can raise: the frame never decoded. */
export const DECODE_ISSUES = [
  "not-json",
  "not-a-frame",
  "unknown-kind",
  "missing-field",
  "wrong-type",
  "not-serializable",
] as const;
export type DecodeIssue = (typeof DECODE_ISSUES)[number];

/** Issues the reducer can raise: the frame decoded but was not applied.
 * Declared here because a `refused` frame carries them on the wire - the
 * issue vocabulary IS wire vocabulary, and typing it keeps a typo'd issue
 * from compiling. */
export const REFUSAL_ISSUES = [
  "auth-failed",
  "wrong-conversation",
  "version-unsupported",
  "resume-ahead-of-log",
  "lease-held",
  "presence-holds",
  "not-attached",
  "stale-epoch",
  "future-epoch",
  "gap-n",
  "dupe-n",
  "turn-id-reused",
  "input-id-reused",
  "unknown-input",
  "input-queue-full",
  "no-credit",
  "invalid-grant",
  "invalid-input",
  "steer-unsupported",
  "covers-ahead-of-log",
  "wrong-direction",
] as const;
export type RefusalIssue = (typeof REFUSAL_ISSUES)[number];

const PROTOCOL_ISSUES = [...DECODE_ISSUES, ...REFUSAL_ISSUES] as const;
export type ProtocolIssue = (typeof PROTOCOL_ISSUES)[number];

/** Bounds so a payload cannot become resident or forge a log line by luck
 * of what a wire delivered. Ids/selectors match v1's 128-char stamp bound;
 * text is generous but finite. Numbers must be safe integers (>= 2^53
 * breaks monotonic seq/epoch/n comparison and never-expiring leases). */
const ID_MAX = 128;
const TEXT_MAX = 1_000_000;
const TOKENS_MAX = 1_000_000;

export interface Lease {
  readonly expires: number;
  readonly renewEvery: number;
}

export type Frame =
  // source -> lucid
  | {
      readonly kind: "attach";
      readonly conversationId: string;
      readonly profile: AttachProfile;
      readonly secret: string;
      readonly version: number;
      readonly resumeFrom?: number;
      /** Which harness this source drives. REQUIRED for the two headless
       * profiles; ignored for interactive, where lucid does not own the
       * process and never resumes it (RFC-03 rule 1, R008). */
      readonly harness?: HarnessName;
    }
  | {
      readonly kind: "event";
      readonly epoch: number;
      readonly n: number;
      readonly turnId: string;
      readonly event: Record<string, unknown>;
    }
  | { readonly kind: "ack"; readonly epoch: number; readonly covers: number }
  | {
      readonly kind: "disposition";
      readonly epoch: number;
      readonly inputId: string;
      readonly outcome: Disposition;
      readonly note?: string;
    }
  | { readonly kind: "heartbeat"; readonly epoch: number }
  | { readonly kind: "detach"; readonly epoch: number; readonly reason: DetachReason }
  // lucid -> source
  | {
      readonly kind: "attach-ok";
      readonly epoch: number;
      readonly lease: Lease;
      readonly replayFrom: number;
      readonly version: number;
      /** The harness session this source SHOULD continue, when the record
       * holds one of its own harness. Absent means open fresh - which covers
       * both an empty record and one whose sessions belong to other
       * harnesses (RFC-03 R006). Only lucid derives this; a source must not
       * compute its own (rule 5). */
      readonly resumeSessionId?: string;
    }
  | { readonly kind: "refused"; readonly issue: ProtocolIssue }
  | { readonly kind: "event-ack"; readonly epoch: number; readonly n: number }
  | {
      readonly kind: "input";
      readonly seq: number;
      readonly id: string;
      readonly text: string;
      readonly mode: InputMode;
      readonly turnId?: string;
    }
  | { readonly kind: "control"; readonly seq: number; readonly action: ControlAction }
  | { readonly kind: "lease"; readonly epoch: number; readonly expires: number }
  | { readonly kind: "credit"; readonly epoch: number; readonly tokens: number };

export type DecodeVerdict =
  | { readonly verdict: "ok"; readonly frame: Frame }
  | { readonly verdict: "refused"; readonly issue: DecodeIssue };

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters IS the guard - they forge log lines and collide dedupe keys
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

class Refused extends Error {
  constructor(readonly issue: DecodeIssue) {
    super(issue);
  }
}
const refuse = (issue: DecodeIssue): never => {
  throw new Refused(issue);
};

/** Reads that only ever touch OWN properties, validate, and return the
 * validated value - the returned frame is built from these, never cast. */
const own = (record: Record<string, unknown>, field: string): unknown =>
  Object.hasOwn(record, field) ? record[field] : undefined;

const str = (record: Record<string, unknown>, field: string, max: number): string => {
  const v = own(record, field);
  if (v === undefined) refuse("missing-field");
  if (typeof v !== "string") refuse("wrong-type");
  if ((v as string) === "") refuse("missing-field");
  if ((v as string).length > max || CONTROL_CHARS.test(v as string)) refuse("wrong-type");
  return v as string;
};

const text = (record: Record<string, unknown>, field: string): string => {
  const v = own(record, field);
  if (v === undefined) refuse("missing-field");
  if (typeof v !== "string") refuse("wrong-type");
  if ((v as string).length > TEXT_MAX) refuse("wrong-type");
  return v as string;
};

const nat = (
  record: Record<string, unknown>,
  field: string,
  max = Number.MAX_SAFE_INTEGER,
): number => {
  const v = own(record, field);
  if (v === undefined) refuse("missing-field");
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > max) refuse("wrong-type");
  return v as number;
};

const optNat = (record: Record<string, unknown>, field: string): number | undefined => {
  if (!Object.hasOwn(record, field) || record[field] === undefined) return undefined;
  return nat(record, field);
};

const optStr = (
  record: Record<string, unknown>,
  field: string,
  max: number,
): string | undefined => {
  if (!Object.hasOwn(record, field) || record[field] === undefined) return undefined;
  return str(record, field, max);
};

const enumOf = <T extends string>(
  record: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T => {
  const v = own(record, field);
  if (v === undefined) refuse("missing-field");
  if (typeof v !== "string" || !allowed.includes(v as T)) refuse("wrong-type");
  return v as T;
};

/** The nested HarnessEvent object: the protocol does not re-validate the
 * normalizer's event shape (the Part 0 seam forbids importing its types),
 * but serializability and boundedness ARE protocol knowledge - a frame the
 * store cannot JSON.stringify is not a valid frame. */
const serializableObject = (
  record: Record<string, unknown>,
  field: string,
): Record<string, unknown> => {
  const v = own(record, field);
  if (v === undefined) refuse("missing-field");
  if (typeof v !== "object" || v === null || Array.isArray(v)) refuse("wrong-type");
  const json = ((): string => {
    try {
      return JSON.stringify(v);
    } catch {
      return refuse("not-serializable");
    }
  })();
  if (json.length > TEXT_MAX) refuse("wrong-type");
  // Round-trip so Date/NaN/undefined normalize to their wire form and no
  // getter or prototype key survives into the log.
  return JSON.parse(json) as Record<string, unknown>;
};

const withEpoch = (record: Record<string, unknown>): number => nat(record, "epoch");

/** Wire-validity predicates for HOST-constructed values: the host API must
 * be exactly as strict as the decoder, or a host-minted frame can poison
 * the queue with something the wire refuses. */
export const isWireId = (v: string): boolean =>
  v !== "" && v.length <= ID_MAX && !CONTROL_CHARS.test(v);
export const isWireText = (v: string): boolean => v.length <= TEXT_MAX;

const DECODERS: Record<FrameKind, (r: Record<string, unknown>) => Frame> = {
  attach: (r) => ({
    kind: "attach",
    conversationId: str(r, "conversationId", ID_MAX),
    profile: enumOf(r, "profile", ["interactive", "headless-session", "headless-turn"] as const),
    secret: str(r, "secret", ID_MAX),
    version: nat(r, "version"),
    ...(optNat(r, "resumeFrom") !== undefined ? { resumeFrom: optNat(r, "resumeFrom") } : {}),
    // Unknown name refuses at the codec as wrong-type, the same as a bad
    // profile. A MISSING one is a reducer concern (invalid-grant), because a
    // well-formed frame making an unsupportable request is a different fault.
    ...(own(r, "harness") !== undefined ? { harness: enumOf(r, "harness", HARNESS_NAMES) } : {}),
  }),
  event: (r) => ({
    kind: "event",
    epoch: withEpoch(r),
    n: nat(r, "n"),
    turnId: str(r, "turnId", ID_MAX),
    event: serializableObject(r, "event"),
  }),
  ack: (r) => ({ kind: "ack", epoch: withEpoch(r), covers: nat(r, "covers") }),
  disposition: (r) => ({
    kind: "disposition",
    epoch: withEpoch(r),
    inputId: str(r, "inputId", ID_MAX),
    outcome: enumOf(r, "outcome", ["applied", "queued", "rejected"] as const),
    ...(optStr(r, "note", ID_MAX) !== undefined ? { note: optStr(r, "note", ID_MAX) } : {}),
  }),
  heartbeat: (r) => ({ kind: "heartbeat", epoch: withEpoch(r) }),
  detach: (r) => ({
    kind: "detach",
    epoch: withEpoch(r),
    reason: enumOf(r, "reason", ["yield", "shutdown"] as const),
  }),
  "attach-ok": (r) => {
    const lease = own(r, "lease");
    if (lease === undefined) refuse("missing-field");
    if (typeof lease !== "object" || lease === null || Array.isArray(lease)) refuse("wrong-type");
    return {
      kind: "attach-ok",
      epoch: withEpoch(r),
      lease: {
        expires: nat(lease as Record<string, unknown>, "expires"),
        renewEvery: nat(lease as Record<string, unknown>, "renewEvery"),
      },
      replayFrom: nat(r, "replayFrom"),
      version: nat(r, "version"),
      ...(own(r, "resumeSessionId") !== undefined
        ? { resumeSessionId: str(r, "resumeSessionId", ID_MAX) }
        : {}),
    };
  },
  refused: (r) => ({ kind: "refused", issue: enumOf(r, "issue", PROTOCOL_ISSUES) }),
  "event-ack": (r) => ({ kind: "event-ack", epoch: withEpoch(r), n: nat(r, "n") }),
  input: (r) => ({
    kind: "input",
    seq: nat(r, "seq"),
    id: str(r, "id", ID_MAX),
    text: text(r, "text"),
    mode: enumOf(r, "mode", ["queue", "steer"] as const),
    ...(optStr(r, "turnId", ID_MAX) !== undefined ? { turnId: optStr(r, "turnId", ID_MAX) } : {}),
  }),
  control: (r) => ({
    kind: "control",
    seq: nat(r, "seq"),
    action: enumOf(r, "action", ["pause", "end", "switch-path"] as const),
  }),
  // `expires` is an absolute timestamp - a safe integer, no artificial cap;
  // ttl bounds live on the reducer, which owns the injected clock.
  lease: (r) => ({ kind: "lease", epoch: withEpoch(r), expires: nat(r, "expires") }),
  credit: (r) => ({ kind: "credit", epoch: withEpoch(r), tokens: nat(r, "tokens", TOKENS_MAX) }),
};

export const decodeFrame = (raw: unknown): DecodeVerdict => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { verdict: "refused", issue: "not-a-frame" };
  }
  const record = raw as Record<string, unknown>;
  const kind = Object.hasOwn(record, "kind") ? record.kind : undefined;
  if (typeof kind !== "string" || !(FRAME_KINDS as readonly string[]).includes(kind)) {
    return { verdict: "refused", issue: "unknown-kind" };
  }
  try {
    return { verdict: "ok", frame: DECODERS[kind as FrameKind](record) };
  } catch (error) {
    if (error instanceof Refused) return { verdict: "refused", issue: error.issue };
    throw error;
  }
};

/** Encode a typed frame to its wire string. Building from the typed Frame
 * means extra fields are unrepresentable and a non-serializable payload
 * fails at the sender, not the store. */
export const encodeFrame = (frame: Frame): string => JSON.stringify(frame);

/** The parse entry point: transport delivers text, this is the only path
 * an untrusted string reaches decodeFrame. */
export const parseFrame = (textLine: string): DecodeVerdict => {
  let raw: unknown;
  try {
    raw = JSON.parse(textLine);
  } catch {
    return { verdict: "refused", issue: "not-json" };
  }
  return decodeFrame(raw);
};

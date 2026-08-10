/**
 * Frame codecs: the chat session protocol's wire vocabulary, validated at
 * the boundary. decodeFrame returns a structured verdict - ok with the
 * typed frame, or refused with a NAMED issue - and never a half-applied
 * frame: validation either accepts the whole record or rejects it with the
 * reason the host logs verbatim (a refused frame is the only operator-
 * visible auth/validation signal).
 */

export const FRAME_KINDS = [
  "attach",
  "attach-ok",
  "event",
  "event-ack",
  "input",
  "disposition",
  "ack",
  "heartbeat",
  "detach",
  "refused",
  "control",
  "lease",
  "credit",
] as const;

export type FrameKind = (typeof FRAME_KINDS)[number];

export type DispositionState = "applied" | "queued" | "rejected";
export type ControlOp = "end" | "switch-path";
export type AttachPath = "interactive" | "headless-session" | "headless-turn";

export interface FrameBase {
  readonly kind: FrameKind;
  readonly conversationId: string;
}

export type Frame =
  | (FrameBase & { kind: "attach"; secret: string; path: AttachPath; replayFrom?: number })
  | (FrameBase & { kind: "attach-ok"; epoch: number; replayFrom: number })
  | (FrameBase & { kind: "event"; epoch: number; n: number; event: Record<string, unknown> })
  | (FrameBase & { kind: "event-ack"; seq: number })
  | (FrameBase & { kind: "input"; epoch: number; id: string; text: string })
  | (FrameBase & { kind: "disposition"; inputId: string; state: DispositionState })
  | (FrameBase & { kind: "ack"; seq: number })
  | (FrameBase & { kind: "heartbeat"; epoch: number })
  | (FrameBase & { kind: "detach"; epoch: number })
  | (FrameBase & { kind: "refused"; issue: string })
  | (FrameBase & { kind: "control"; epoch: number; op: ControlOp })
  | (FrameBase & { kind: "lease"; epoch: number; ttlMs: number })
  | (FrameBase & { kind: "credit"; tokens: number });

export type DecodeVerdict =
  | { readonly verdict: "ok"; readonly frame: Frame }
  | { readonly verdict: "refused"; readonly issue: string };

type FieldSpec =
  | "string"
  | "nonempty-string"
  | "nat"
  | "object"
  | { readonly enum: readonly string[] }
  | { readonly optional: "nat" };

const isNat = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v >= 0;

const FIELDS: Record<FrameKind, Record<string, FieldSpec>> = {
  attach: {
    secret: "nonempty-string",
    path: { enum: ["interactive", "headless-session", "headless-turn"] },
    replayFrom: { optional: "nat" },
  },
  "attach-ok": { epoch: "nat", replayFrom: "nat" },
  event: { epoch: "nat", n: "nat", event: "object" },
  "event-ack": { seq: "nat" },
  input: { epoch: "nat", id: "nonempty-string", text: "string" },
  disposition: {
    inputId: "nonempty-string",
    state: { enum: ["applied", "queued", "rejected"] },
  },
  ack: { seq: "nat" },
  heartbeat: { epoch: "nat" },
  detach: { epoch: "nat" },
  refused: { issue: "nonempty-string" },
  control: { epoch: "nat", op: { enum: ["end", "switch-path"] } },
  lease: { epoch: "nat", ttlMs: "nat" },
  credit: { tokens: "nat" },
};

const fieldOk = (value: unknown, spec: FieldSpec): "ok" | "missing" | "wrong" => {
  if (typeof spec === "object" && "optional" in spec) {
    if (value === undefined) return "ok";
    return isNat(value) ? "ok" : "wrong";
  }
  if (value === undefined) return "missing";
  if (spec === "string") return typeof value === "string" ? "ok" : "wrong";
  if (spec === "nonempty-string") {
    if (typeof value !== "string") return "wrong";
    return value === "" ? "missing" : "ok";
  }
  if (spec === "nat") return isNat(value) ? "ok" : "wrong";
  if (spec === "object") {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? "ok" : "wrong";
  }
  return (spec.enum as readonly string[]).includes(value as string) ? "ok" : "wrong";
};

export const decodeFrame = (raw: unknown): DecodeVerdict => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { verdict: "refused", issue: "not-a-frame" };
  }
  const record = raw as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== "string" || !(FRAME_KINDS as readonly string[]).includes(kind)) {
    return { verdict: "refused", issue: "unknown-kind" };
  }
  if (typeof record.conversationId !== "string" || record.conversationId === "") {
    return { verdict: "refused", issue: "missing-field" };
  }
  for (const [field, spec] of Object.entries(FIELDS[kind as FrameKind])) {
    const state = fieldOk(record[field], spec);
    if (state === "missing") return { verdict: "refused", issue: "missing-field" };
    if (state === "wrong") return { verdict: "refused", issue: "wrong-type" };
  }
  return { verdict: "ok", frame: record as unknown as Frame };
};

import { comparisonMetadata } from "../protocol/comparison-note.js";
import type { ComparisonHold } from "./comparison-delivery.js";
import { createComparisonDelivery } from "./comparison-delivery.js";
/** Hook input delivery and the vocabulary for selecting an interactive rung. */

import { resolveVerifiedRecord, type VerifiedRecord } from "../cli/record-addressing.js";
import { isWireId } from "../protocol/frames.js";
import { LockError } from "../store/flock.js";
import { openWriter, viewConversation } from "../store/store.js";

// ---------------------------------------------------------------------------
// Hook chunking + guard — single source (was HookDelivery, now here)
// ---------------------------------------------------------------------------

/** The hook `reason` field cap — encoded UTF-8 bytes post-JSON-escape. */
export const HOOK_CHUNK_CAP_BYTES = 4000;

/**
 * Measure the UTF-8 byte length of `text` after JSON-escaping (the cap
 * is post-JSON-escape, not code points). The surrounding JSON quotes are
 * stripped.
 */
export const encodedByteLength = (text: string): number =>
  Buffer.byteLength(JSON.stringify(text), "utf8") - 2;

/**
 * Chunk `text` into pieces each measuring ≤ `cap` encoded bytes.
 * Greedy, code-point safe (never splits a surrogate pair), and
 * tolerant of a single code point that alone exceeds the cap (emitted
 * solo rather than looping forever). An empty input yields `[""]` so
 * its disposition remains real.
 *
 */
export const chunkHookInput = (
  text: string,
  cap: number = HOOK_CHUNK_CAP_BYTES,
): readonly string[] => {
  if (!Number.isSafeInteger(cap) || cap <= 0)
    throw new Error("hook chunk cap must be a positive safe integer");
  if (encodedByteLength(text) <= cap) return [text];
  const points = [...text];
  const chunks: string[] = [];
  let chunk = "";
  let chunkBytes = 0;
  for (const point of points) {
    const pointBytes = encodedByteLength(point);
    if (pointBytes > cap) {
      if (chunk.length > 0) {
        chunks.push(chunk);
        chunk = "";
        chunkBytes = 0;
      }
      chunks.push(point);
      continue;
    }
    if (chunkBytes + pointBytes > cap) {
      chunks.push(chunk);
      chunk = point;
      chunkBytes = pointBytes;
    } else {
      chunk += point;
      chunkBytes += pointBytes;
    }
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
};

export type HookGuard =
  | { readonly proceed: true; readonly record: VerifiedRecord; readonly payload: unknown }
  | { readonly proceed: false; readonly result: { readonly ok: true } }
  | {
      readonly proceed: false;
      readonly result: {
        readonly ok: false;
        readonly code: "hook-resolution-failed";
        readonly message: string;
      };
    };

/**
 * Guard the hook entry: JSON-parse the stdin payload and resolve the
 * verified record via the env-stamp. Returns `proceed:false` for
 * misfires (non-JSON) and unmanaged sessions (no stamp) — both are
 * non-destructive no-ops — or for resolution failures (E003).
 * Callers become 5-line adapters: `if (!guard.proceed) return guard.result`.
 */
export const guardHookEntry = (stdin: string): HookGuard => {
  let payload: unknown;
  try {
    payload = JSON.parse(stdin);
  } catch {
    return { proceed: false, result: { ok: true } };
  }
  const resolved = resolveVerifiedRecord();
  if ("notManaged" in resolved) return { proceed: false, result: { ok: true } };
  if (!resolved.ok)
    return {
      proceed: false,
      result: { ok: false, code: resolved.code, message: resolved.message },
    };
  return { proceed: true, record: resolved.record, payload };
};

export interface HookDeliverResult {
  readonly ok: boolean;
  readonly delivered?: number;
  readonly chunks?: number;
  readonly code?: "hook-resolution-failed" | "injection-refused";
  readonly message?: string;
}

/** Read the durable queue: outstanding/queued inputs in seq order. */
export const readQueuedInputs = (recordDir: string): readonly { id: string; text: string }[] => {
  const view = viewConversation(recordDir);
  return view.transcript.inputs
    .filter(
      (inp) =>
        !Object.hasOwn(view.state.executions, inp.id) &&
        (inp.status === "outstanding" || inp.status === "queued"),
    )
    .map((inp) => ({ id: inp.id, text: inp.text }));
};

/**
 * Deliver the oldest eligible input through the hook reason. Preserve its
 * original identity and record applied at delivery. A reason must fit whole;
 * queuing synthetic chunk inputs does not deliver those bytes to the harness.
 */
export const deliverFirstQueued = (
  recordDir: string,
  deliveryOptions: {
    readonly rung?: "hooks" | "observe" | "cooperative";
    readonly documentLimit?: number;
    readonly promptLimit?: number;
  } = {},
): HookDeliverResult => {
  let queued: readonly { id: string; text: string }[];
  try {
    queued = readQueuedInputs(recordDir);
  } catch {
    return { ok: true };
  }
  if (queued.length === 0) return { ok: true };
  let first = queued[0];
  if (!first) return { ok: true };
  try {
    const host = openWriter(recordDir, { presence: () => true });
    const state = host.state();
    const attachment = state.attachment;
    const holds = host
      .transcript()
      .events.filter((event) => event.epoch === state.epoch && event.event.code === "E-COMP-07")
      .map((event) => event.event as unknown as ComparisonHold);
    const comparison = createComparisonDelivery(
      {
        capable:
          (deliveryOptions.rung ?? "hooks") === "hooks" && attachment?.profile === "interactive",
        documentLimit: deliveryOptions.documentLimit,
        promptLimit: deliveryOptions.promptLimit ?? HOOK_CHUNK_CAP_BYTES,
        head: (id) => host.artifactHeads().get(id),
        snapshot: (id) => host.comparisonSnapshot(id),
        hold: (event) => {
          const current = host.state();
          if (!current.attachment) return;
          if (current.inputs.find((input) => input.id === event.inputId)?.status !== "queued")
            host.handleFrame(
              JSON.stringify({
                kind: "disposition",
                epoch: current.epoch,
                inputId: event.inputId,
                outcome: "queued",
              }),
            );
          const result = host.handleFrame(
            JSON.stringify({
              kind: "event",
              epoch: current.epoch,
              n: current.attachment.lastN + 1,
              turnId: current.turn?.turnId ?? `comparison-hold-${current.epoch}`,
              event,
            }),
          );
          if (result.verdict !== "accepted")
            throw new Error("comparison hold could not be recorded");
        },
      },
      holds,
    );
    let selected: { id: string; text: string } | undefined;
    for (const input of queued) {
      if (comparisonMetadata(input.text).kind !== "none" && !attachment) continue;
      const prepared = comparison.prepare(input.id, input.text);
      if (prepared.kind === "held") continue;
      if (prepared.kind === "ready") {
        const result = host.handleFrame(
          JSON.stringify({
            kind: "disposition",
            epoch: host.state().epoch,
            inputId: input.id,
            outcome: "applied",
          }),
        );
        if (result.verdict !== "accepted")
          return {
            ok: false,
            code: "injection-refused",
            message: "comparison delivery disposition refused",
          };
        process.stdout.write(`${JSON.stringify({ decision: "block", reason: prepared.prompt })}\n`);
        host.close();
        return { ok: true, delivered: 1, chunks: 1 };
      }
      selected = input;
      break;
    }
    if (!selected) {
      host.close();
      return { ok: true, delivered: 0 };
    }
    first = selected;
    const reason = `HUMAN FEEDBACK: ${first.text}`;
    if (encodedByteLength(reason) > (deliveryOptions.promptLimit ?? HOOK_CHUNK_CAP_BYTES)) {
      host.close();
      return {
        ok: false,
        code: "injection-refused",
        message:
          "The complete input exceeds the hook reason limit. It remains queued and has not been truncated.",
      };
    }
    const applied = host.handleFrame(
      JSON.stringify({
        kind: "disposition",
        epoch: host.state().epoch,
        inputId: first.id,
        outcome: "applied",
      }),
    );
    host.close();
    if (applied.verdict !== "accepted")
      return { ok: false, code: "injection-refused", message: "hook delivery disposition refused" };
    process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
    return { ok: true, delivered: 1, chunks: 1 };
  } catch (e) {
    if (e instanceof LockError) {
      return { ok: false, code: "hook-resolution-failed", message: e.message };
    }
    throw e;
  }
};

// ---------------------------------------------------------------------------
// Rungs — the degradation surface
// ---------------------------------------------------------------------------

export const RUNGS = ["hooks", "cooperative", "observe"] as const;
export type Rung = (typeof RUNGS)[number];

export interface RungProfile {
  readonly rung: Rung;
  /** How queued input reaches the agent. */
  readonly inject: "boundary" | "wait-poll" | "resume-instruction";
  /** Whether lucid can announce identity/attach without agent cooperation. */
  readonly attach: "lucid-aware" | "cooperative" | "none";
}

const PROFILES: Record<Rung, RungProfile> = {
  hooks: { rung: "hooks", inject: "boundary", attach: "lucid-aware" },
  cooperative: { rung: "cooperative", inject: "wait-poll", attach: "cooperative" },
  observe: { rung: "observe", inject: "resume-instruction", attach: "none" },
};

export interface LadderEnv {
  /** `--setting-sources project` in effect AND HERDR_ENV unset for the
   * child (D-025): the hooks rung needs both or its Stop hooks hang. */
  readonly hooksIsolated: boolean;
  /** The agent runs lucid's cooperative drop-file poll loop. GATED on the
   * A-003 retry; until that lands the cooperative rung is never offered. */
  readonly cooperativeAvailable: boolean;
}

export const A003_GATE_OPEN = false;

export const selectRung = (env: LadderEnv): RungProfile => {
  if (env.hooksIsolated) return PROFILES.hooks;
  if (A003_GATE_OPEN && env.cooperativeAvailable) return PROFILES.cooperative;
  return PROFILES.observe;
};

// ---------------------------------------------------------------------------
// Announce parse
// ---------------------------------------------------------------------------

export interface AnnounceAttach {
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly source: string;
}

export const parseAnnounce = (line: string): AnnounceAttach | null => {
  try {
    return parseAnnouncePayload(JSON.parse(line));
  } catch {
    return null;
  }
};

export const parseAnnouncePayload = (parsed: unknown): AnnounceAttach | null => {
  const row =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  if (
    row === null ||
    (row.hook_event_name ?? row.hook) !== "SessionStart" ||
    typeof row.session_id !== "string" ||
    !isWireId(row.session_id) ||
    typeof row.transcript_path !== "string" ||
    row.transcript_path === ""
  )
    return null;
  return {
    sessionId: row.session_id,
    transcriptPath: row.transcript_path,
    source: typeof row.source === "string" ? row.source : "unknown",
  };
};

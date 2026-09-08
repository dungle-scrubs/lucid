/**
 * The event vocabulary lucid reads off `hcn --json`, and the decoder that
 * turns one NDJSON line into it.
 *
 * hcn owns the wire; this owns lucid's reading of it. The kind strings are
 * derived from `src/protocol/events.ts`, never mirrored (C1): a rename there
 * is a single edit. hcn's stream carries kinds lucid's protocol does not
 * classify (the session control events), so those
 * are named here and everything else passes through untouched.
 *
 * The passthrough matters. hcn promises its event kinds are additive, so a
 * kind lucid does not recognise is data lucid must not drop or throw on - the
 * reducer's ledger records it. A decoder that threw here would turn a normalizer release into an
 * outage.
 *
 * What it is NOT: it is not the protocol reducer, the store, or the frame
 * vocabulary. It decodes a subprocess's stdout line.
 */
import type { EventKind } from "../protocol/events.js";

/** hcn's failure taxonomy, as lucid reads it. Additive: an unknown class is
 * carried through as a string rather than refused. */
export interface HarnessFailure {
  readonly class: string;
  readonly retryable: boolean;
  readonly message: string;
  readonly code?: string;
  readonly resetsAt?: number;
  readonly [extra: string]: unknown;
}

/** Why a turn or session ended. New hcn causes remain readable. */
export type HarnessCause = string;

/** One decoded line of `hcn --json`. The turn kinds lucid's protocol already
 * knows, the two hcn adds, and the four session control events. */
export type HarnessEvent =
  | {
      readonly kind: typeof EventKind.identity;
      readonly sessionId: string;
      readonly [k: string]: unknown;
    }
  | { readonly kind: typeof EventKind.token; readonly text: string }
  | { readonly kind: typeof EventKind.message; readonly role: string; readonly text: string }
  | { readonly kind: typeof EventKind.progress; readonly label: string }
  | { readonly kind: typeof EventKind.tool; readonly name: string; readonly input?: unknown }
  | { readonly kind: typeof EventKind.context; readonly usedPct: number }
  | { readonly kind: typeof EventKind.limit; readonly code: string; readonly message: string }
  | { readonly kind: typeof EventKind.error; readonly message: string; readonly terminal?: boolean }
  | ({ readonly kind: typeof EventKind.failure } & HarnessFailure)
  | {
      readonly kind: typeof EventKind.question;
      readonly question: string;
      readonly options: readonly string[];
      readonly recommended?: string;
    }
  | {
      readonly kind: typeof EventKind.done;
      readonly exitCode: number | null;
      readonly cause: HarnessCause;
      readonly failure?: HarnessFailure;
    }
  /** Session control events (hcn session --json). */
  | {
      readonly kind: "session";
      readonly sessionId: string;
      readonly harness: string;
      readonly hcn: string;
      readonly escalateQuestions: boolean;
    }
  | { readonly kind: "turn"; readonly turnId: string; readonly id?: string }
  | {
      readonly kind: "disposition";
      readonly id: string;
      /** Whatever arrived, unchecked. hcn answers `started` or `rejected`,
       * but this decoder reads a JSON field rather than validating one, and
       * typing it as the union would state a guarantee nothing here made.
       * `createHcnRunner` narrows it and refuses anything else. */
      readonly disposition: string;
      readonly reason?: string;
    }
  | {
      readonly kind: "closed";
      readonly exitCode: number | null;
      readonly cause: HarnessCause;
      readonly failure?: HarnessFailure;
    }
  /** A kind this lucid does not know. Carried, never dropped, never thrown
   * on - hcn's kinds are additive by contract. */
  | { readonly kind: string; readonly [field: string]: unknown };

/** A line that is not an object with a string `kind` is not an event. The
 * caller decides whether that is worth reporting; it is never fatal. */
export const decodeHarnessLine = (line: string): HarnessEvent | null => {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.kind !== "string" || record.kind === "") return null;
  return record as unknown as HarnessEvent;
};

/**
 * Native harness session identity: the types, the bounded stdout-JSONL
 * decoder, and the outcome classifiers.
 *
 * Lucid carries TWO identities through unattended execution, and this module
 * exists to keep them from being confused:
 *
 * - `launchId` is Lucid-owned correlation for one process. It never enters
 *   resume argv - it names a launch attempt, not a conversation.
 * - `sessionId` is harness-native and carries explicit authority: `assigned`
 *   when Lucid handed the harness its id, `observed` when the harness minted
 *   one and announced it on stdout. Only an id with authority may be resumed.
 *
 * Trust boundaries, which are the whole protocol:
 *
 * - Identity is accepted ONLY from structured stdout records matching the
 *   adapter's declared event/field selectors (`thread.started.thread_id` for
 *   Codex). Stderr, human narration, and free text never establish identity -
 *   a log line that LOOKS like a session id is evidence for humans, not a
 *   resume target.
 * - Every record is bounded before it is believed: line length, id length,
 *   and character class. A record that fails any bound is ignored with an
 *   HSI003 diagnostic and scanning continues - one hostile or corrupt line
 *   must not cost the identity a later valid line carries.
 * - Failure classifiers are compiled adapter code over bounded output tails,
 *   never registry-supplied patterns: the registry declares WHERE identity
 *   lives, the adapter decides WHAT harness failure text means.
 *
 * This module is pure: no process orchestration, no filesystem writes, no
 * review state. `recipes.ts` validates declarations against argv; the
 * launcher streams process output through the decoder; sidecar persistence
 * belongs to `attendant.ts`.
 */

/** How a recipe's native session identity is established. */
export interface CallerAssignedSessionIdentity {
  /** The argv flag whose NEXT token is the `{id}` Lucid mints and assigns. */
  readonly argument: string;
  readonly source: "caller-assigned";
}

export interface StdoutJsonlSessionIdentity {
  /** A resume may announce a DIFFERENT id than requested; default false. */
  readonly allowRotation?: boolean;
  /** The record `type` that carries identity (Codex: `thread.started`). */
  readonly event: string;
  /** The field on that record holding the native id (Codex: `thread_id`). */
  readonly field: string;
  /** The argv token that switches the harness into structured output; its
   *  presence in spawn AND resume is what makes discovery deterministic. */
  readonly requiredArgument: string;
  readonly source: "stdout-jsonl";
}

export type SessionIdentityRecipe = CallerAssignedSessionIdentity | StdoutJsonlSessionIdentity;

/** Who vouches for a session id. `declared` exists only in sidecar history
 *  (a human or tool asserted it); spawn paths produce the other two. */
export type SessionIdentityAuthority = "assigned" | "declared" | "observed";

export interface NativeSessionIdentity {
  readonly authority: "assigned" | "observed";
  readonly harness: string;
  readonly sessionId: string;
}

/** One decoded identity announcement. A record that fails a bound never
 *  becomes an event - it becomes a diagnostic (HSI003) and scanning goes on. */
export interface SessionIdentityEvent {
  readonly identity: NativeSessionIdentity;
  readonly status: "identity";
}

export interface SessionIdentityDiagnostic {
  readonly code: "HSI003";
  readonly reason: "malformed-json" | "invalid-id" | "line-overflow";
}

/** A JSONL line may not exceed this before its newline arrives; past it the
 *  line is discarded as hostile rather than buffered without limit. */
const LINE_MAX = 65_536;
/** A native session id: printable, single-line, and short. Anything else is
 *  not an id Lucid will ever place into a resume argv. */
const ID_MAX = 512;
const hasControlChars = (v: string): boolean =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them IS the point
  /[\x00-\x1f\x7f]/.test(v);

/**
 * Incremental bounded decoder for stdout-JSONL identity discovery.
 *
 * Fed raw stdout chunks as they stream; owns NO output bytes (the same chunks
 * continue to the log sink untouched, which is what keeps discovery invisible
 * to everything that already consumes harness output). Chunk boundaries carry
 * no meaning: a record split mid-key decodes exactly like one that arrived
 * whole, because real pipes split wherever they like.
 */
export class SessionIdentityDecoder {
  private buffer = "";
  private overflowing = false;
  private readonly found: SessionIdentityDiagnostic[] = [];

  constructor(
    private readonly harness: string,
    private readonly strategy: StdoutJsonlSessionIdentity,
  ) {}

  /** Feed one stdout chunk; returns identities completed by this chunk. */
  push(chunk: string): SessionIdentityEvent[] {
    const events: SessionIdentityEvent[] = [];
    let rest = chunk;
    while (rest.length > 0) {
      const nl = rest.indexOf("\n");
      if (nl === -1) {
        if (this.overflowing) break; // still discarding an oversized line
        this.buffer += rest;
        if (this.buffer.length > LINE_MAX) {
          // The line exceeded its bound before terminating: drop it and keep
          // discarding until the newline shows up. One hostile line must cost
          // exactly one diagnostic, not the rest of the stream.
          this.found.push({ code: "HSI003", reason: "line-overflow" });
          this.buffer = "";
          this.overflowing = true;
        }
        break;
      }
      const line = this.buffer + rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      this.buffer = "";
      if (this.overflowing) {
        this.overflowing = false; // the oversized line finally ended; move on
        continue;
      }
      const event = this.decodeLine(line);
      if (event) events.push(event);
    }
    return events;
  }

  /** Flush a final record that arrived without a trailing newline. */
  finish(): SessionIdentityEvent[] {
    if (this.overflowing || this.buffer === "") return [];
    const line = this.buffer;
    this.buffer = "";
    const event = this.decodeLine(line);
    return event ? [event] : [];
  }

  /** Every bound violation seen so far, in arrival order. */
  diagnostics(): readonly SessionIdentityDiagnostic[] {
    return [...this.found];
  }

  private decodeLine(line: string): SessionIdentityEvent | undefined {
    if (line.trim() === "") return undefined;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      this.found.push({ code: "HSI003", reason: "malformed-json" });
      return undefined;
    }
    if (typeof record !== "object" || record === null) {
      this.found.push({ code: "HSI003", reason: "malformed-json" });
      return undefined;
    }
    const r = record as Record<string, unknown>;
    // A structured record of some OTHER type is normal stream traffic, not a
    // bound violation - only the declared event may carry identity.
    if (r.type !== this.strategy.event) return undefined;
    const id = r[this.strategy.field];
    if (typeof id !== "string" || id === "" || id.length > ID_MAX || hasControlChars(id)) {
      this.found.push({ code: "HSI003", reason: "invalid-id" });
      return undefined;
    }
    return {
      identity: { authority: "observed", harness: this.harness, sessionId: id },
      status: "identity",
    };
  }
}

/** How a spawned process ended, identity-wise. `spawn-failed` (127) is minted
 *  by the launcher when no process ever ran; it cannot arise from an exit. */
export type SpawnResult =
  | { readonly code: 0; readonly identity?: NativeSessionIdentity; readonly status: "completed" }
  | { readonly code: 0; readonly error: "HSI002"; readonly status: "identity-missing" }
  | {
      readonly code: number;
      readonly identity?: NativeSessionIdentity;
      readonly status: "process-failed";
    }
  | { readonly code: 127; readonly status: "spawn-failed" };

/**
 * Classify a finished process. The asymmetry is deliberate: a CLEAN discovered
 * process that never announced identity is HSI002 (its artifact survives, but
 * the launch is non-resumable and must say so), while a nonzero exit stays a
 * process failure whether or not identity arrived - the exit code is the
 * story there, not the missing id.
 */
export const classifySpawnResult = (
  code: number,
  strategy: SessionIdentityRecipe,
  identity?: NativeSessionIdentity,
): SpawnResult => {
  if (code !== 0) return { code, ...(identity ? { identity } : {}), status: "process-failed" };
  if (identity) return { code: 0, identity, status: "completed" };
  if (strategy.source === "stdout-jsonl") {
    return { code: 0, error: "HSI002", status: "identity-missing" };
  }
  // Caller-assigned identity exists before the process does; nothing to miss.
  return { code: 0, status: "completed" };
};

/** What a resume announced, judged against what was requested. */
export type ObservedIdentityOutcome =
  | { readonly identity: NativeSessionIdentity; readonly status: "confirmed" }
  | {
      readonly error: "HSI005";
      readonly observed: NativeSessionIdentity;
      readonly requestedSessionId: string;
      readonly status: "mismatch";
    }
  | {
      readonly identity: NativeSessionIdentity;
      readonly previousSessionId: string;
      readonly status: "rotated";
    };

/**
 * Mismatch policy (HSI005): a resume that announces a DIFFERENT id than it was
 * asked to resume has, with high likelihood, started a fresh context - binding
 * it would silently attach review feedback to a conversation that never saw
 * the artifact. Unless the adapter explicitly allows rotation, the answer is a
 * typed refusal the caller must not paper over.
 */
export const classifyObservedIdentity = (
  requestedSessionId: string,
  observed: NativeSessionIdentity,
  allowRotation: boolean,
): ObservedIdentityOutcome => {
  if (observed.sessionId === requestedSessionId) return { identity: observed, status: "confirmed" };
  if (allowRotation) {
    return { identity: observed, previousSessionId: requestedSessionId, status: "rotated" };
  }
  return {
    error: "HSI005",
    observed,
    requestedSessionId,
    status: "mismatch",
  };
};

/** Per-harness matchers for "this native session does not exist" (HSI004),
 *  compiled here rather than declared in the registry: failure text is an
 *  adapter judgment, and a registry-supplied pattern would let a config file
 *  decide what gets quarantined. */
const NOT_FOUND_MATCHERS: Readonly<Record<string, RegExp>> = {
  codex: /no rollout found for thread/i,
};
/** Only this much of the tail is consulted - failure banners sit at the end
 *  of output, and an unbounded scan of a runaway stream is its own bug. */
const FAILURE_TAIL_MAX = 65_536;

/**
 * Recognize a native-session-not-found failure from a bounded output tail.
 * `null` means "not recognized" - the caller keeps its transient-retry
 * behavior. Only an explicit adapter match may quarantine an id (HSI004);
 * an uncertain classifier must never invalidate.
 */
export const classifySessionFailure = (harness: string, outputTail: string): "HSI004" | null => {
  const matcher = NOT_FOUND_MATCHERS[harness];
  if (!matcher) return null;
  const tail =
    outputTail.length > FAILURE_TAIL_MAX ? outputTail.slice(-FAILURE_TAIL_MAX) : outputTail;
  return matcher.test(tail) ? "HSI004" : null;
};

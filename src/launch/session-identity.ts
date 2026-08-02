import { hasControlCharacters } from "../core/events.ts";

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
 *   and character class - and the bounds hold regardless of how the pipe
 *   split the bytes. A record that fails a bound is counted (HSI003) and
 *   scanning continues.
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
  /**
   * The flag that RESUMES that id, when the harness spells it differently -
   * claude assigns with `--session-id <id>` and re-enters with `--resume
   * <id>`. Defaults to `argument` for harnesses that use one flag for both.
   */
  readonly resumeArgument?: string;
  readonly source: "caller-assigned";
}

export interface StdoutJsonlSessionIdentity {
  /** A resume may announce a DIFFERENT id than requested; default false. */
  readonly allowRotation?: boolean;
  /** The value of the record's `type` key that carries identity (Codex:
   *  `thread.started`). The discriminator KEY is fixed as `type` - the JSONL
   *  event convention every supported harness follows - only its value and
   *  the id field are declarable. */
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
  readonly authority: Exclude<SessionIdentityAuthority, "declared">;
  readonly harness: string;
  readonly sessionId: string;
}

/**
 * One harness, one identity, however it is spelled. A registry key of
 * `claude_code` and an artifact stamped `claude-code` are the same harness -
 * and treating them as different meant a recorded session could never be
 * resumed on a machine whose registry used the other separator. Lives here
 * because spelling-equivalence IS an identity question; `recipes.ts`
 * re-exports it for its callers.
 */
export const normalizeHarness = (name: string): string =>
  name.trim().toLowerCase().replace(/_/g, "-");

/** A fresh launch id: 16 hex chars, the same well-formed shape request ids
 *  use (WELL_FORMED_ID), so the stamp normalizer's validate-or-drop rule
 *  accepts exactly what this mints. */
export const mintLaunchId = (): string => crypto.randomUUID().replaceAll("-", "").slice(0, 16);

/** One decoded identity announcement. */
export interface SessionIdentityEvent {
  readonly identity: NativeSessionIdentity;
  readonly status: "identity";
}

/** Why records were refused, as COUNTS (HSI003). Not a list: a hostile or
 *  chatty stream can refuse millions of lines, and retaining an object per
 *  refusal measured at more memory than the stream itself. Three integers
 *  say everything the refusals collectively know. */
export type SessionIdentityDiagnostics = Readonly<
  Record<"invalid-id" | "line-overflow" | "malformed-json", number>
>;

/** A JSONL line may not exceed this - buffered OR arriving whole - before it
 *  is discarded as hostile rather than parsed. */
const LINE_MAX = 65_536;
/** A native session id longer than this is not an id Lucid will ever place
 *  into a resume argv. Matches the sidecar/stamp bound (`sanitizeAttendant`
 *  cleans `sessionId` to 128) so the decoder cannot admit an id the record
 *  layer would truncate into a DIFFERENT id. */
export const SESSION_ID_MAX = 128;

/**
 * The shape an id must have before Lucid will put it in a command line.
 *
 * A discovered id comes from the harness's own stdout, which is the least
 * trusted input in the whole flow: it is read from a subprocess, believed,
 * stored, and later substituted into `resume` argv. Bounding length and
 * stripping control characters is not enough - an id of `--dangerously-skip-
 * permissions` is printable, short, and would be handed to the CLI as a FLAG.
 * So an id is an opaque token: letters, digits, and the few separators real
 * harnesses use, never leading with a dash.
 */
const SESSION_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;

/** True when this id may be believed and, later, placed into resume argv. */
export const isUsableSessionId = (value: string): boolean =>
  value.length > 0 && value.length <= SESSION_ID_MAX && SESSION_ID_SHAPE.test(value);

/**
 * Incremental bounded decoder for stdout-JSONL identity discovery.
 *
 * Fed raw stdout chunks as they stream; owns NO output bytes (the same chunks
 * continue to the log sink untouched, which is what keeps discovery invisible
 * to everything that already consumes harness output). Chunk boundaries carry
 * no meaning: a record split mid-key decodes - and a bound violation counts -
 * exactly like one that arrived whole.
 */
export class SessionIdentityDecoder {
  private buffer = "";
  private overflowing = false;
  private readonly refused: Record<"invalid-id" | "line-overflow" | "malformed-json", number> = {
    "invalid-id": 0,
    "line-overflow": 0,
    "malformed-json": 0,
  };

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
        if (this.buffer.length + rest.length > LINE_MAX) {
          this.refused["line-overflow"] += 1;
          this.buffer = "";
          this.overflowing = true;
          break;
        }
        this.buffer += rest;
        break;
      }
      const wasOverflowing = this.overflowing;
      const lineLength = this.buffer.length + nl;
      const line = wasOverflowing || lineLength > LINE_MAX ? "" : this.buffer + rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      this.buffer = "";
      this.overflowing = false;
      if (wasOverflowing) continue; // the oversized line finally ended
      if (lineLength > LINE_MAX) {
        // Same bound whether the line was buffered across pushes or arrived
        // whole in one chunk - a payload must not become parseable by luck
        // of where the pipe split it.
        this.refused["line-overflow"] += 1;
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

  /** How many records each bound has refused so far. */
  diagnostics(): SessionIdentityDiagnostics {
    return { ...this.refused };
  }

  private decodeLine(line: string): SessionIdentityEvent | undefined {
    if (line.trim() === "") return undefined;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      this.refused["malformed-json"] += 1;
      return undefined;
    }
    if (typeof record !== "object" || record === null) {
      this.refused["malformed-json"] += 1;
      return undefined;
    }
    const r = record as Record<string, unknown>;
    // A structured record of some OTHER type is normal stream traffic, not a
    // bound violation - only the declared event may carry identity.
    if (r.type !== this.strategy.event) return undefined;
    // Reading a registry-declared key off a parsed record is safe: JSON.parse
    // creates own data properties (even `__proto__`), and anything inherited
    // that survives the lookup fails the string check below.
    const id = r[this.strategy.field];
    if (typeof id !== "string" || hasControlCharacters(id) || !isUsableSessionId(id)) {
      this.refused["invalid-id"] += 1;
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
  // Caller-assigned discovery has nothing to observe on stdout; the caller
  // holds the assigned identity it minted before the spawn and carries it
  // alongside this result (wired in the spawn integration milestone).
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
 *  decide what gets quarantined. Prototype-free: harness names arrive from
 *  registry keys and stamps, and `classifySessionFailure`'s contract is that
 *  an unknown one returns null - including one named `toString`. */
const NOT_FOUND_MATCHERS: Readonly<Record<string, RegExp>> = Object.assign(Object.create(null), {
  codex: /no rollout found for thread/i,
});
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
  const matcher = NOT_FOUND_MATCHERS[normalizeHarness(harness)];
  if (!matcher) return null;
  const tail =
    outputTail.length > FAILURE_TAIL_MAX ? outputTail.slice(-FAILURE_TAIL_MAX) : outputTail;
  return matcher.test(tail) ? "HSI004" : null;
};

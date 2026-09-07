/**
 * HarnessRunner — the seam lucid drives a harness through.
 *
 * Before, lucid imported the normalizer's `openSession`, `streamTurn`,
 * `nodeRunnerDeps`, and its four descriptors directly out of that package's
 * `src/` tree. The normalizer's decision D-001 makes the `hcn` binary its only
 * supported surface, so those imports were unsupported and broke the moment
 * the neighbouring checkout moved.
 *
 * This interface is what lucid needs from a harness, in lucid's own terms.
 * One production implementation spawns `hcn` and decodes its NDJSON; one test
 * implementation replays recorded `hcn` output. Everything above the seam -
 * turn sequencing, the FIFO, credit, disposition timing - is unchanged and
 * stays lucid's.
 *
 * What it is NOT: it is not the protocol reducer, the durable store, or the
 * flock. It is the process boundary and nothing else.
 */
import type { HarnessName } from "../protocol/frames.js";
import type { HarnessEvent } from "./events.js";

/** A harness as hcn names it. Validated by `src/cli/harness.ts`. */
export type { HarnessName };

/** The integration modes a capability query can ask about. */
export type HarnessMode = "headless-turn" | "headless-session" | "interactive";

/** What `hcn inspect --capabilities` answers. */
export interface CapabilityResult {
  readonly vision: boolean;
  readonly images: boolean;
  readonly streaming: string;
  readonly session: boolean;
  readonly source: "runtime-verified" | "curated" | "unknown";
  readonly confidence: "high" | "medium" | "none";
}

/** Descriptor facts, plus optional uncached results for this inspection request. */
export interface HarnessFacts {
  /** hcn declares an accounting mechanism. A count still verifies the
   * selected model, executable and profile before it is usable. */
  readonly contextAccounting?: true;
  readonly runtime?: {
    readonly executable: { readonly path: string | null; readonly version: string | null };
    readonly resume: { readonly status: "supported" | "unknown"; readonly reason: string | null };
  };
  readonly binary?: string;
  readonly name: string;
  /** Whether the harness declares a persistent session mode. Decides which
   * headless profile `lucid run` uses - a runtime-verified capability, not a
   * guess (PLAN D-008). */
  readonly session: boolean;
  readonly verifiedAgainst: string;
  /** What a person may choose for model and effort (RFC-12), projected from
   * the dump's `vocabulary` and `turnOptions`. Absent when the dump carries
   * no vocabulary - the harness then has no lists to offer, and the page's
   * rule for that is the design's own: absent, not disabled. */
  readonly vocabulary?: HarnessVocabulary;
}

/** The choosing vocabulary hcn's descriptor dump reports for a harness
 * (RFC-12). One source: `hcn inspect <harness> --json`, projected here, so
 * lucid mirrors nothing about a harness's models. */
export interface HarnessVocabulary {
  /** `vocabulary.models`, aliases resolved: hcn's list is already the
   * canonical ids, and `vocabulary.aliases` maps pet names onto it, so the
   * list is served as it stands. */
  readonly aliases?: Readonly<Record<string, string>>;
  readonly models: readonly string[];
  /** `vocabulary.efforts`, the harness's ladder in the dump's own order. */
  readonly efforts: readonly string[];
  /** `vocabulary.extensible`: the model list is open (pi registers models
   * at runtime), so an unlisted id is a valid choice, not a mistake. */
  readonly extensible: boolean;
  /** Whether the harness expresses a provider dimension at all - `turnOptions`
   * carrying `provider` (pi only today). No list exists for it: the value is
   * open and hcn validates it at spawn. Present only where expressible,
   * absent elsewhere - never false, which would read as "checked and
   * refused" where the truth is "no such dimension". */
  readonly provider?: true;
}

/**
 * What hcn answers a send with. Two outcomes, not three: hcn supervises one
 * process and answers before it opens the turn, so a send either started a
 * turn or was refused. It used to carry a third, `queued`, from when hcn held
 * a queue of its own; ADR 0007 removed the queue, and this followed it rather
 * than keeping a value nothing can produce.
 *
 * lucid's own protocol disposition is a different type and still has three
 * states - see `Disposition` in `src/protocol/frames.ts`. That one describes
 * what lucid did with an input, which includes queueing it itself.
 */
export type Disposition = "started" | "rejected";

export interface SendResult {
  readonly disposition: Disposition;
  readonly reason?: string;
}

/** One turn's events, tagged with the input that opened it. The tag comes
 * from hcn's `turn` event, so lucid never shadows the delivery order with a
 * queue of its own. */
export interface HarnessTurn extends AsyncIterable<HarnessEvent> {
  readonly turnId: string;
  readonly inputId?: string;
}

/** How a session ended. */
export interface SessionClosed {
  readonly exitCode: number | null;
  readonly cause: string;
}

export interface SessionHandle {
  readonly turns: AsyncIterable<HarnessTurn>;
  /** Deliver text as the next turn. `id` is lucid's, echoed back on the turn
   * that consumes it. Async because the answer crosses a pipe. */
  send(id: string, text: string): Promise<SendResult>;
  /** Answer a question the harness asked. hcn composes the preamble. */
  answer(id: string, text: string): Promise<SendResult>;
  close(): Promise<SessionClosed>;
}

export interface OpenSessionOptions {
  readonly signal?: AbortSignal;
  readonly harness: HarnessName;
  /** The id this session will be KNOWN BY. Names a session; does not
   * continue one. */
  readonly sessionId: string;
  /** The id of a session to CONTINUE. Distinct from sessionId on purpose:
   * conflating them is what hcn issue #86 reported, where passing an
   * existing id re-entered the id and not the conversation. hcn refuses an
   * unknown id before spawn. */
  readonly resume?: string;
  readonly model?: string;
  readonly provider?: string;
  /** RFC-12: routing through `hcn session --effort` (hcn >= 0.6.0),
   * validated per harness/model the same way `hcn run --effort` is. */
  readonly effort?: string;
  readonly cwd?: string;
  /** Per-turn inactivity budget in seconds. 0 or absent means no limit. */
  readonly stallSeconds?: number;
}

export interface StreamTurnOptions {
  /** hcn-enforced wall-clock bound in seconds. Isolated jobs default to 60. */
  readonly timeoutSeconds?: number;
  readonly signal?: AbortSignal;
  readonly isolation?: "tool-free";
  readonly harness: HarnessName;
  readonly prompt: string;
  readonly resume?: string;
  readonly model?: string;
  /** RFC-12: routing through `hcn run --provider` (pi only; hcn refuses
   * the flag for a harness that cannot express the dimension). */
  readonly provider?: string;
  /** RFC-12: routing through `hcn run --effort`. The session path carries
   * the dimension too, since hcn 0.6.0 grew `hcn session --effort`. */
  readonly effort?: string;
  readonly cwd?: string;
  readonly turnId: string;
}

export interface HarnessRunner {
  /** Count the complete prepared request through hcn, including recalled
   * native history. An unavailable result never authorizes dispatch. */
  countContext(opts: ContextCountOptions): Promise<ContextCount>;
  /** `hcn session <h> --json`. Throws HarnessRefusal when hcn refuses before
   * spawning, HarnessSpawnError when the binary will not start. */
  openSession(opts: OpenSessionOptions): Promise<SessionHandle>;
  /** `hcn run <h> --json`. Never throws from the first pull: a refusal
   * arrives as a failure event followed by done. */
  streamTurn(opts: StreamTurnOptions): AsyncIterable<HarnessEvent>;
  /** `hcn inspect <h> --json`, projected to what lucid reads. No spawn. */
  inspect(
    harness: HarnessName,
    choice?: {
      readonly model?: string;
      readonly effort?: string;
      readonly provider?: string;
      readonly isolation?: "tool-free";
      readonly runtime?: {
        readonly cwd: string;
        readonly profile: "headless-turn" | "headless-session";
        readonly resume?: string;
      };
    },
  ): Promise<HarnessFacts>;
  /** `hcn inspect <h> --capabilities`. No spawn. */
  capabilities(harness: HarnessName, model: string, mode: HarnessMode): Promise<CapabilityResult>;
}

export interface ContextCountOptions extends Omit<StreamTurnOptions, "turnId"> {
  readonly profile: "headless-turn" | "headless-session";
}

export type ContextCountFailure =
  | "accounting-refused"
  | "invalid-accounting-response"
  | "unknown-accounting-failure"
  | "model-divergence"
  | "response-limit"
  | "auth"
  | "limit"
  | "native-exit"
  | "unverified-adapter"
  | "unsupported-adapter"
  | "transport-limit"
  | "transport"
  | "protocol"
  | "timeout"
  | "cancelled"
  | "cleanup"
  | "not-configured";

export type ContextCount =
  | {
      readonly executable: { readonly path: string; readonly version: string };
      readonly inputLimitTokens: number;
      readonly method: "native-context-estimate";
      readonly model: string;
      readonly status: "available";
      readonly totalTokens: number;
    }
  | {
      readonly issue?: string;
      readonly reason: ContextCountFailure;
      readonly status: "unavailable";
    };

/** hcn refused the invocation itself (exit 2). Not retryable by re-running:
 * the options or the harness have to change. */
export class HarnessRefusal extends Error {
  constructor(
    readonly issue: string,
    message: string,
    readonly supported?: readonly string[],
  ) {
    super(message);
    this.name = "HarnessRefusal";
  }
}

/** The hcn binary itself could not be started. */
export class HarnessSpawnError extends Error {
  constructor(cause: unknown) {
    super(`could not spawn hcn: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "HarnessSpawnError";
  }
}

/** The hcn on PATH is older than the surface lucid depends on. */
export class HarnessVersionError extends Error {
  /** Names the binary that was actually used.
   *
   * Without it the message said "run bun install" whatever the cause, and
   * the cause was a stale `hcn` on PATH — `bun install` would have fixed
   * nothing and the advice sent the reader to the wrong place. */
  constructor(found: string, required: string, bin?: string) {
    super(
      bin === undefined
        ? `hcn ${found} is older than the required ${required}; run bun install`
        : `hcn ${found} at ${bin} is older than the required ${required}. ` +
            `Install a newer hcn there, or point LUCID_HCN at one.`,
    );
    this.name = "HarnessVersionError";
  }
}

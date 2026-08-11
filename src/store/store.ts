/**
 * The durable conversation store: the impure shell that hosts the pure
 * protocol reducer and enforces its verdicts. Owns the record directory
 * (per-conversation secret minted 0600 at CREATION - D-004: a first
 * attacher never mints), the append-only NDJSON log that is the seq
 * authority (every accepted transition is appended before it is applied,
 * and fold-to-state deterministically reproduces ChannelState from it),
 * and the structured boundary record for every accepted/refused frame.
 * Clock, presence, and both sinks are injected, so every test is
 * deterministic while file permissions and torn-line tolerance are proven
 * against the real filesystem. NOT responsible for transport (deferred by
 * decision) or for rendering; effects are handed to the injected sink.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { Effect } from "../protocol/index.js";
import {
  type ChannelState,
  type ChannelStatus,
  channelStatus,
  enqueueInput,
  grantCredit,
  initialChannelState,
  type Presence,
  parseFrame,
  type ReduceResult,
  reduce,
  type TransitionRecord,
} from "../protocol/index.js";

const SECRET_BYTES = 32;

export class StoreError extends Error {
  constructor(
    readonly code: "record-exists" | "missing-secret" | "corrupt-log" | "fold-refused",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface RecordPaths {
  readonly dir: string;
  readonly secretPath: string;
  readonly logPath: string;
}

export const recordPaths = (rootDir: string, conversationId: string): RecordPaths => {
  const dir = join(rootDir, conversationId);
  return { dir, secretPath: join(dir, "secret"), logPath: join(dir, "log.ndjson") };
};

/** Create the conversation record: directory, 0600 secret, empty log.
 * Creation is lucid's alone and happens exactly once - re-creation throws
 * so a first attacher can never mint (D-004). */
export const createConversationRecord = (
  rootDir: string,
  conversationId: string,
): { readonly secret: string; readonly paths: RecordPaths } => {
  const paths = recordPaths(rootDir, conversationId);
  if (existsSync(paths.dir))
    throw new StoreError("record-exists", `conversation record already exists: ${paths.dir}`);
  mkdirSync(paths.dir, { recursive: true });
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(SECRET_BYTES))).toString("hex");
  writeFileSync(paths.secretPath, secret, { mode: 0o600 });
  appendFileSync(paths.logPath, "");
  return { secret, paths };
};

/** One durable log entry: everything fold needs to reproduce the
 * transition deterministically - the transition source, its input, the
 * clock reading, and (for attach) the presence sample that shaped the
 * verdict. */
type LogEntry =
  | {
      readonly v: 1;
      readonly at: number;
      readonly src: "frame";
      readonly frame: unknown;
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

export interface HostDeps {
  /** Injected clock - the store performs zero wall-clock reads. */
  readonly now: () => number;
  /** Latest presence sample (normalizer isInteractive, injected).
   * undefined = the host could not corroborate. */
  readonly presence: () => boolean | undefined;
  /** Every effect the reducer emits, in order (transport wiring later). */
  readonly onEffect: (effect: Effect) => void;
  /** The always-on boundary record: one structured line per accepted or
   * refused transition, logged verbatim by the caller. */
  readonly onRecord: (record: TransitionRecord | WireRecord) => void;
}

/** The boundary record for a line that never decoded into a frame. */
export interface WireRecord {
  readonly verdict: "refused";
  readonly wire: true;
  readonly issue: string;
  readonly conversationId: string;
  readonly now: number;
}

const ctxOf = (presence: boolean | undefined): { presence?: Presence } =>
  presence === undefined ? {} : { presence: { processAlive: presence } };

const applyEntry = (state: ChannelState, entry: LogEntry): ReduceResult => {
  switch (entry.src) {
    case "frame": {
      const decoded = parseFrame(JSON.stringify(entry.frame));
      if (decoded.verdict !== "ok")
        throw new StoreError("corrupt-log", `logged frame no longer decodes: ${decoded.issue}`);
      return reduce(state, decoded.frame, entry.at, ctxOf(entry.presence));
    }
    case "input":
      return enqueueInput(state, entry.input, entry.at);
    case "credit":
      return grantCredit(state, entry.tokens, entry.at);
  }
};

/** Fold the log into state. Pure over the lines; a torn TRAILING line
 * (crash mid-append) is tolerated and reported so open() can repair the
 * file - a torn line anywhere else is corruption. */
const foldLog = (
  conversationId: string,
  secret: string,
  raw: string,
): { state: ChannelState; goodBytes: number } => {
  let state = initialChannelState({ conversationId, secret });
  let offset = 0;
  let goodBytes = 0;
  while (offset < raw.length) {
    const nl = raw.indexOf("\n", offset);
    const line = nl === -1 ? raw.slice(offset) : raw.slice(offset, nl);
    if (nl === -1) break; // no newline: torn trailing line, tolerated
    let entry: LogEntry;
    try {
      entry = JSON.parse(line) as LogEntry;
    } catch (cause) {
      if (raw.indexOf("\n", nl + 1) === -1 && raw.endsWith("\n") === false) break;
      throw new StoreError("corrupt-log", `unparseable log line at byte ${offset}`, { cause });
    }
    const result = applyEntry(state, entry);
    if (result.verdict !== "accepted")
      throw new StoreError(
        "fold-refused",
        `log entry at byte ${offset} refused on fold (${result.issue}): the log only holds accepted transitions`,
      );
    state = result.state;
    offset = nl + 1;
    goodBytes = offset;
  }
  return { state, goodBytes };
};

export const openConversation = (dir: string, deps: HostDeps) => {
  const conversationId = basename(dir);
  const paths = recordPaths(join(dir, ".."), conversationId);
  if (!existsSync(paths.secretPath))
    throw new StoreError("missing-secret", `no secret in record dir: ${paths.secretPath}`);
  const secret = readFileSync(paths.secretPath, "utf8");
  const raw = existsSync(paths.logPath) ? readFileSync(paths.logPath, "utf8") : "";
  const folded = foldLog(conversationId, secret, raw);
  // Repair a crash-torn tail so the next append starts on a line boundary.
  if (folded.goodBytes < raw.length) truncateSync(paths.logPath, folded.goodBytes);
  let state = folded.state;

  /** Append-then-apply: the entry is durable before the state advances,
   * so a crash between the two replays the transition on fold instead of
   * losing it. */
  const commit = (entry: LogEntry, result: ReduceResult): ReduceResult => {
    if (result.verdict === "accepted") {
      appendFileSync(paths.logPath, `${JSON.stringify(entry)}\n`);
      state = result.state;
    }
    deps.onRecord(result.record);
    for (const effect of result.effects) deps.onEffect(effect);
    return result;
  };

  return {
    state: (): ChannelState => state,
    /** One status tick = one presence sample: the caller's tick cadence IS
     * the polling cadence (MUSE F6). An uncorroborated sample counts as
     * not-alive for NAMING only - the reducer's takeover gate still treats
     * unknown as never-blocking (D-021). */
    status: (): ChannelStatus =>
      channelStatus(state, deps.now(), { processAlive: deps.presence() === true }),
    handleFrame: (line: string): ReduceResult | { verdict: "refused"; issue: string } => {
      const at = deps.now();
      const decoded = parseFrame(line);
      if (decoded.verdict !== "ok") {
        deps.onRecord({
          verdict: "refused",
          wire: true,
          issue: decoded.issue,
          conversationId,
          now: at,
        });
        deps.onEffect({ type: "send", frame: { kind: "refused", issue: decoded.issue } });
        return { verdict: "refused", issue: decoded.issue };
      }
      const presence = decoded.frame.kind === "attach" ? deps.presence() : undefined;
      // The DECODED frame is what persists - never the raw wire object,
      // whose extra fields the codec deliberately strips.
      const entry: LogEntry = {
        v: 1,
        at,
        src: "frame",
        frame: decoded.frame,
        ...(presence === undefined ? {} : { presence }),
      };
      return commit(entry, reduce(state, decoded.frame, at, ctxOf(presence)));
    },
    enqueueInput: (input: {
      readonly id: string;
      readonly text: string;
      readonly mode: "queue" | "steer";
      readonly turnId?: string;
    }): ReduceResult => {
      const at = deps.now();
      return commit({ v: 1, at, src: "input", input }, enqueueInput(state, input, at));
    },
    grantCredit: (tokens: number): ReduceResult => {
      const at = deps.now();
      return commit({ v: 1, at, src: "credit", tokens }, grantCredit(state, tokens, at));
    },
  };
};

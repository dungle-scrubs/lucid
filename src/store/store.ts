/**
 * The durable conversation store: the impure shell that hosts the pure
 * protocol reducer and enforces its verdicts. Owns the record directory
 * (published ATOMICALLY at creation with a 0600 secret - D-004: a first
 * attacher never mints, and a crash never leaves a half-built record),
 * the append-only NDJSON log that is the seq authority (append + fsync
 * BEFORE state advances and effects leave), and the structured boundary
 * record for every accepted/refused transition. The attach secret is
 * REDACTED before it is durable - the log must never be a second,
 * weaker copy of the credential. Clock, presence, and both sinks are
 * injected, so tests are deterministic while permissions, atomicity, and
 * torn-line repair are proven against the real filesystem. NOT
 * responsible for transport (deferred by decision) or rendering.
 * Fold currently reads the whole log at open; compaction/checkpointing
 * is a deliberate later feature, not an M5.1 requirement.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { Effect } from "../protocol/index.js";
import {
  type ChannelState,
  type ChannelStatus,
  channelStatus,
  type DecodeIssue,
  decodeFrame,
  enqueueInput,
  grantCredit,
  initialChannelState,
  type Presence,
  type ReduceResult,
  reduce,
  type TransitionRecord,
} from "../protocol/index.js";

const SECRET_BYTES = 32;
/** What replaces the credential in the durable log (fold re-injects the
 * real secret from the 0600 file before replaying an attach). */
const REDACTED = "redacted";

export class StoreError extends Error {
  override readonly name = "StoreError";
  constructor(
    readonly code:
      | "record-exists"
      | "invalid-conversation-id"
      | "missing-secret"
      | "invalid-secret"
      | "corrupt-log"
      | "fold-refused"
      | "append-failed",
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
  readonly metaPath: string;
}

/** The one place the record layout lives. */
export const pathsForDir = (dir: string): RecordPaths => ({
  dir,
  secretPath: join(dir, "secret"),
  logPath: join(dir, "log.ndjson"),
  metaPath: join(dir, "meta.json"),
});

export const recordPaths = (rootDir: string, conversationId: string): RecordPaths =>
  pathsForDir(join(rootDir, conversationId));

/** A conversation id must be a single, safe path component - anything
 * else could escape the record root or change identity on reopen. */
const validConversationId = (id: string): boolean =>
  id.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(id) && id !== "." && id !== "..";

/** Create the conversation record: dir 0700, secret 0600, empty log 0600,
 * meta carrying the identity - built in a temp sibling and published with
 * one atomic rename, so the record either exists complete or not at all,
 * and two racing creators cannot both mint (D-004). */
export const createConversationRecord = (
  rootDir: string,
  conversationId: string,
): { readonly secret: string; readonly paths: RecordPaths } => {
  if (!validConversationId(conversationId))
    throw new StoreError(
      "invalid-conversation-id",
      `conversation id is not a safe path component: ${JSON.stringify(conversationId)}`,
    );
  const paths = recordPaths(rootDir, conversationId);
  if (existsSync(paths.dir))
    throw new StoreError("record-exists", `conversation record already exists: ${paths.dir}`);
  mkdirSync(rootDir, { recursive: true });
  const staging = mkdtempSync(join(rootDir, ".create-"));
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(SECRET_BYTES))).toString("hex");
  try {
    const tmp = pathsForDir(staging);
    writeFileSync(tmp.secretPath, secret, { mode: 0o600 });
    writeFileSync(tmp.logPath, "", { mode: 0o600 });
    writeFileSync(tmp.metaPath, JSON.stringify({ v: 1, conversationId }), { mode: 0o600 });
    // mkdtemp already created the staging dir 0700; rename publishes it.
    renameSync(staging, paths.dir);
  } catch (cause) {
    rmSync(staging, { recursive: true, force: true });
    throw new StoreError("record-exists", `could not publish record at ${paths.dir}`, { cause });
  }
  return { secret, paths };
};

/** One durable log entry: everything fold needs to reproduce the
 * transition deterministically - source, input, clock reading, and (for
 * attach) the presence sample that shaped the verdict. */
type LogEntry =
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

export interface HostDeps {
  /** Injected clock - the store performs zero wall-clock reads. */
  readonly now: () => number;
  /** Latest presence sample (normalizer isInteractive, injected).
   * undefined = the host could not corroborate. */
  readonly presence: () => boolean | undefined;
  /** Every effect the reducer emits, in order (transport wiring later). */
  readonly onEffect: (effect: Effect) => void;
  /** The always-on boundary record: one structured line per transition,
   * plus one recovery line per open. Logged verbatim by the caller. */
  readonly onRecord: (record: HostRecord) => void;
}

/** The boundary record for a line that never decoded into a frame. */
export interface WireRecord {
  readonly verdict: "refused";
  readonly wire: true;
  readonly issue: DecodeIssue;
  readonly conversationId: string;
  readonly now: number;
}

/** One canonical line per open: what fold replayed and what crash repair
 * discarded, so recovery is never invisible at the boundary. Outbound
 * effects of replayed entries are NOT re-emitted here - exactly-once
 * delivery across recovery is the M5.4 handoff oracle's ground. */
export interface RecoveryRecord {
  readonly verdict: "recovered";
  readonly conversationId: string;
  readonly entries: number;
  readonly discardedBytes: number;
  readonly seq: number;
  readonly epoch: number;
}

export type HostRecord = TransitionRecord | WireRecord | RecoveryRecord;

const ctxOf = (presence: boolean | undefined): { presence?: Presence } =>
  presence === undefined ? {} : { presence: { processAlive: presence } };

const applyEntry = (state: ChannelState, entry: LogEntry, secret: string): ReduceResult => {
  switch (entry.src) {
    case "frame": {
      // The durable frame is already the DECODED shape; the credential was
      // redacted before persisting, so re-inject it for attach replay.
      const raw = entry.frame.kind === "attach" ? { ...entry.frame, secret } : entry.frame;
      const decoded = decodeFrame(raw);
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

const NL = 0x0a;

/** Fold the log into state, BYTE-accurate (offsets feed truncate, and a
 * UTF-16 offset would cascade-delete good entries after non-ASCII
 * content). Pure over the bytes. The ONLY tolerated damage is a torn
 * trailing fragment with no newline (crash mid-append); a corrupt
 * newline-terminated line anywhere is corruption and throws. */
const foldLog = (
  conversationId: string,
  secret: string,
  raw: Buffer,
): { state: ChannelState; goodBytes: number; entries: number } => {
  let state = initialChannelState({ conversationId, secret });
  let offset = 0;
  let entries = 0;
  while (offset < raw.length) {
    const nl = raw.indexOf(NL, offset);
    if (nl === -1) break; // torn trailing fragment: tolerated, repaired by caller
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
      const result = applyEntry(state, parsed, secret);
      if (result.verdict !== "accepted")
        throw new StoreError(
          "fold-refused",
          `log entry at byte ${offset} refused on fold (${result.issue}): the log only holds accepted transitions`,
        );
      state = result.state;
      entries += 1;
    }
    offset = nl + 1;
  }
  return { state, goodBytes: offset, entries };
};

const HEX_SECRET = /^[0-9a-f]{16,}$/;

export const openConversation = (dir: string, deps: HostDeps) => {
  const paths = pathsForDir(dir);
  if (!existsSync(paths.secretPath))
    throw new StoreError("missing-secret", `no secret in record dir: ${paths.secretPath}`);
  // Trim the secret so external provisioning's trailing newline is not
  // indistinguishable from an attacker; identity lives in meta, not the
  // path, so a moved record still opens under its own id.
  const secret = readFileSync(paths.secretPath, "utf8").trim();
  if (!HEX_SECRET.test(secret))
    throw new StoreError("invalid-secret", `malformed secret file: ${paths.secretPath}`);
  const conversationId = existsSync(paths.metaPath)
    ? (JSON.parse(readFileSync(paths.metaPath, "utf8")) as { conversationId: string })
        .conversationId
    : basename(dir);

  const raw: Buffer = existsSync(paths.logPath) ? readFileSync(paths.logPath) : Buffer.alloc(0);
  const folded = foldLog(conversationId, secret, raw);
  if (folded.goodBytes < raw.length) truncateSync(paths.logPath, folded.goodBytes);
  let state = folded.state;
  let goodBytes = folded.goodBytes;
  const fd = openSync(paths.logPath, "a");

  deps.onRecord({
    verdict: "recovered",
    conversationId,
    entries: folded.entries,
    discardedBytes: raw.length - folded.goodBytes,
    seq: state.seq,
    epoch: state.epoch,
  });

  /** Durability first: append + fsync BEFORE state advances or any effect
   * leaves, so a crash replays the transition instead of losing it. The
   * reducer's state is adopted on refusals too - a refused-but-alive
   * frame renews the lease, which is in-memory liveness accounting and
   * deliberately NOT durable (a restart kills the channel anyway). */
  const commit = (entry: LogEntry, result: ReduceResult): ReduceResult => {
    if (result.verdict === "accepted") {
      const line = Buffer.from(`${JSON.stringify(entry)}\n`);
      try {
        writeSync(fd, line);
        fsyncSync(fd);
      } catch (cause) {
        try {
          ftruncateSync(fd, goodBytes);
        } catch {
          // best-effort repair; the typed error below is the signal
        }
        throw new StoreError("append-failed", `could not append to ${paths.logPath}`, { cause });
      }
      goodBytes += line.length;
    }
    state = result.state;
    deps.onRecord(result.record);
    for (const effect of result.effects) deps.onEffect(effect);
    return result;
  };

  return {
    state: (): ChannelState => state,
    close: (): void => closeSync(fd),
    /** One status tick = one presence sample: the caller's tick cadence IS
     * the polling cadence (MUSE F6). An uncorroborated sample counts as
     * not-alive for NAMING only - the reducer's takeover gate still treats
     * unknown as never-blocking (D-021). */
    status: (): ChannelStatus =>
      channelStatus(state, deps.now(), { processAlive: deps.presence() === true }),
    handleFrame: (
      line: string,
    ): ReduceResult | { verdict: "refused"; wire: true; issue: DecodeIssue } => {
      const at = deps.now();
      let parsed: unknown | undefined;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        parsed = undefined;
      }
      const decoded =
        parsed === undefined
          ? ({ verdict: "refused", issue: "not-json" } as const)
          : decodeFrame(parsed);
      if (decoded.verdict !== "ok") {
        deps.onRecord({
          verdict: "refused",
          wire: true,
          issue: decoded.issue,
          conversationId,
          now: at,
        });
        deps.onEffect({ type: "send", frame: { kind: "refused", issue: decoded.issue } });
        return { verdict: "refused", wire: true, issue: decoded.issue };
      }
      const presence = decoded.frame.kind === "attach" ? deps.presence() : undefined;
      // The DECODED frame persists - never the raw wire object - and the
      // credential is redacted so the log is not a second, weaker copy.
      const durable =
        decoded.frame.kind === "attach" ? { ...decoded.frame, secret: REDACTED } : decoded.frame;
      const entry: LogEntry = {
        v: 1,
        at,
        src: "frame",
        frame: durable as unknown as Record<string, unknown>,
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

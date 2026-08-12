/**
 * The durable conversation store: the impure shell that hosts the pure
 * protocol reducer and enforces its verdicts. Owns the record directory
 * (published atomically at creation with a 0600 secret - D-004), the
 * append-only NDJSON log that is the seq authority, and the structured
 * boundary record for every accepted/refused transition. The log itself
 * - file, offset, flock, fold, repair - is owned by the deep module
 * `ConversationLog` (`src/store/log.ts`); this file owns the reducer,
 * the secret redaction, and the single `transact` seam that funnels
 * every entry (frame / input / credit) through one lock→catch-up→
 * reduce→write→effects→record discipline (C01). What it is NOT:
 * transport, rendering, or the flock primitive.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
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
  type Presence,
  type ReduceResult,
  reduce,
  type TransitionRecord,
} from "../protocol/index.js";
import {
  pathsForDir,
  type RecordPaths,
  recordPaths,
  StoreError,
  validConversationId,
} from "./errors.js";
import type { LockEvent } from "./lock.js";
import { type AppendEvent, createLog, foldLog, type LogEntry } from "./log.js";

const SECRET_BYTES = 32;
const REDACTED = "redacted";

export { pathsForDir, type RecordPaths, recordPaths, StoreError, validConversationId };

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
    renameSync(staging, paths.dir);
  } catch (cause) {
    rmSync(staging, { recursive: true, force: true });
    throw new StoreError("record-exists", `could not publish record at ${paths.dir}`, { cause });
  }
  return { secret, paths };
};

export interface HostDeps {
  readonly now: () => number;
  readonly presence: () => boolean | undefined;
  readonly onEffect: (effect: Effect) => void;
  readonly onRecord: (record: HostRecord) => void;
  readonly onLockEvent?: (event: LockEvent) => void;
  readonly onAppendEvent?: (event: AppendEvent) => void;
}

export interface WireRecord {
  readonly verdict: "refused";
  readonly wire: true;
  readonly issue: DecodeIssue;
  readonly conversationId: string;
  readonly now: number;
}

export interface RecoveryRecord {
  readonly verdict: "recovered";
  readonly conversationId: string;
  readonly entries: number;
  readonly discardedBytes: number;
  readonly seq: number;
  readonly epoch: number;
}

export type HostRecord = TransitionRecord | WireRecord | RecoveryRecord;

export type { AppendEvent, LogEntry, Transcript, TranscriptEvent, TranscriptInput } from "./log.js";

const ctxOf = (presence: boolean | undefined): { presence?: Presence } =>
  presence === undefined ? {} : { presence: { processAlive: presence } };

const HEX_SECRET = /^[0-9a-f]{16,}$/;

/** Read the record's secret + identity — the single place both `openConversation` and `viewConversation` load it. */
const readRecordFiles = (
  dir: string,
): { secret: string; conversationId: string; paths: RecordPaths } => {
  const paths = pathsForDir(dir);
  if (!existsSync(paths.secretPath))
    throw new StoreError("missing-secret", `no secret in record dir: ${paths.secretPath}`);
  const secret = readFileSync(paths.secretPath, "utf8").trim();
  if (!HEX_SECRET.test(secret))
    throw new StoreError("invalid-secret", `malformed secret file: ${paths.secretPath}`);
  const conversationId = existsSync(paths.metaPath)
    ? (JSON.parse(readFileSync(paths.metaPath, "utf8")) as { conversationId: string })
        .conversationId
    : basename(dir);
  return { secret, conversationId, paths };
};

export const openConversation = (dir: string, deps: HostDeps) => {
  const { secret, conversationId, paths } = readRecordFiles(dir);

  const log = createLog(paths, secret, conversationId, {
    onLockEvent: deps.onLockEvent,
    onAppendEvent: deps.onAppendEvent,
  });

  // Recovery is emitted once per open, from the log's initial fold
  const rec = log.recovery();
  deps.onRecord({
    verdict: "recovered",
    conversationId,
    entries: rec.entries,
    discardedBytes: rec.discardedBytes,
    seq: log.state().seq,
    epoch: log.state().epoch,
  });

  /**
   * The ONE place durability, effects, and boundary records meet.
   * Every host transition — frame, input, credit — funnels through
   * this seam so the lock→catch-up→reduce→write→effects→record
   * discipline exists once, not three times (C01).
   */
  const transact = (
    entry: LogEntry | null,
    produce: (s: ChannelState) => {
      result: ReduceResult;
      frame: import("../protocol/index.js").Frame | null;
    },
  ): ReduceResult => {
    const result = log.append((s) => {
      const { result: r, frame } = produce(s);
      // `entry: null` means wire-decode failed — nothing durable, but the
      // reducer still produced a refused record; log treats null as no-op
      // (0 bytes) and we surface effects/record here.
      return { entry, result: r, frame };
    });
    for (const effect of result.effects) deps.onEffect(effect);
    deps.onRecord((result as unknown as { record: HostRecord }).record);
    return result;
  };

  return {
    state: (): ChannelState => log.state(),
    close: (): void => log.close(),
    transcript: () => log.transcript(),
    status: (): ChannelStatus =>
      channelStatus(log.state(), deps.now(), { processAlive: deps.presence() === true }),
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
      const durable =
        decoded.frame.kind === "attach" ? { ...decoded.frame, secret: REDACTED } : decoded.frame;
      const entry: LogEntry = {
        v: 1,
        at,
        src: "frame",
        frame: durable as unknown as Record<string, unknown>,
        ...(presence === undefined ? {} : { presence }),
      };
      return transact(entry, (s) => {
        const r = reduce(s, decoded.frame, at, ctxOf(presence));
        return { result: r, frame: decoded.frame };
      });
    },
    enqueueInput: (input: {
      readonly id: string;
      readonly text: string;
      readonly mode: "queue" | "steer";
      readonly turnId?: string;
    }): ReduceResult => {
      const at = deps.now();
      const entry: LogEntry = { v: 1, at, src: "input", input };
      return transact(entry, (s) => {
        const r = enqueueInput(s, input, at);
        return { result: r, frame: null };
      });
    },
    grantCredit: (tokens: number): ReduceResult => {
      const at = deps.now();
      const entry: LogEntry = { v: 1, at, src: "credit", tokens };
      return transact(entry, (s) => {
        const r = grantCredit(s, tokens, at);
        return { result: r, frame: null };
      });
    },
  };
};

/**
 * Lock-free view of a conversation's durable state. Tolerates a torn
 * trailing line without acquiring the append lock and without repairing
 * the file - a pure reader for `lucid watch`. Delegates to the same
 * `readRecordFiles + foldLog` seam the host uses, so there is one
 * reader discipline, not two (C01).
 */
export const viewConversation = (
  dir: string,
): { state: ChannelState; transcript: import("./log.js").Transcript; goodBytes: number } => {
  const { secret, conversationId, paths } = readRecordFiles(dir);
  const raw = existsSync(paths.logPath) ? readFileSync(paths.logPath) : Buffer.alloc(0);
  const folded = foldLog(conversationId, secret, raw);
  return {
    state: folded.state,
    transcript: {
      events: [...folded.transcript.events],
      inputs: [...folded.transcript.inputs],
      aborted: [...folded.transcript.aborted],
    },
    goodBytes: folded.goodBytes,
  };
};

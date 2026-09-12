import { ARTIFACT_BYTES_MAX } from "../protocol/frames.js";
import { closeFinishedNativeContextOffers, closeNativeContextOffers } from "./context-offer.js";
import { completeLegacyPreference, type DriverChoice } from "./driver-preference.js";
import type { PresenceHandle } from "./presence.js";
/**
 * ConversationHost — the deep module that owns the durable store's
 * read and write discipline.
 *
 * `src/store/store.ts` previously owned three things in one file:
 * `createConversationRecord` (mint), `openConversation` (transact +
 * snapshot + wire redaction + recovery), and the lock-free readers
 * `viewConversation` / `viewSnapshot`. Fixing a projection bug required
 * bouncing between the host's `snapshot()` and the free `viewSnapshot()`
 * — two derivations from the same fold — and the 10-method surface
 * (`handleFrame`/`enqueueInput`/`grantCredit`/`state`/`transcript`/
 * `status`/`snapshot`/`view*`/`close`) made the interface nearly as
 * wide as the implementation (shallow). The durable log itself was deep
 * (`ConversationLog`), the reducer was deep (3 ledgers), but the host
 * between them was not.
 *
 * Now one module owns the whole host discipline — record-file reading
 * (secret + identity, D-004), the single `transact` seam
 * (lock→catch-up→reduce→write→lease-gated effects→record, C01 + RFC-04
 * R2), secret redaction, recovery emission, and the single snapshot
 * derivation
 * (`log.state()` once → transcript + status from that same state +
 * injected clock/presence, 01). Callers see a small, deep interface:
 * `createConversationHost(dir, deps) → ConversationHost` with
 * `{snapshot, state, transcript, status, handleFrame, enqueueInput,
 * grantCredit, close}` plus lock-free `viewConversation` / `viewSnapshot`
 * that share the same fold seam. The mint (`createConversationRecord`)
 * stays in `store.ts` — this module is the host, not the mint.
 *
 * Deletion test: deleting this module would scatter secret-load,
 * redaction, transact, recovery, and snapshot derivation across every
 * CLI command, every hook, and every test that touches the log.
 *
 * What it is NOT: it does not own the log file (ConversationLog does),
 * the flock primitive, or the record mint.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import type { WebLinkProbe } from "../links/check-web-link.js";
import { validateArtifactLinks } from "../links/validate-artifact-links.js";
import { ownerPresence, readProcessOwner, terminalPresence } from "../process-owner.js";
import type { ArtifactLinkRefusal } from "../protocol/artifact-links.js";
import { linkRefusal } from "../protocol/artifact-links.js";
import type { ConnectionControl, ConnectionFact, NativeBinding } from "../protocol/connection.js";
import {
  connectionId,
  connectionParticipation,
  connectionRegistration,
  hasUnsettledNativeWork,
  nativeOwners,
  parseConnectionFact,
  parseNativeBinding,
  reduceConnection,
  refuseConnection,
  sameNativeBinding,
  sameNativeHistory,
} from "../protocol/connection.js";
import {
  type ContextFact,
  type ContextOfferRequest,
  confirmedContextThrough,
  contextAttempt,
  contextConfirmationLimit,
  parseContextFact,
  reduceContextCoverage,
} from "../protocol/context-coverage.js";
import {
  type AttemptStart,
  appliedRecovery,
  parseExecutionFact,
  reconcileExecutionFact,
  reduceExecution,
  refuseExecution,
} from "../protocol/execution.js";
import type { Frame, HarnessName, ProtocolIssue } from "../protocol/frames.js";
import { supportsManagedInput } from "../protocol/frames.js";
import { HubError } from "../protocol/hub-errors.js";
import type { Effect } from "../protocol/index.js";
import {
  type ChannelState,
  type ChannelStatus,
  channelStatus,
  type DecodeIssue,
  decodeFrame,
  enqueueInput,
  grantCredit,
  type InputMode,
  type Presence,
  type ReduceResult,
  reduce,
  type TransitionRecord,
} from "../protocol/index.js";
import {
  browserApprovalFact,
  parseApprovalFact,
  reduceApproval,
} from "../protocol/native-approvals.js";
import { sameProcessOwner } from "../protocol/process-owner.js";
import { enqueueManagedInput, inputFrame } from "../protocol/reducer.js";
import { DiscoveryIndex } from "./discovery.js";
import {
  captureDispatchContext,
  type DispatchSnapshot,
  dispatchStamp,
} from "./dispatch-context.js";
import { pathsForDir, type RecordPaths, StoreError } from "./errors.js";
import type { LockEvent } from "./flock.js";
import type { ArtifactVersions } from "./log.js";
import {
  type AppendEvent,
  type ArtifactVersion,
  type CollectedBatch,
  createLog,
  foldLog,
  type LogEntry,
  readArtifactVersion,
} from "./log.js";
import { nativeInputCandidates, nativePreparationPrerequisite } from "./managed-readiness.js";
import { withNativeSessionAdmission } from "./native-registration.js";
import { presenceHeld } from "./presence.js";
import { readRecordIdentity, readRecordMetadata } from "./record-identity.js";

const REDACTED = "redacted";

export type {
  AppendEvent,
  ArtifactVersion,
  CollectedBatch,
  CollectedEntry,
  LogEntry,
  Transcript,
  TranscriptEvent,
  TranscriptInput,
} from "./log.js";

export interface HostDeps {
  /** Configured native registry root. Never inferred from a moved record's parent directory. */
  readonly nativeSessionRoot?: string;
  /** Called under the append lock. The caller holds the registration lock for this transaction. */
  readonly connectionAuthority?: () => NativeBinding | undefined;
  readonly probeArtifactLink?: WebLinkProbe;
  readonly ownerPresence?: (
    owner: import("../protocol/process-owner.js").ProcessOwner,
  ) => boolean | undefined;
  readonly expectedConversationId?: string;
  readonly now: () => number;
  /** The normalizer's ps-level INTERACTIVE-process probe. Liveness
   * arithmetic and the attach reducer's presence corroboration read it.
   * It is NOT flock ownership: a headless runtime that holds the record's
   * presence lock can still answer `undefined` here, and a living
   * interactive process says `true` while holding nothing. Ownership is
   * `executorLease` (RFC-04 M2: the two must never be conflated). */
  readonly presence: () => boolean | undefined;
  /** RFC-04 R2: does THIS process hold the record's presence lock — the
   * executor lease. The only gate on acting on effects: a process that
   * does not hold it still writes, and the effects stay on the result and
   * in the log for the holder to rediscover on its catch-up fold. The
   * runtime passes a closure over the `PresenceHandle` it actually holds;
   * callers that never acquire the lock state `() => false`. */
  readonly executorLease: () => boolean;
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
  /** Durable input entries the fold carried and the reducer refused -
   * RFC-05 B4's visibility: an input mode only a newer build knows is
   * refused and reported here, never applied and never fatal. */
  readonly refusedInputs: number;
  readonly seq: number;
  readonly epoch: number;
}

export type HostRecord = TransitionRecord | WireRecord | RecoveryRecord;

export interface HostSnapshot {
  readonly state: ChannelState;
  readonly transcript: import("./log.js").Transcript;
  readonly status: ChannelStatus;
}

export interface ViewSnapshot {
  readonly state: ChannelState;
  readonly transcript: import("./log.js").Transcript;
  readonly status: ChannelStatus;
  readonly goodBytes: number;
}

const ctxOf = (presence: boolean | undefined): { presence?: Presence } =>
  presence === undefined ? {} : { presence: { processAlive: presence } };

const HEX_SECRET = /^[0-9a-f]{16,}$/;

function nativeFolderIssue(
  dir: string,
  registration: NativeBinding | undefined,
): ProtocolIssue | undefined {
  try {
    const folder = readRecordMetadata(dir).workingDirectory;
    if (!registration || typeof folder !== "string") return "connection-folder-unverified";
    return realpathSync(folder) === realpathSync(registration.workingDirectory)
      ? undefined
      : "connection-folder-mismatch";
  } catch {
    return "connection-folder-unverified";
  }
}

/** Single place the host, the lock-free readers, and the tailer load
 * the record (secret + identity + paths). Thrown per call, not at
 * construction, so a reader that starts before the record exists can
 * surface the error and pick the record up once it appears. */
export const readRecordFiles = (
  dir: string,
): { secret: string; conversationId: string; paths: RecordPaths } => {
  const paths = pathsForDir(dir);
  if (!existsSync(paths.secretPath))
    throw new StoreError("missing-secret", `no secret in record dir: ${paths.secretPath}`);
  const secret = readFileSync(paths.secretPath, "utf8").trim();
  if (!HEX_SECRET.test(secret))
    throw new StoreError("invalid-secret", `malformed secret file: ${paths.secretPath}`);
  const conversationId = readRecordIdentity(dir);
  return { secret, conversationId, paths };
};

export interface ConversationHost {
  decideApproval(decision: unknown, available?: () => boolean): ReduceResult;
  writeApproval(fact: unknown, applicable?: () => boolean): ReduceResult;
  /** Checks before locking and again under the append lock. Native listener callers hold the
   * registration lock throughout; the raw kernel handle grants no authority. */
  acquireExecutor(
    request:
      | { readonly kind: "headless" }
      | {
          readonly binding: NativeBinding;
          readonly inputId: string;
          readonly kind: "native-headless";
        }
      | {
          readonly kind: "listener";
          readonly fact: Extract<ConnectionFact, { kind: "listener-enabled" }>;
        },
    acquire: () => PresenceHandle,
  ):
    | { readonly verdict: "accepted"; readonly lease: PresenceHandle }
    | { readonly verdict: "refused"; readonly issue: ProtocolIssue };
  controlConnection(control: ConnectionControl): ReduceResult;
  writeConnection(fact: unknown): ReduceResult;
  captureDispatch(
    inputId: string,
    from: number | ((state: ChannelState) => number),
  ): DispatchSnapshot;
  writePreparedExecution(fact: AttemptStart, stamp: string): ReduceResult;
  hasAcceptedInput(id: string): boolean;
  recoveryInputs(): readonly Frame[];
  contextCoverage(harness: HarnessName, sessionId: string): number;
  offerConversationContext(offer: ContextOfferRequest): ReduceResult;
  confirmConversationContext(turnId: string): ReduceResult;
  writeExecution(fact: unknown, applicable?: () => boolean): ReduceResult;
  reconcileExecution(inputId: string, expectedAttempt: number): ReduceResult;
  acceptInput(
    input: { readonly id: string; readonly text: string; readonly mode: "queue" },
    options?: { readonly completeSettings?: DriverChoice; readonly managed?: boolean },
  ):
    | {
        readonly verdict: "accepted";
        readonly receipt: { readonly inputId: string; readonly seq: number };
      }
    | { readonly verdict: "refused"; readonly issue: string };
  readonly conversationId: string;
  readonly dir: string;
  /** Atomic snapshot: one `log.state()` read → transcript + status. */
  readonly snapshot: () => HostSnapshot;
  readonly state: () => ChannelState;
  readonly transcript: () => import("./log.js").Transcript;
  readonly status: () => ChannelStatus;
  readonly close: () => void;
  handleFrame(line: string): ReduceResult | { verdict: "refused"; wire: true; issue: DecodeIssue };
  enqueueInput(
    input: {
      readonly id: string;
      readonly text: string;
      readonly mode: InputMode;
      readonly turnId?: string;
    },
    completeSettings?: DriverChoice,
  ): ReduceResult;
  /** Browser-style queue submission with accepted-history reconciliation. */
  submitInput(input: {
    readonly id: string;
    readonly text: string;
  }):
    | { readonly inputId: string; readonly verdict: "accepted" }
    | { readonly issue: string; readonly verdict: "refused" };
  grantCredit(tokens: number): ReduceResult;
  /** Fold the log under the append lock and collect effects from `fromOffset`.
   * Thin delegation to the log's seam — the lock, repair, and return-
   * never-dispatch discipline lives in `ConversationLog`. */
  collectEffects(fromOffset: number): CollectedBatch;
  /** The delivery cursor (RFC-04 R4). See `ConversationLog.cursor`. */
  cursor(): number;
  /** Durably advance the delivery cursor. See `ConversationLog.advanceCursor`. */
  advanceCursor(offset: number): void;
  /** Seek index built during the fold that already happens at open — reading
   * a version is a seek, not a fold. */
  artifactIndex(): ReadonlyMap<string, number>;
  artifactHeads(): ReadonlyMap<string, number>;
  artifactVersions(): ArtifactVersions;
  /** artifactId -> its title. An id absent from this map has no title and
   * displays as its id (RFC-07 R11). */
  artifactTitles(): ReadonlyMap<string, string>;
  /** Write a fact about an artifact. Never a version: naming a document is
   * not a change to the document. */
  writeArtifactMeta(params: {
    readonly artifactId: string;
    readonly title?: string;
  }): { verdict: "accepted" } | { verdict: "refused"; issue: string };
  /** Store a file a person attached, and record that it exists (RFC-11).
   * Returns the hash it is stored under. */
  writeAttachment(params: {
    readonly bytes: Uint8Array;
    readonly contentType: string;
    readonly name: string;
    readonly text: boolean;
  }):
    | { verdict: "accepted"; hash: string }
    | { verdict: "refused"; issue: "attachment-too-large" | "attachment-invalid" };
  /** Read an artifact version by seek. */
  comparisonSnapshot(artifactId: string): {
    readonly head: number | null;
    readonly artifact: import("./log.js").ArtifactVersion | null;
  };
  readArtifact(artifactId: string, version: number): import("./log.js").ArtifactVersion | null;
  /** Append an artifact version. Over-size is refused and the record still
   * opens; hash is written for every version from the first. */
  writeArtifact(params: {
    readonly artifactId: string;
    readonly version: number;
    readonly author: string;
    readonly contentType: string;
    readonly bytes: string;
    readonly basedOn?: number;
    readonly values?: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
  }): Promise<
    | { verdict: "accepted"; version: import("./log.js").ArtifactVersion }
    | { verdict: "refused"; issue: "artifact-too-large" | "artifact-version-exists" }
    | ArtifactLinkRefusal
  >;
}

export const createConversationHost = (dir: string, deps: HostDeps): ConversationHost => {
  const { secret, conversationId, paths } = readRecordFiles(dir);
  let nativeAttachment:
    | { readonly binding: NativeBinding; readonly inputId: string; readonly lease: PresenceHandle }
    | undefined;
  const nativeRecords = deps.nativeSessionRoot
    ? new DiscoveryIndex(deps.nativeSessionRoot)
    : undefined;

  if (deps.expectedConversationId !== undefined && deps.expectedConversationId !== conversationId)
    throw new StoreError("corrupt-log", "Record identity changed");
  const log = createLog(paths, secret, conversationId, {
    now: deps.now,
    onLockEvent: deps.onLockEvent,
    onAppendEvent: deps.onAppendEvent,
  });

  closeFinishedNativeContextOffers(log.state().connection);
  const rec = log.recovery();
  deps.onRecord({
    verdict: "recovered",
    conversationId,
    entries: rec.entries,
    discardedBytes: rec.discardedBytes,
    refusedInputs: rec.refusedInputs,
    seq: log.state().seq,
    epoch: log.state().epoch,
  });

  const publish = (result: ReduceResult): ReduceResult => {
    if (deps.executorLease()) for (const effect of result.effects) deps.onEffect(effect);
    deps.onRecord(result.record);
    return result;
  };

  const transactDynamic = (produce: Parameters<typeof log.append>[0]): ReduceResult => {
    const result = log.append(produce);
    // RFC-04 R2: only the presence-lock holder acts on effects. A
    // non-holder's write still lands and the reduce still returns its
    // effects — the holder rediscovers them on its catch-up fold — but
    // this process hands none to its own sink. The gate reads
    // `executorLease`, never `presence`: that probe reports the
    // interactive process's liveness, not this process's lock ownership.
    return publish(result);
  };

  const transact = (
    entry: LogEntry | null,
    produce: (s: ChannelState) => {
      result: ReduceResult;
      frame: import("../protocol/index.js").Frame | null;
    },
  ): ReduceResult => transactDynamic((s) => ({ entry, ...produce(s) }));

  const snapshot = (): HostSnapshot => {
    const s = log.state();
    return {
      state: s,
      transcript: log.transcript(),
      status: channelStatus(s, deps.now(), { processAlive: deps.presence() === true }),
    };
  };

  const collectEffects = (fromOffset: number): CollectedBatch => log.collectEffects(fromOffset);
  const cursor = (): number => log.cursor();
  const advanceCursor = (offset: number): void => log.advanceCursor(offset);
  const artifactIndex = (): ReadonlyMap<string, number> => log.artifactIndex();
  const readArtifact = (
    artifactId: string,
    version: number,
  ): import("./log.js").ArtifactVersion | null => log.readArtifact(artifactId, version);
  const artifactTitles = (): ReadonlyMap<string, string> => log.artifactTitles();
  const writeArtifactMeta = (params: {
    readonly artifactId: string;
    readonly title?: string;
  }): { verdict: "accepted" } | { verdict: "refused"; issue: string } =>
    log.writeArtifactMeta(params);
  const writeAttachment = (params: {
    readonly bytes: Uint8Array;
    readonly contentType: string;
    readonly name: string;
    readonly text: boolean;
  }):
    | { verdict: "accepted"; hash: string }
    | { verdict: "refused"; issue: "attachment-too-large" | "attachment-invalid" } =>
    log.writeAttachment(params);
  const artifactLifetime = new AbortController();
  const writeArtifact: ConversationHost["writeArtifact"] = async (params) => {
    const { signal: callerSignal, ...entry } = params;
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, artifactLifetime.signal])
      : artifactLifetime.signal;
    if (signal.aborted) return linkRefusal("artifact-link-unverified", "", "admission cancelled");
    if (entry.bytes.length > ARTIFACT_BYTES_MAX)
      return { verdict: "refused", issue: "artifact-too-large" };
    if (entry.author === "agent") {
      const links = await validateArtifactLinks(entry.bytes, signal, deps.probeArtifactLink);
      if (links) return links;
    }
    if (signal.aborted) return linkRefusal("artifact-link-unverified", "", "admission cancelled");
    return log.writeArtifact(entry);
  };

  const writeContext = (produce: (state: ChannelState) => ContextFact | null): ReduceResult => {
    const at = deps.now();
    return transactDynamic((state) => {
      const fact = parseContextFact(produce(state));
      const result = reduceContextCoverage(state, fact, at, deps.executorLease());
      return {
        result,
        frame: null,
        entry:
          fact && result.verdict === "accepted" && result.state !== state
            ? { v: 1, at, src: "context", payloadVersion: 1, fact }
            : null,
      };
    });
  };

  const writeApproval = (
    raw: unknown,
    authority: "browser" | "executor",
    available?: () => boolean,
  ): ReduceResult => {
    const at = deps.now();
    return transactDynamic((state) => {
      const fact =
        authority === "browser" ? browserApprovalFact(state, raw) : parseApprovalFact(raw);
      const proposed = reduceApproval(
        state,
        fact,
        at,
        authority === "executor" && !deps.executorLease() ? "none" : authority,
      );
      const result =
        proposed.verdict === "accepted" && proposed.state !== state && available && !available()
          ? refuseExecution(state, at, "approval-unavailable")
          : proposed;
      return {
        result,
        frame: null,
        entry:
          fact && result.verdict === "accepted" && result.state !== state
            ? { v: 1, at, src: "execution", payloadVersion: 3, approval: fact }
            : null,
      };
    });
  };

  const writeExecution = (
    produce: (state: ChannelState) => ReturnType<typeof reconcileExecutionFact>,
  ): ReduceResult => {
    const at = deps.now();
    return transactDynamic((state) => {
      const decision = produce(state);
      const fact = "issue" in decision ? null : decision;
      const result =
        "issue" in decision
          ? refuseExecution(state, at, decision.issue)
          : state.connection && fact?.kind === "attempt-started"
            ? refuseExecution(state, at, "connection-not-admitted")
            : reduceExecution(state, fact, at, deps.executorLease());
      return {
        result,
        frame: null,
        entry:
          fact && result.verdict === "accepted" && result.state !== state
            ? { v: 1, at, src: "execution", payloadVersion: 1, fact }
            : null,
      };
    });
  };

  // The registration lock stabilizes native admission across records. Keep these reads
  // outside this record's append lock so unrelated feedback can still be saved.
  const relatedLaunchIssue = (registration: NativeBinding): ProtocolIssue | undefined => {
    try {
      if (!nativeRecords) return "connection-unverified";
      const listing = nativeRecords.scan();
      const id = log.state().conversationId;
      const selectedDir = listing.identities.get(id);
      if (listing.errors.length || !selectedDir || realpathSync(selectedDir) !== realpathSync(dir))
        return "connection-unverified";
      for (const [candidateId, candidateDir] of listing.identities) {
        if (candidateId === id) continue;
        const candidate = viewConversation(candidateDir).state;
        if (!sameNativeHistory(candidate.connection?.binding, registration)) continue;
        const present = terminalPresence(nativeOwners(candidate), (owner) =>
          owner ? (deps.ownerPresence ?? ownerPresence)(owner) : undefined,
        );
        if (present !== false) return present ? "connection-conflict" : "connection-unverified";
        if (hasUnsettledNativeWork(candidate)) return "execution-blocked";
        const held = presenceHeld(candidateDir);
        if (held !== false) return held ? "connection-conflict" : "connection-unverified";
      }
      return undefined;
    } catch {
      return "connection-unverified";
    }
  };

  const preparedExecutionIssue = (
    state: ChannelState,
    fact: AttemptStart,
    stamp: string | undefined,
    heads = log.artifactHeads(),
  ): ProtocolIssue | undefined =>
    dispatchStamp(
      dir,
      fact.inputId,
      fact.context,
      state.epoch,
      heads,
      state.connection?.revision,
    ) === stamp
      ? undefined
      : "execution-stale";

  const launchOwnerIssue = (
    requester: NativeBinding["owner"] | undefined,
  ): ProtocolIssue | undefined => {
    if (!deps.executorLease()) return "executor-required";
    return requester && sameProcessOwner(readProcessOwner(process.pid) ?? undefined, requester)
      ? undefined
      : "connection-unverified";
  };

  const terminalDepartureIssue = (state: ChannelState): ProtocolIssue | undefined => {
    try {
      const present = terminalPresence(nativeOwners(state), (owner) =>
        owner ? (deps.ownerPresence ?? ownerPresence)(owner) : deps.presence(),
      );
      return present === true
        ? "connection-conflict"
        : present === undefined
          ? "connection-unverified"
          : undefined;
    } catch {
      return "connection-unverified";
    }
  };

  const nativeHeadlessIssue = (
    state: ChannelState,
    binding: NativeBinding,
    inputId: string,
  ): ProtocolIssue | undefined => {
    if (!sameNativeBinding(state.connection?.binding, binding)) return "connection-unverified";
    return (
      nativeFolderIssue(dir, binding) ??
      (nativeInputCandidates(dir, state, log.artifactHeads())[0] !== inputId
        ? "execution-ineligible"
        : undefined)
    );
  };

  const evaluateConnection = (
    state: ChannelState,
    raw: unknown,
    at: number,
    requireLease: boolean,
  ): { readonly fact: ConnectionFact | null; readonly result: ReduceResult } => {
    const fact = parseConnectionFact(raw);
    if (fact?.kind === "launch-refused") {
      const pending = state.connection?.launches[fact.launchId];
      const issue = launchOwnerIssue(pending?.launch.requester);
      const result = issue ? refuseConnection(state, at, issue) : reduceConnection(state, fact, at);
      return { fact, result };
    }
    if (fact?.kind === "launch-intended") {
      const decide = (): ReduceResult => {
        const ownerIssue = launchOwnerIssue(fact.launch.requester);
        if (ownerIssue) return refuseConnection(state, at, ownerIssue);
        const folderIssue = nativeFolderIssue(dir, fact.launch.registration);
        if (folderIssue) return refuseConnection(state, at, folderIssue);
        const heads = log.artifactHeads();
        if (
          !hasUnsettledNativeWork(state) &&
          nativeInputCandidates(dir, state, heads)[0] !== fact.launch.inputId
        )
          return refuseConnection(state, at, "execution-ineligible");
        if (
          fact.launch.execution &&
          state.connection?.actions[fact.actionId] !== JSON.stringify(fact) &&
          preparedExecutionIssue(state, fact.launch.execution, fact.stamp, heads) !== undefined
        )
          return refuseConnection(state, at, "execution-stale");
        let present: boolean | undefined;
        try {
          present = terminalPresence(nativeOwners(state), (owner) =>
            owner ? (deps.ownerPresence ?? ownerPresence)(owner) : undefined,
          );
        } catch {
          /* Unknown native ownership cannot admit a launch. */
        }
        if (present !== false)
          return refuseConnection(
            state,
            at,
            present ? "connection-conflict" : "connection-unverified",
          );
        return reduceConnection(state, fact, at);
      };
      return { fact, result: decide() };
    }
    const cancellation = fact?.kind === "input-cancelled";
    const disabling = fact?.kind === "listener-disabled";
    const registration = fact ? connectionRegistration(state.connection, fact) : undefined;
    const needsExecutor =
      fact?.kind === "listener-enabled" ||
      fact?.kind === "offer-started" ||
      fact?.kind === "input-held";
    const participation = fact ? connectionParticipation(state.connection, fact) : undefined;
    const currentProcess = needsExecutor || disabling ? readProcessOwner(process.pid) : undefined;
    const helperDisabling =
      disabling &&
      !!currentProcess &&
      sameProcessOwner(participation?.executorOwner, currentProcess) &&
      (!requireLease || deps.executorLease());
    const settlement =
      cancellation ||
      disabling ||
      fact?.kind === "receipt-confirmed" ||
      fact?.kind === "offer-outcome";
    let authority: NativeBinding | null = null;
    let verified = cancellation || helperDisabling;
    if (!cancellation && !helperDisabling) {
      try {
        authority = parseNativeBinding(deps.connectionAuthority?.());
        verified =
          !!authority &&
          sameNativeBinding(registration, authority) &&
          (deps.ownerPresence ?? ownerPresence)(authority.owner) === true;
      } catch {
        // Failed native inspection cannot authorize a control write.
      }
    }
    // Native Interrupt runs before the harness kills its helper. It may revoke that
    // exact participation, but cannot take its executor lease or select feedback.
    const nativeInterrupt =
      disabling && fact?.reason === "interrupted" && verified && authority !== null;
    const needsOwnedExecutor = needsExecutor || (disabling && !nativeInterrupt);
    let otherOwners: boolean | undefined = false;
    if (needsExecutor && authority) {
      try {
        otherOwners = terminalPresence(
          nativeOwners(state).filter((entry) => !sameProcessOwner(entry.owner, authority.owner)),
          (owner) => (owner ? (deps.ownerPresence ?? ownerPresence)(owner) : undefined),
        );
      } catch {
        otherOwners = undefined;
      }
    }
    let preparationIssue: ProtocolIssue | undefined;
    const repeated = fact && state.connection?.actions[fact.actionId] === JSON.stringify(fact);
    if (fact?.kind === "offer-started" && !repeated) {
      const heads = log.artifactHeads();
      if (nativeInputCandidates(dir, state, heads)[0] !== fact.offer.inputId)
        preparationIssue = "execution-ineligible";
      else if (
        dispatchStamp(
          dir,
          fact.offer.inputId,
          fact.offer.context,
          state.epoch,
          heads,
          state.connection?.revision,
        ) !== fact.stamp
      )
        preparationIssue = "execution-stale";
    }
    if (fact?.kind === "input-held" && !repeated) {
      const heads = log.artifactHeads();
      if (nativeInputCandidates(dir, state, heads)[0] !== fact.hold.inputId)
        preparationIssue = "execution-ineligible";
      else if (nativePreparationPrerequisite(dir, state, heads) !== fact.hold.prerequisite)
        preparationIssue = "execution-stale";
    }
    const folderIssue = settlement ? undefined : nativeFolderIssue(dir, registration);
    const decide = (): ReduceResult => {
      if (!fact) return refuseConnection(state, at, "invalid-connection");
      if (requireLease && needsOwnedExecutor && !deps.executorLease())
        return refuseConnection(state, at, "executor-required");
      if (
        needsOwnedExecutor &&
        (!currentProcess || !sameProcessOwner(participation?.executorOwner, currentProcess))
      )
        return refuseConnection(state, at, "connection-unverified");
      if (!verified) return refuseConnection(state, at, "connection-unverified");
      if (folderIssue) return refuseConnection(state, at, folderIssue);
      if (otherOwners === undefined) return refuseConnection(state, at, "connection-unverified");
      if (otherOwners) return refuseConnection(state, at, "connection-conflict");
      if (preparationIssue) return refuseConnection(state, at, preparationIssue);
      return reduceConnection(state, fact, at);
    };
    const result = decide();
    return { fact, result };
  };

  const writeConnection = (
    produce: (
      state: ChannelState,
    ) => { readonly fact: unknown } | { readonly issue: ProtocolIssue },
  ): ReduceResult => {
    const at = deps.now();
    let settled: { owner: NativeBinding["owner"]; offerId: string } | undefined;
    const written = transactDynamic((state) => {
      const decision = produce(state);
      if ("issue" in decision)
        return { entry: null, frame: null, result: refuseConnection(state, at, decision.issue) };
      const { fact, result } = evaluateConnection(state, decision.fact, at, true);
      const registration = fact ? connectionRegistration(state.connection, fact) : undefined;
      if (result.verdict === "accepted" && fact?.kind === "offer-outcome" && registration)
        settled = { offerId: fact.offerId, owner: registration.owner };
      return {
        entry:
          fact && result.verdict === "accepted" && result.state !== state
            ? { at, connection: fact, payloadVersion: 2, src: "execution", v: 1 }
            : null,
        frame: null,
        result,
      };
    });
    if (written.verdict === "accepted" && settled)
      closeNativeContextOffers(settled.owner, settled.offerId);
    return written;
  };

  const withNativeAdmission = <TValue>(
    binding: NativeBinding,
    operation: () => TValue,
    refuse: (issue: ProtocolIssue) => TValue,
  ): TValue => {
    if (!deps.nativeSessionRoot) return refuse("connection-unverified");
    const result = withNativeSessionAdmission(
      deps.nativeSessionRoot,
      binding,
      deps.ownerPresence ?? ownerPresence,
      () => {
        const issue = relatedLaunchIssue(binding);
        return issue ? refuse(issue) : operation();
      },
    );
    return result.ok
      ? result.value
      : refuse(
          result.reason === "native-identity-conflict"
            ? "connection-conflict"
            : "connection-unverified",
        );
  };

  const refuseNativeAdmission = (issue: ProtocolIssue): ReduceResult =>
    refuseConnection(log.state(), deps.now(), issue);

  const writeAdmittedConnection = (fact: unknown): ReduceResult => {
    const parsed = parseConnectionFact(fact);
    return parsed?.kind === "launch-intended"
      ? withNativeAdmission(
          parsed.launch.registration,
          () => writeConnection(() => ({ fact })),
          refuseNativeAdmission,
        )
      : writeConnection(() => ({ fact }));
  };

  return {
    writeConnection: writeAdmittedConnection,
    controlConnection: (control) =>
      writeConnection((state) => {
        if (control.kind === "cancel-input")
          return {
            fact: {
              actionId: state.connection?.cancelledInputs[control.inputId] ?? crypto.randomUUID(),
              inputId: control.inputId,
              kind: "input-cancelled",
            },
          };
        if (!connectionId(control.offerId)) return { issue: "invalid-connection" };
        const pending = state.connection?.offers[control.offerId];
        if (!pending) return { issue: "receipt-stale" };
        let actionId: string;
        if (control.kind === "receipt" && pending.kind !== "sending")
          actionId = pending.receiptActionId;
        else if (control.kind === "respond" && pending.kind === "finished")
          actionId = pending.outcomeActionId;
        else actionId = crypto.randomUUID();
        return {
          fact: {
            actionId,
            epoch: pending.offer.epoch,
            kind: control.kind === "receipt" ? "receipt-confirmed" : "offer-outcome",
            offerId: control.offerId,
            participationId: pending.offer.participationId,
            ...(control.kind === "respond" ? { outcome: control.outcome } : {}),
          },
        };
      }),
    acquireExecutor: (request, acquire) => {
      const inspect = (): ProtocolIssue | undefined =>
        log.inspect(({ state }) => {
          if (request.kind === "listener") {
            if (request.fact.kind !== "listener-enabled") return "invalid-connection";
            // An idempotent control readback is not a new admission.
            if (Object.hasOwn(state.connection?.actions ?? {}, request.fact.actionId))
              return "connection-not-admitted";
            // Admission evaluates the same native proof without appending readiness
            // or pretending that the caller already owns an executor lease.
            const { result } = evaluateConnection(state, request.fact, deps.now(), false);
            return result.verdict === "refused" ? result.issue : undefined;
          }
          if (request.kind === "native-headless") {
            const issue = nativeHeadlessIssue(state, request.binding, request.inputId);
            if (issue) return issue;
          } else if (state.connection) return "connection-not-admitted";
          return terminalDepartureIssue(state);
        });
      const check = (): ProtocolIssue | undefined => {
        if (request.kind !== "native-headless") return inspect();
        return withNativeAdmission(request.binding, inspect, (issue) => issue);
      };
      const before = check();
      if (before) return { verdict: "refused", issue: before };
      const lease = acquire();
      try {
        const after = check();
        if (after) {
          lease.release();
          return { verdict: "refused", issue: after };
        }
        nativeAttachment =
          request.kind === "native-headless"
            ? { binding: request.binding, inputId: request.inputId, lease }
            : undefined;
        return { verdict: "accepted", lease };
      } catch (cause) {
        lease.release();
        throw cause;
      }
    },
    captureDispatch: (inputId, from) =>
      log.inspect((snapshot) => captureDispatchContext(dir, inputId, from, snapshot)),
    writePreparedExecution: (fact, stamp) => {
      const binding = log.state().connection?.binding;
      if (binding) {
        const requester = readProcessOwner(process.pid);
        if (!requester) return refuseConnection(log.state(), deps.now(), "connection-unverified");
        return writeAdmittedConnection({
          actionId: crypto.randomUUID(),
          kind: "launch-intended",
          stamp,
          launch: {
            epoch: fact.epoch,
            execution: fact,
            id: crypto.randomUUID(),
            inputId: fact.inputId,
            registration: binding,
            requester,
            role: "headless",
          },
        });
      }
      return writeExecution((state) => {
        const issue = preparedExecutionIssue(state, fact, stamp);
        // A binding created during preparation is refused by writeExecution.
        return issue ? { issue } : fact;
      });
    },
    hasAcceptedInput: (id) => log.acceptedInput(id) !== undefined,
    recoveryInputs: () => {
      const state = log.state();
      return Object.entries(state.executions)
        .filter(([id]) => appliedRecovery(state, id))
        .flatMap(([id]) => {
          const input = log.acceptedInput(id);
          return input ? [inputFrame({ ...input, mode: "queue", managed: true })] : [];
        })
        .sort((a, b) => (a.kind === "input" ? a.seq : 0) - (b.kind === "input" ? b.seq : 0));
    },
    reconcileExecution: (inputId, attempt) =>
      writeExecution((state) => reconcileExecutionFact(state, inputId, attempt)),
    contextCoverage: (harness, sessionId) =>
      confirmedContextThrough(log.state(), harness, sessionId),
    offerConversationContext: (offer) =>
      writeContext((state) => {
        const attempt = contextAttempt(state, offer.turnId);
        return {
          ...offer,
          epoch: state.epoch,
          kind: "coverage-offered",
          ...(attempt?.kind === "attempt-started"
            ? { managed: { inputId: attempt.inputId, attempt: attempt.attempt } }
            : {}),
        };
      }),
    confirmConversationContext: (turnId) =>
      writeContext((state) => {
        let offer = state.contextOffers[turnId];
        if (offer?.kind === "coverage-confirmed") return offer;
        if (!offer) {
          const attempt = contextAttempt(state, turnId);
          const native = state.contextTurns[turnId];
          if (
            attempt &&
            native?.sessionId &&
            native.harness === attempt.driver.harness &&
            native.epoch === attempt.epoch
          )
            offer = {
              kind: "coverage-offered",
              epoch: attempt.epoch,
              harness: attempt.driver.harness,
              sessionId: native.sessionId,
              turnId,
              context: attempt.context,
              managed: { inputId: attempt.inputId, attempt: attempt.attempt },
            };
        }
        const terminalSeq = state.completedTurns[turnId];
        if (!offer || terminalSeq === undefined) return null;
        // A turn knows its own output, but it did not consume new work
        // appended concurrently after its captured context. Stop at that gap.
        const through = contextConfirmationLimit(state, offer, terminalSeq);
        return {
          ...offer,
          kind: "coverage-confirmed",
          evidence: { kind: "completed-turn", seq: terminalSeq },
          through,
        };
      }),
    conversationId,
    dir,
    snapshot,
    artifactTitles,
    writeArtifactMeta,
    writeAttachment,
    state: (): ChannelState => log.state(),
    close: (): void => {
      artifactLifetime.abort();
      log.close();
    },
    transcript: () => log.transcript(),
    status: (): ChannelStatus => snapshot().status,
    cursor,
    advanceCursor,
    collectEffects,
    artifactIndex,
    artifactHeads: () => log.artifactHeads(),
    comparisonSnapshot: (artifactId) => log.comparisonSnapshot(artifactId),
    artifactVersions: () => log.artifactVersions(),
    readArtifact,
    writeArtifact,
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
        // Exempt from the R2 gate: this never reached `transact` — it is a
        // local answer to a frame that would not decode, not conversation
        // work, and the sender is owed it whichever process read the wire.
        deps.onEffect({ type: "send", frame: { kind: "refused", issue: decoded.issue } });
        return { verdict: "refused", wire: true, issue: decoded.issue };
      }
      const presence = decoded.frame.kind === "attach" ? deps.presence() : undefined;
      const claim = decoded.frame.kind === "attach" ? decoded.frame.owner : undefined;
      const owner =
        claim && (deps.ownerPresence ?? ownerPresence)(claim) === true ? claim : undefined;
      const durable =
        decoded.frame.kind === "attach" ? { ...decoded.frame, secret: REDACTED } : decoded.frame;
      const entry: LogEntry = {
        v: 1,
        at,
        src: "frame",
        ...(decoded.frame.kind === "attach" && decoded.frame.profile !== "interactive"
          ? { ownersDeparted: true }
          : {}),
        frame: durable as unknown as Record<string, unknown>,
        ...(presence === undefined ? {} : { presence }),
        ...(owner === undefined ? {} : { owner }),
      };
      const apply = (): ReduceResult =>
        transact(entry, (s) => {
          if (s.connection && decoded.frame.kind === "attach") {
            const admission = nativeAttachment;
            let issue: ProtocolIssue | undefined;
            if (
              !admission?.lease.held() ||
              !deps.executorLease() ||
              decoded.frame.profile !== "headless-turn" ||
              decoded.frame.harness !== admission.binding.harness ||
              !supportsManagedInput(decoded.frame.capabilities)
            )
              issue = "connection-not-admitted";
            else issue = nativeHeadlessIssue(s, admission.binding, admission.inputId);
            if (issue) return { result: refuseConnection(s, at, issue), frame: decoded.frame };
          }
          const r = reduce(s, decoded.frame, at, {
            ...(decoded.frame.kind === "attach" && decoded.frame.profile !== "interactive"
              ? { ownersDeparted: true }
              : {}),
            ...ctxOf(presence),
            ...(owner === undefined ? {} : { owner }),
          });
          // Recheck under the append lock. A terminal can attach while a
          // worker waits for its executor lease or validates a harness.
          if (
            r.verdict === "accepted" &&
            decoded.frame.kind === "attach" &&
            decoded.frame.profile !== "interactive"
          ) {
            const issue = terminalDepartureIssue(s);
            if (issue) {
              if (s.connection)
                return { result: refuseConnection(s, at, issue), frame: decoded.frame };
              throw new HubError(
                "The terminal owner has not departed. Keep the input pending.",
                "E-HUB-03",
                409,
              );
            }
          }
          if (r.verdict === "accepted" && decoded.frame.kind === "attach")
            nativeAttachment = undefined;
          return { result: r, frame: decoded.frame };
        });
      const binding = log.state().connection?.binding;
      return decoded.frame.kind === "attach" && binding && nativeAttachment
        ? withNativeAdmission(binding, apply, refuseNativeAdmission)
        : apply();
    },
    enqueueInput: (
      input: {
        readonly id: string;
        readonly text: string;
        readonly mode: InputMode;
        readonly turnId?: string;
      },
      completeSettings?: DriverChoice,
    ): ReduceResult => {
      const at = deps.now();
      return transactDynamic((state) => {
        const managed =
          input.mode === "queue" && supportsManagedInput(state.attachment?.capabilities);
        const result = managed
          ? enqueueManagedInput(state, input, at)
          : enqueueInput(state, input, at);
        if (result.verdict === "accepted" && completeSettings)
          completeLegacyPreference(dir, completeSettings);
        const entry: LogEntry = managed
          ? {
              v: 1,
              at,
              src: "managed-input",
              payloadVersion: 1,
              input: { ...input, mode: "queue" },
              namingEligible: true,
              intent: { kind: "requested", attempt: 0 },
            }
          : { v: 1, at, src: "input", input, namingEligible: true };
        return { entry, result, frame: null };
      });
    },
    acceptInput: (input, options = {}) => {
      const at = deps.now();
      let conflict = false;
      let acceptedSeq = 0;
      const result = transactDynamic((state) => {
        // append refreshes the transcript under its lock before this lookup.
        const previous = log.acceptedInput(input.id);
        if (previous && previous.text === input.text && previous.mode === input.mode) {
          acceptedSeq = previous.seq;
          return {
            entry: null,
            frame: null,
            result: {
              verdict: "accepted",
              state,
              effects: [],
              record: {
                verdict: "accepted",
                kind: "input",
                conversationId,
                epoch: state.epoch,
                seq: previous.seq,
                now: at,
              },
            },
          };
        }
        conflict = previous !== undefined;
        const result = options.managed
          ? enqueueManagedInput(state, input, at)
          : enqueueInput(state, input, at);
        if (result.verdict === "accepted") {
          acceptedSeq = result.state.seq;
          if (options.completeSettings) completeLegacyPreference(dir, options.completeSettings);
        }
        return {
          entry: options.managed
            ? {
                v: 1,
                at,
                src: "managed-input",
                payloadVersion: 1,
                input,
                namingEligible: true,
                intent: { kind: "requested", attempt: 0 },
              }
            : { v: 1, at, src: "input", input, namingEligible: true },
          result,
          frame: null,
        };
      });
      return result.verdict === "accepted"
        ? { verdict: "accepted", receipt: { inputId: input.id, seq: acceptedSeq } }
        : { verdict: "refused", issue: conflict ? "E-COMP-06" : result.issue };
    },
    decideApproval: (raw, available) => writeApproval(raw, "browser", available),
    writeApproval: (raw, applicable) => writeApproval(raw, "executor", applicable),
    writeExecution: (raw, applicable) =>
      writeExecution(() =>
        applicable && !applicable()
          ? { issue: "execution-stale" }
          : (parseExecutionFact(raw) ?? { issue: "invalid-execution" }),
      ),
    submitInput: (input) => {
      const submission = log.submitInput(input, deps.now());
      if (submission.kind === "replay") return { inputId: submission.inputId, verdict: "accepted" };
      if (submission.kind === "conflict") return { issue: "E-COMP-06", verdict: "refused" };
      const result = publish(submission.result);
      return result.verdict === "accepted"
        ? { inputId: input.id, verdict: "accepted" }
        : { issue: result.issue, verdict: "refused" };
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

/** Alias so existing import sites (`openConversation`) keep compiling. */
export const openConversation = createConversationHost;

/**
 * Lock-free view of a conversation's durable state. Shares the same
 * `readRecordFiles + foldLog` seam the host uses, so there is one
 * reader discipline, not two (C01).
 */
export const viewConversation = (
  dir: string,
): {
  state: ChannelState;
  transcript: import("./log.js").Transcript;
  goodBytes: number;
  artifactHeads: ReadonlyMap<string, number>;
} => {
  const { secret, conversationId, paths } = readRecordFiles(dir);
  const raw = existsSync(paths.logPath) ? readFileSync(paths.logPath) : Buffer.alloc(0);
  const folded = foldLog(conversationId, secret, raw);
  return {
    state: folded.state,
    artifactHeads: folded.artifactHeads,
    transcript: {
      events: [...folded.transcript.events],
      inputs: [...folded.transcript.inputs],
      aborted: [...folded.transcript.aborted],
    },
    goodBytes: folded.goodBytes,
  };
};

/**
 * Lock-free snapshot for pure readers (watch, hooks, TUI). Hosts the
 * viewer's counterpart to `host.snapshot()` — same policy, no lock.
 */
export const viewSnapshot = (
  dir: string,
  opts: { now?: () => number; presence?: () => boolean | undefined } = {},
): ViewSnapshot => {
  const { state, transcript, goodBytes } = viewConversation(dir);
  const nowFn = opts.now ?? (() => Date.now());
  const presenceFn = opts.presence ?? (() => undefined);
  const status = channelStatus(state, nowFn(), { processAlive: presenceFn() === true });
  return { state, transcript, status, goodBytes };
};

/** One artifact this record holds, and which versions of it exist.
 *
 * Built from the fold's index, which is keys and offsets — so a catalog
 * costs no document bytes however large the documents are. Reading a
 * version is a separate, explicit act (`viewArtifactVersion`). */
export interface ArtifactCatalogEntry {
  readonly artifactId: string;
  /** What to display for this artifact. Additive and optional: a reader
   * that does not know about it keeps working, and a reader that does
   * tolerates its absence by displaying `artifactId` (RFC-07 R11). */
  readonly title?: string;
  /** Ascending. Every version the record holds, not a range. */
  readonly versions: readonly number[];
  readonly latest: number;
  /** Who authored each version, from the fold headers without document bytes. */
  readonly authors: Readonly<Record<number, string>>;
  /** Per version, the seq of the last frame accepted before it: where it sits
   * in the conversation. An artifact entry carries no seq of its own, because
   * the fold does not reduce one into state - but the log is one ordered
   * file, so the seq at the moment it is read is its place. A reader showing
   * a saved version as a moment in the thread needs this; without it the only
   * honest place is the end, and the end reads as "just now". */
  readonly afterSeq: Readonly<Record<number, number>>;
}

/** Lock-free catalog of a record's artifacts.
 *
 * The counterpart to `viewSnapshot` for documents. Same reader discipline:
 * read the file, fold it, derive from that one fold, hold nothing. */
export const viewArtifactCatalog = (dir: string): readonly ArtifactCatalogEntry[] => {
  const { secret, conversationId, paths } = readRecordFiles(dir);
  const raw = existsSync(paths.logPath) ? readFileSync(paths.logPath) : Buffer.alloc(0);
  const { artifactVersions, artifactTitles } = foldLog(conversationId, secret, raw);
  return [...artifactVersions]
    .map(([artifactId, headers]) => {
      const versions = [...headers.keys()].sort((a, b) => a - b);
      const authors: Record<number, string> = {};
      const afterSeq: Record<number, number> = {};
      for (const [version, header] of headers) {
        authors[version] = header.author;
        afterSeq[version] = header.afterSeq;
      }
      const title = artifactTitles.get(artifactId);
      return {
        artifactId,
        versions,
        latest: versions[versions.length - 1] as number,
        authors,
        afterSeq,
        ...(title === undefined ? {} : { title }),
      };
    })
    .sort((a, b) => a.artifactId.localeCompare(b.artifactId));
};

/** Lock-free seek to one artifact version. Folds to build the index, then
 * reads exactly the one line that version lives on — never the whole
 * document set. Null when this record holds no such version. */
export const viewArtifactVersion = (
  dir: string,
  artifactId: string,
  version: number,
): ArtifactVersion | null => {
  const { secret, conversationId, paths } = readRecordFiles(dir);
  const raw = existsSync(paths.logPath) ? readFileSync(paths.logPath) : Buffer.alloc(0);
  const { artifactIndex } = foldLog(conversationId, secret, raw);
  return readArtifactVersion(raw, artifactId, version, artifactIndex);
};

/** A writer appends durable facts but never holds the executor lease or dispatches effects. */
export const openWriter = (
  dir: string,
  deps: {
    connectionAuthority?: HostDeps["connectionAuthority"];
    ownerPresence?: HostDeps["ownerPresence"];
    now?: () => number;
    presence?: () => boolean | undefined;
    expectedConversationId?: string;
    probeArtifactLink?: WebLinkProbe;
  } = {},
): ConversationHost =>
  createConversationHost(dir, {
    connectionAuthority: deps.connectionAuthority,
    ownerPresence: deps.ownerPresence,
    probeArtifactLink: deps.probeArtifactLink,
    expectedConversationId: deps.expectedConversationId,
    now: deps.now ?? Date.now,
    presence: deps.presence ?? (() => undefined),
    executorLease: () => false,
    onEffect: () => {},
    onRecord: () => {},
  });

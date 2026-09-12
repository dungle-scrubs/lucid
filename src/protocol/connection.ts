import { EventKind } from "./events.js";
import {
  type AttemptOutcome,
  type AttemptStart,
  type ContextBoundary,
  type ExecutionFailure,
  hasUnsettledExecution,
  parseContextBoundary,
  parseExecutionFact,
  reduceExecution,
} from "./execution.js";
import type { HarnessName, ProtocolIssue } from "./frames.js";
import { isWireId, isWireText } from "./frames.js";
import { InputLedger } from "./ledgers/input.js";
import type { InteractiveResult } from "./native-interactive.js";
import { isInteractiveRefusalReason } from "./native-interactive.js";
import type { ProcessOwner } from "./process-owner.js";
import { parseProcessOwner, sameProcessOwner } from "./process-owner.js";
import type { ChannelState, ReduceResult } from "./reducer.js";

export const NATIVE_INTERFACES = {
  "claude-cli": "claude",
  "codex-cli": "codex",
  "codex-desktop": "codex",
  "muse-cli": "muse",
  "pi-cli": "pi",
} as const;
export type NativeInterface = keyof typeof NATIVE_INTERFACES;

export interface NativeBinding {
  readonly generation: string;
  readonly harness: HarnessName;
  readonly interface: NativeInterface;
  readonly nativeSessionId: string;
  readonly owner: ProcessOwner;
  readonly registrationId: string;
  readonly workingDirectory: string;
}

export interface ConnectionState {
  readonly actions: Readonly<Record<string, string>>;
  readonly binding: NativeBinding;
  readonly cancelledInputs: Readonly<Record<string, string>>;
  readonly disabledReason: ListenerDisabledReason | null;
  readonly explicitListenerEpoch: number;
  readonly heldInputs: Readonly<Record<string, NativeInputHold>>;
  /** Terminal entries retain each launch's identity and refusal evidence for replay and audit. */
  readonly launches: Readonly<Record<string, NativeLaunchState>>;
  readonly listenerId: string | null;
  readonly offers: Readonly<Record<string, NativeOfferState>>;
  readonly participations: Readonly<Record<string, ListenerParticipation>>;
  readonly reconnectId: string | null;
  readonly reconnects: Readonly<Record<string, NativeReconnectState>>;
  readonly revision: number;
}

export interface NativeReconnectRequest {
  readonly id: string;
  readonly requester: ProcessOwner;
}

export interface NativeReconnectCreation {
  readonly cwd: string;
  readonly interface: NativeInterface;
  readonly launchId: string;
  readonly owner: ProcessOwner;
  readonly sessionId: string;
}

export interface NativeReconnectStart extends NativeReconnectCreation {
  readonly actionId: string;
}

export interface NativeReconnectCompletion {
  readonly actionId: string;
  readonly result: InteractiveResult;
}

export type NativeReconnectState = {
  readonly request: NativeReconnectRequest;
  readonly requestedActionId: string;
} & (
  | { readonly kind: "requested" }
  | {
      readonly kind: "intended";
      readonly completion: NativeReconnectCompletion | null;
      readonly launchId: string;
      readonly intendedActionId: string;
      readonly started: NativeReconnectStart | null;
    }
  | {
      readonly kind: "fulfilled";
      readonly completion: NativeReconnectCompletion | null;
      readonly launchId: string;
      readonly intendedActionId: string;
      readonly started: NativeReconnectStart;
      readonly participationId: string;
      readonly fulfilledActionId: string;
    }
  | {
      readonly kind: "withdrawn";
      readonly withdrawnActionId: string;
      readonly reason: "cancelled" | "requester-exited";
    }
);

export function currentReconnect(
  connection: ConnectionState | null,
): NativeReconnectState | undefined {
  return connection?.reconnectId ? connection.reconnects[connection.reconnectId] : undefined;
}

/** Correlation only. The host still checks native authority, liveness and the acquired lease. */
export function reconnectForListener(
  connection: ConnectionState | null,
  registration: NativeBinding,
):
  | {
      readonly request: Extract<NativeReconnectState, { kind: "intended" }>;
      readonly started: NativeReconnectStart;
    }
  | undefined {
  const request = currentReconnect(connection);
  return request?.kind === "intended" &&
    request.completion === null &&
    request.started &&
    sameNativeTarget(connection?.binding, registration) &&
    sameProcessOwner(request.started.owner, registration.owner)
    ? { request, started: request.started }
    : undefined;
}

export interface NativeLaunch {
  readonly epoch: number;
  readonly execution?: AttemptStart;
  readonly id: string;
  readonly inputId: string;
  readonly registration: NativeBinding;
  readonly requester: ProcessOwner;
  readonly role: "headless";
}

export type NativeLaunchState =
  | { readonly kind: "intended"; readonly launch: NativeLaunch }
  | {
      readonly identitySeq: number;
      readonly kind: "started";
      readonly launch: NativeLaunch;
      readonly startedActionId: string;
    }
  | {
      readonly kind: "settled";
      readonly launch: NativeLaunch;
      readonly outcome: AttemptOutcome;
      readonly settledActionId: string;
      readonly start: { readonly actionId: string; readonly identitySeq: number } | null;
    }
  | {
      readonly failure: ExecutionFailure;
      readonly kind: "refused";
      readonly launch: NativeLaunch;
      readonly refusedActionId: string;
    };

export function hasUnsettledLaunch(connection: ConnectionState | null): boolean {
  return Object.values(connection?.launches ?? {}).some(
    (entry) => entry.kind === "intended" || entry.kind === "started",
  );
}

export const LISTENER_WAIT_MAX_MS = 45_000;
export type ListenerDisabledReason = "expired" | "interrupted" | "owner-lost";

export const NATIVE_PREPARATION_REASONS = [
  "E-COMP-07",
  "context-too-large",
  "context-unavailable",
  "listener-not-ready",
  "transport-encoding-failed",
  "transport-unverified",
] as const;
export type NativePreparationReason = (typeof NATIVE_PREPARATION_REASONS)[number];

export interface NativeInputHold {
  readonly epoch: number;
  readonly inputId: string;
  readonly message: string;
  readonly participationId: string;
  readonly prerequisite: string;
  readonly reason: NativePreparationReason;
}

export interface ListenerParticipation {
  readonly epoch: number;
  readonly executorOwner: ProcessOwner;
  readonly expiresAt: number;
  readonly id: string;
  readonly registration: NativeBinding;
}

export interface NativeOffer {
  readonly attempt: number;
  readonly context: ContextBoundary;
  readonly epoch: number;
  readonly id: string;
  readonly inputId: string;
  readonly participationId: string;
  readonly turnId: string;
}

export type NativeOfferState =
  | { readonly kind: "sending"; readonly offer: NativeOffer }
  | { readonly kind: "received"; readonly offer: NativeOffer; readonly receiptActionId: string }
  | {
      readonly kind: "finished";
      readonly offer: NativeOffer;
      readonly outcome: NativeOutcome;
      readonly outcomeActionId: string;
      readonly receiptActionId: string;
    };

export interface NativeOutcome {
  readonly kind: "answer" | "question" | "refusal" | "failure";
  readonly text: string;
}

export type ConnectionControl =
  | { readonly kind: "cancel-input"; readonly inputId: string }
  | { readonly kind: "receipt"; readonly offerId: string }
  | { readonly kind: "respond"; readonly offerId: string; readonly outcome: unknown };

export type ReconnectControl =
  | { readonly kind: "request" }
  | { readonly kind: "cancel"; readonly requestId: string };

export function nativeOutcomeEvent(outcome: NativeOutcome): Record<string, unknown> {
  if (outcome.kind === "question") return { kind: EventKind.question, question: outcome.text };
  if (outcome.kind === "answer")
    return { kind: EventKind.message, role: "assistant", text: outcome.text };
  return {
    class: outcome.kind,
    code: "interactive-response",
    kind: EventKind.failure,
    message: outcome.text,
  };
}

export function hasUnresolvedOffer(connection: ConnectionState | null): boolean {
  return Object.values(connection?.offers ?? {}).some((offer) => offer.kind !== "finished");
}

export function hasUnsettledNativeWork(state: ChannelState): boolean {
  return currentReconnect(state.connection) !== undefined || hasUnsettledNativeExecution(state);
}

/** A reconnect waiter may proceed only after previous delivery, outcome and cleanup settle. */
export function hasUnsettledNativeExecution(state: ChannelState): boolean {
  return (
    hasUncertainReconnect(state.connection) ||
    hasUnresolvedOffer(state.connection) ||
    hasUnsettledLaunch(state.connection) ||
    hasUnsettledExecution(state)
  );
}

export function hasUncertainReconnect(connection: ConnectionState | null): boolean {
  return Object.values(connection?.reconnects ?? {}).some(
    (request) => "completion" in request && request.completion?.result.kind === "uncertain",
  );
}

export type ConnectionFact =
  | {
      readonly actionId: string;
      readonly kind: "reconnect-settled";
      readonly launchId: string;
      readonly requestId: string;
      readonly result: InteractiveResult;
    }
  | {
      readonly actionId: string;
      readonly kind: "reconnect-started";
      readonly cwd: string;
      readonly interface: NativeInterface;
      readonly sessionId: string;
      readonly requestId: string;
      readonly launchId: string;
      readonly owner: ProcessOwner;
    }
  | {
      readonly actionId: string;
      readonly kind: "reconnect-intended";
      readonly requestId: string;
      readonly launchId: string;
    }
  | { readonly actionId: string; readonly kind: "reconnect-withdrawn"; readonly requestId: string }
  | { readonly actionId: string; readonly kind: "reconnect-abandoned"; readonly requestId: string }
  | {
      readonly actionId: string;
      readonly kind: "reconnect-requested";
      readonly request: NativeReconnectRequest;
    }
  | { readonly actionId: string; readonly kind: "launch-started"; readonly launchId: string }
  | { readonly actionId: string; readonly kind: "launch-settled"; readonly launchId: string }
  | { readonly actionId: string; readonly kind: "launch-refused"; readonly launchId: string }
  | {
      readonly actionId: string;
      readonly kind: "launch-intended";
      readonly launch: NativeLaunch;
      readonly stamp?: string;
    }
  | { readonly actionId: string; readonly inputId: string; readonly kind: "input-cancelled" }
  | { readonly actionId: string; readonly hold: NativeInputHold; readonly kind: "input-held" }
  | {
      readonly actionId: string;
      readonly binding: NativeBinding;
      readonly kind: "bound";
    }
  | {
      readonly actionId: string;
      readonly kind: "listener-enabled";
      readonly participation: ListenerParticipation;
      readonly source: "explicit" | "continuation";
    }
  | {
      readonly actionId: string;
      readonly epoch: number;
      readonly kind: "listener-disabled";
      readonly participationId: string;
      readonly reason: ListenerDisabledReason;
    }
  | {
      readonly actionId: string;
      readonly kind: "offer-started";
      readonly offer: NativeOffer;
      readonly stamp: string;
    }
  | {
      readonly actionId: string;
      readonly epoch: number;
      readonly kind: "receipt-confirmed";
      readonly offerId: string;
      readonly participationId: string;
    }
  | {
      readonly actionId: string;
      readonly epoch: number;
      readonly kind: "offer-outcome";
      readonly offerId: string;
      readonly outcome: NativeOutcome;
      readonly participationId: string;
    };

export function currentListener(
  connection: ConnectionState | null,
): ListenerParticipation | undefined {
  return connection?.listenerId ? connection.participations[connection.listenerId] : undefined;
}

export function sameNativeBinding(
  a: NativeBinding | undefined,
  b: NativeBinding | undefined,
): boolean {
  return (
    !!a &&
    !!b &&
    sameNativeTarget(a, b) &&
    a.generation === b.generation &&
    a.registrationId === b.registrationId &&
    sameProcessOwner(a.owner, b.owner)
  );
}

/** A returning lifecycle may keep this exact target while changing its registration and owner. */
export function sameNativeTarget(
  a: NativeBinding | undefined,
  b: NativeBinding | undefined,
): boolean {
  return (
    !!a &&
    !!b &&
    sameNativeHistory(a, b) &&
    a.interface === b.interface &&
    a.workingDirectory === b.workingDirectory
  );
}

/** Interfaces and folder spellings do not create independent native histories. */
export function sameNativeHistory(
  a: Pick<NativeBinding, "harness" | "nativeSessionId"> | undefined,
  b: Pick<NativeBinding, "harness" | "nativeSessionId"> | undefined,
): boolean {
  return !!a && !!b && a.harness === b.harness && a.nativeSessionId === b.nativeSessionId;
}

/** A completed offer permits one further wait until expiry or interruption disables it. */
export function continuationListener(
  connection: ConnectionState | null,
): ListenerParticipation | undefined {
  const listener = currentListener(connection);
  return listener &&
    connection?.disabledReason === null &&
    Object.values(connection.offers).some(
      (entry) => entry.kind === "finished" && entry.offer.participationId === listener.id,
    )
    ? listener
    : undefined;
}

export function connectionRegistration(
  connection: ConnectionState | null,
  fact: ConnectionFact,
): NativeBinding | undefined {
  return fact.kind === "reconnect-requested" ||
    fact.kind === "reconnect-withdrawn" ||
    fact.kind === "reconnect-abandoned" ||
    fact.kind === "reconnect-started" ||
    fact.kind === "reconnect-settled" ||
    fact.kind === "reconnect-intended"
    ? connection?.binding
    : fact.kind === "launch-intended"
      ? fact.launch.registration
      : fact.kind === "launch-refused" ||
          fact.kind === "launch-started" ||
          fact.kind === "launch-settled"
        ? connection?.launches[fact.launchId]?.launch.registration
        : fact.kind === "bound"
          ? fact.binding
          : connectionParticipation(connection, fact)?.registration;
}

export function connectionParticipation(
  connection: ConnectionState | null,
  fact: ConnectionFact,
): ListenerParticipation | undefined {
  switch (fact.kind) {
    case "reconnect-requested":
    case "reconnect-withdrawn":
    case "reconnect-abandoned":
    case "reconnect-started":
    case "reconnect-settled":
    case "reconnect-intended":
    case "launch-started":
    case "launch-settled":
    case "launch-refused":
    case "launch-intended":
    case "input-cancelled":
    case "bound":
      return undefined;
    case "input-held":
      return connection?.participations[fact.hold.participationId];
    case "listener-enabled":
      return fact.participation;
    case "offer-started":
      return connection?.participations[fact.offer.participationId];
    case "receipt-confirmed":
    case "offer-outcome":
    case "listener-disabled":
      return connection?.participations[fact.participationId];
  }
}

export function nativeOwners(state: ChannelState): readonly { readonly owner?: ProcessOwner }[] {
  const owners: { readonly owner?: ProcessOwner }[] = [];
  const bindings = [
    state.connection?.binding,
    ...Object.values(state.connection?.participations ?? {}).map((entry) => entry.registration),
  ];
  for (const entry of [...state.terminalParticipations, ...bindings.filter((b) => b !== undefined)])
    if (
      !owners.some((prior) =>
        entry.owner ? sameProcessOwner(prior.owner, entry.owner) : prior.owner === undefined,
      )
    )
      owners.push(entry.owner ? { owner: entry.owner } : {});
  // Fulfillment records this same owner in participations above. Only the active
  // reservation can have started provenance without an admitted participation.
  const request = currentReconnect(state.connection);
  const owner = request?.kind === "intended" ? request.started?.owner : undefined;
  if (owner && !owners.some((prior) => sameProcessOwner(prior.owner, owner)))
    owners.push({ owner });
  return owners;
}

export const connectionId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isStamp = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const path = (value: unknown): value is string =>
  typeof value === "string" &&
  value.startsWith("/") &&
  new TextEncoder().encode(value).length <= 4096 &&
  !/\p{Cc}/u.test(value);

export function parseNativeBinding(value: unknown): NativeBinding | null {
  if (!object(value)) return null;
  const owner = parseProcessOwner(value.owner);
  if (
    !connectionId(value.generation) ||
    !connectionId(value.registrationId) ||
    typeof value.interface !== "string" ||
    !Object.hasOwn(NATIVE_INTERFACES, value.interface) ||
    typeof value.nativeSessionId !== "string" ||
    !isWireId(value.nativeSessionId) ||
    !path(value.workingDirectory) ||
    !owner ||
    !path(owner.executable)
  )
    return null;
  const nativeInterface = value.interface as NativeInterface;
  if (value.harness !== NATIVE_INTERFACES[nativeInterface]) return null;
  return {
    generation: value.generation,
    harness: NATIVE_INTERFACES[nativeInterface],
    interface: nativeInterface,
    nativeSessionId: value.nativeSessionId,
    owner,
    registrationId: value.registrationId,
    workingDirectory: value.workingDirectory,
  };
}

function parseInteractiveResult(value: unknown): InteractiveResult | null {
  if (!object(value)) return null;
  if (
    value.kind === "closed" &&
    value.cleanupComplete === true &&
    (value.exitCode === null ||
      (typeof value.exitCode === "number" &&
        Number.isSafeInteger(value.exitCode) &&
        value.exitCode >= 0))
  )
    return { kind: "closed", cleanupComplete: true, exitCode: value.exitCode };
  if (typeof value.reason !== "string" || !isWireId(value.reason)) return null;
  if (value.kind === "uncertain") return { kind: "uncertain", reason: value.reason };
  if (
    value.kind === "refused" &&
    ((value.evidence === "spawn-not-attempted" && isInteractiveRefusalReason(value.reason)) ||
      value.evidence === "dispatch-not-called")
  )
    return { kind: "refused", evidence: value.evidence, reason: value.reason };
  return null;
}

export function parseConnectionFact(value: unknown): ConnectionFact | null {
  if (!object(value) || !connectionId(value.actionId)) return null;
  if (
    value.kind === "reconnect-settled" &&
    connectionId(value.requestId) &&
    connectionId(value.launchId)
  ) {
    const result = parseInteractiveResult(value.result);
    return result
      ? {
          actionId: value.actionId,
          kind: value.kind,
          requestId: value.requestId,
          launchId: value.launchId,
          result,
        }
      : null;
  }
  if (
    value.kind === "reconnect-started" &&
    connectionId(value.requestId) &&
    connectionId(value.launchId)
  ) {
    const owner = parseProcessOwner(value.owner);
    if (
      !owner ||
      !path(owner.executable) ||
      !path(value.cwd) ||
      typeof value.sessionId !== "string" ||
      !isWireId(value.sessionId) ||
      typeof value.interface !== "string" ||
      !Object.hasOwn(NATIVE_INTERFACES, value.interface)
    )
      return null;
    return {
      actionId: value.actionId,
      kind: value.kind,
      requestId: value.requestId,
      launchId: value.launchId,
      owner,
      cwd: value.cwd,
      interface: value.interface as NativeInterface,
      sessionId: value.sessionId,
    };
  }
  if (
    value.kind === "reconnect-intended" &&
    connectionId(value.requestId) &&
    connectionId(value.launchId)
  )
    return {
      actionId: value.actionId,
      kind: value.kind,
      requestId: value.requestId,
      launchId: value.launchId,
    };
  if (
    (value.kind === "reconnect-withdrawn" || value.kind === "reconnect-abandoned") &&
    connectionId(value.requestId)
  )
    return { actionId: value.actionId, kind: value.kind, requestId: value.requestId };
  if (value.kind === "reconnect-requested" && object(value.request)) {
    const requester = parseProcessOwner(value.request.requester);
    if (!requester || !path(requester.executable) || !connectionId(value.request.id)) return null;
    return {
      actionId: value.actionId,
      kind: value.kind,
      request: { id: value.request.id, requester },
    };
  }
  if (
    (value.kind === "launch-refused" ||
      value.kind === "launch-started" ||
      value.kind === "launch-settled") &&
    connectionId(value.launchId)
  )
    return { actionId: value.actionId, kind: value.kind, launchId: value.launchId };
  if (value.kind === "launch-intended" && object(value.launch)) {
    const launch = value.launch;
    const registration = parseNativeBinding(launch.registration);
    const requester = parseProcessOwner(launch.requester);
    if (
      !registration ||
      !requester ||
      !path(requester.executable) ||
      !connectionId(launch.id) ||
      typeof launch.epoch !== "number" ||
      !Number.isSafeInteger(launch.epoch) ||
      launch.epoch < 0 ||
      typeof launch.inputId !== "string" ||
      !isWireId(launch.inputId) ||
      launch.role !== "headless"
    )
      return null;
    let execution: AttemptStart | undefined;
    if (launch.execution !== undefined) {
      const parsed = parseExecutionFact(launch.execution);
      if (
        parsed?.kind !== "attempt-started" ||
        parsed.inputId !== launch.inputId ||
        parsed.epoch !== launch.epoch ||
        parsed.driver.harness !== registration.harness ||
        parsed.native.kind !== "resume" ||
        parsed.native.sessionId !== registration.nativeSessionId ||
        !isStamp(value.stamp)
      )
        return null;
      execution = parsed;
    } else if (value.stamp !== undefined) return null;
    return {
      actionId: value.actionId,
      kind: value.kind,
      launch: {
        epoch: launch.epoch,
        ...(execution ? { execution } : {}),
        id: launch.id,
        inputId: launch.inputId,
        registration,
        requester,
        role: launch.role,
      },
      ...(execution ? { stamp: value.stamp as string } : {}),
    };
  }
  if (value.kind === "input-held" && object(value.hold)) {
    const hold = value.hold;
    if (
      !positive(hold.epoch) ||
      !connectionId(hold.participationId) ||
      typeof hold.inputId !== "string" ||
      !isWireId(hold.inputId) ||
      typeof hold.message !== "string" ||
      !isWireText(hold.message) ||
      hold.message.length > 4096 ||
      !isStamp(hold.prerequisite) ||
      !NATIVE_PREPARATION_REASONS.includes(hold.reason as NativePreparationReason)
    )
      return null;
    return {
      actionId: value.actionId,
      kind: value.kind,
      hold: {
        epoch: hold.epoch,
        inputId: hold.inputId,
        message: hold.message,
        participationId: hold.participationId,
        prerequisite: hold.prerequisite,
        reason: hold.reason as NativePreparationReason,
      },
    };
  }
  if (
    value.kind === "input-cancelled" &&
    typeof value.inputId === "string" &&
    isWireId(value.inputId)
  )
    return { actionId: value.actionId, inputId: value.inputId, kind: value.kind };
  if (
    value.kind === "offer-outcome" &&
    connectionId(value.offerId) &&
    connectionId(value.participationId) &&
    positive(value.epoch) &&
    object(value.outcome)
  ) {
    const o = value.outcome;
    if (
      (o.kind !== "answer" &&
        o.kind !== "question" &&
        o.kind !== "refusal" &&
        o.kind !== "failure") ||
      typeof o.text !== "string" ||
      !isWireText(o.text)
    )
      return null;
    const outcome: NativeOutcome = { kind: o.kind, text: o.text };
    if (!isWireText(JSON.stringify(nativeOutcomeEvent(outcome)))) return null;
    return {
      actionId: value.actionId,
      epoch: value.epoch,
      kind: value.kind,
      offerId: value.offerId,
      outcome,
      participationId: value.participationId,
    };
  }
  if (
    value.kind === "receipt-confirmed" &&
    connectionId(value.offerId) &&
    connectionId(value.participationId) &&
    positive(value.epoch)
  )
    return {
      actionId: value.actionId,
      epoch: value.epoch,
      kind: value.kind,
      offerId: value.offerId,
      participationId: value.participationId,
    };
  if (value.kind === "bound") {
    const binding = parseNativeBinding(value.binding);
    return binding ? { actionId: value.actionId, binding, kind: "bound" } : null;
  }
  if (
    value.kind === "listener-disabled" &&
    positive(value.epoch) &&
    connectionId(value.participationId) &&
    (value.reason === "expired" || value.reason === "interrupted" || value.reason === "owner-lost")
  )
    return {
      actionId: value.actionId,
      epoch: value.epoch,
      kind: value.kind,
      participationId: value.participationId,
      reason: value.reason,
    };
  if (
    value.kind === "listener-enabled" &&
    object(value.participation) &&
    (value.source === "explicit" || value.source === "continuation")
  ) {
    const p = value.participation;
    const registration = parseNativeBinding(p.registration);
    const executorOwner = parseProcessOwner(p.executorOwner);
    if (
      !registration ||
      !executorOwner ||
      !path(executorOwner.executable) ||
      !connectionId(p.id) ||
      !positive(p.epoch) ||
      !positive(p.expiresAt)
    )
      return null;
    return {
      actionId: value.actionId,
      kind: value.kind,
      participation: {
        epoch: p.epoch,
        executorOwner,
        expiresAt: p.expiresAt,
        id: p.id,
        registration,
      },
      source: value.source,
    };
  }
  if (value.kind === "offer-started" && object(value.offer)) {
    const o = value.offer;
    const context = parseContextBoundary(o.context);
    if (
      !context ||
      !connectionId(o.id) ||
      !connectionId(o.participationId) ||
      typeof o.inputId !== "string" ||
      !isWireId(o.inputId) ||
      typeof o.turnId !== "string" ||
      !isWireId(o.turnId) ||
      !positive(o.attempt) ||
      !positive(o.epoch) ||
      !isStamp(value.stamp)
    )
      return null;
    return {
      actionId: value.actionId,
      kind: value.kind,
      offer: {
        attempt: o.attempt,
        context,
        epoch: o.epoch,
        id: o.id,
        inputId: o.inputId,
        participationId: o.participationId,
        turnId: o.turnId,
      },
      stamp: value.stamp,
    };
  }
  return null;
}

export function refuseConnection(
  state: ChannelState,
  now: number,
  issue: ProtocolIssue,
): ReduceResult {
  return {
    effects: [],
    issue,
    record: {
      conversationId: state.conversationId,
      epoch: state.epoch,
      issue,
      kind: "input",
      now,
      verdict: "refused",
    },
    state,
    verdict: "refused",
  };
}

function matchingOffer(
  state: ChannelState,
  reference: Extract<ConnectionFact, { kind: "receipt-confirmed" | "offer-outcome" }>,
): NativeOfferState | undefined {
  const pending = state.connection?.offers[reference.offerId];
  return pending?.offer.epoch === reference.epoch &&
    state.epoch === reference.epoch &&
    pending.offer.participationId === reference.participationId
    ? pending
    : undefined;
}

function matchingListener(
  state: ChannelState,
  reference: { readonly epoch: number; readonly participationId: string },
  now: number,
): ListenerParticipation | undefined {
  const listener = currentListener(state.connection);
  return listener?.id === reference.participationId &&
    listener.epoch === reference.epoch &&
    state.epoch === reference.epoch &&
    listener.expiresAt > now
    ? listener
    : undefined;
}

function clearInputHold(
  holds: ConnectionState["heldInputs"],
  inputId: string,
): ConnectionState["heldInputs"] {
  if (!Object.hasOwn(holds, inputId)) return holds;
  const remaining = { ...holds };
  delete remaining[inputId];
  return remaining;
}

/** Live writes verify native authority in the host; replay repeats this same transition. */
export function reduceConnection(state: ChannelState, raw: unknown, now: number): ReduceResult {
  const fact = parseConnectionFact(raw);
  if (!fact) return refuseConnection(state, now, "invalid-connection");
  const serialized = JSON.stringify(fact);
  const prior = state.connection?.actions[fact.actionId];
  if (prior !== undefined && prior !== serialized)
    return refuseConnection(state, now, "connection-conflict");
  let next = state;
  if (prior !== serialized) {
    const actions = { ...state.connection?.actions, [fact.actionId]: serialized };
    if (fact.kind === "bound") {
      if (!state.connection && hasUnsettledExecution(state))
        return refuseConnection(state, now, "execution-blocked");
      const previousNative = state.harnessSessions[fact.binding.harness];
      if (
        !state.connection &&
        (state.attachment !== null ||
          (previousNative !== undefined && previousNative !== fact.binding.nativeSessionId))
      )
        return refuseConnection(state, now, "connection-conflict");
      if (
        state.connection &&
        JSON.stringify(state.connection.binding) !== JSON.stringify(fact.binding)
      )
        return refuseConnection(state, now, "connection-conflict");
      next = {
        ...state,
        connection: {
          actions,
          binding: fact.binding,
          cancelledInputs: state.connection?.cancelledInputs ?? {},
          disabledReason: state.connection?.disabledReason ?? null,
          explicitListenerEpoch: state.connection?.explicitListenerEpoch ?? 0,
          heldInputs: state.connection?.heldInputs ?? {},
          launches: state.connection?.launches ?? {},
          listenerId: state.connection?.listenerId ?? null,
          offers: state.connection?.offers ?? {},
          participations: state.connection?.participations ?? {},
          reconnectId: state.connection?.reconnectId ?? null,
          reconnects: state.connection?.reconnects ?? {},
          revision: state.seq + 1,
        },
        seq: state.seq + 1,
      };
    } else if (fact.kind === "reconnect-requested") {
      const connection = state.connection;
      if (!connection) return refuseConnection(state, now, "connection-not-admitted");
      if (currentReconnect(connection) || Object.hasOwn(connection.reconnects, fact.request.id))
        return refuseConnection(state, now, "connection-conflict");
      next = {
        ...state,
        connection: {
          ...connection,
          actions,
          reconnectId: fact.request.id,
          reconnects: {
            ...connection.reconnects,
            [fact.request.id]: {
              kind: "requested",
              request: fact.request,
              requestedActionId: fact.actionId,
            },
          },
          revision: state.seq + 1,
        },
        seq: state.seq + 1,
      };
    } else if (fact.kind === "reconnect-intended") {
      const connection = state.connection;
      const pending = currentReconnect(connection);
      if (!connection || pending?.kind !== "requested" || pending.request.id !== fact.requestId)
        return refuseConnection(state, now, "connection-conflict");
      if (hasUnsettledNativeExecution(state) || state.attachment !== null)
        return refuseConnection(state, now, "execution-blocked");
      if (
        Object.hasOwn(connection.launches, fact.launchId) ||
        Object.values(connection.reconnects).some(
          (request) => "launchId" in request && request.launchId === fact.launchId,
        )
      )
        return refuseConnection(state, now, "connection-conflict");
      next = {
        ...state,
        connection: {
          ...connection,
          actions,
          reconnects: {
            ...connection.reconnects,
            [fact.requestId]: {
              ...pending,
              kind: "intended",
              launchId: fact.launchId,
              intendedActionId: fact.actionId,
              completion: null,
              started: null,
            },
          },
          revision: state.seq + 1,
        },
        seq: state.seq + 1,
      };
    } else if (fact.kind === "reconnect-started") {
      const connection = state.connection;
      const pending = currentReconnect(connection);
      if (
        !connection ||
        pending?.kind !== "intended" ||
        pending.request.id !== fact.requestId ||
        pending.launchId !== fact.launchId ||
        pending.started !== null ||
        pending.completion !== null
      )
        return refuseConnection(state, now, "connection-conflict");
      if (
        fact.cwd !== connection.binding.workingDirectory ||
        fact.interface !== connection.binding.interface ||
        fact.sessionId !== connection.binding.nativeSessionId
      )
        return refuseConnection(state, now, "connection-unverified");
      next = {
        ...state,
        connection: {
          ...connection,
          actions,
          reconnects: {
            ...connection.reconnects,
            [fact.requestId]: {
              ...pending,
              started: {
                actionId: fact.actionId,
                owner: fact.owner,
                cwd: fact.cwd,
                interface: fact.interface,
                sessionId: fact.sessionId,
                launchId: fact.launchId,
              },
            },
          },
          revision: state.seq + 1,
        },
        seq: state.seq + 1,
      };
    } else if (fact.kind === "reconnect-settled") {
      const connection = state.connection;
      const pending = connection?.reconnects[fact.requestId];
      if (
        !connection ||
        !pending ||
        (pending.kind !== "intended" && pending.kind !== "fulfilled") ||
        pending.launchId !== fact.launchId ||
        pending.completion !== null
      )
        return refuseConnection(state, now, "connection-conflict");
      if (
        (fact.result.kind === "closed" && !pending.started) ||
        (fact.result.kind === "refused" && pending.started)
      )
        return refuseConnection(state, now, "connection-unverified");
      next = {
        ...state,
        connection: {
          ...connection,
          actions,
          reconnects: {
            ...connection.reconnects,
            [fact.requestId]: {
              ...pending,
              completion: { actionId: fact.actionId, result: fact.result },
            },
          },
          revision: state.seq + 1,
        },
        seq: state.seq + 1,
      };
    } else if (fact.kind === "reconnect-withdrawn" || fact.kind === "reconnect-abandoned") {
      const connection = state.connection;
      const pending = currentReconnect(connection ?? null);
      if (!connection || pending?.kind !== "requested" || pending.request.id !== fact.requestId)
        return refuseConnection(state, now, "connection-conflict");
      next = {
        ...state,
        connection: {
          ...connection,
          actions,
          reconnectId: null,
          reconnects: {
            ...connection.reconnects,
            [fact.requestId]: {
              ...pending,
              kind: "withdrawn",
              withdrawnActionId: fact.actionId,
              reason: fact.kind === "reconnect-abandoned" ? "requester-exited" : "cancelled",
            },
          },
          revision: state.seq + 1,
        },
        seq: state.seq + 1,
      };
    } else if (fact.kind === "launch-intended") {
      const connection = state.connection;
      if (
        !connection ||
        !sameNativeBinding(connection.binding, fact.launch.registration) ||
        fact.launch.epoch !== state.epoch
      )
        return refuseConnection(state, now, "connection-unverified");
      if (hasUnsettledNativeWork(state)) return refuseConnection(state, now, "execution-blocked");
      if (
        !state.inputs.some((input) => input.id === fact.launch.inputId) ||
        Object.hasOwn(state.appliedInputs, fact.launch.inputId)
      )
        return refuseConnection(state, now, "execution-ineligible");
      const execution = fact.launch.execution
        ? reduceExecution(state, fact.launch.execution, now, true)
        : undefined;
      if (execution?.verdict === "refused") return refuseConnection(state, now, execution.issue);
      next = {
        ...(execution?.state ?? state),
        connection: {
          ...connection,
          actions,
          launches: {
            ...connection.launches,
            [fact.launch.id]: { kind: "intended", launch: fact.launch },
          },
          revision: state.seq + 1,
        },
        seq: state.seq + 1,
      };
    } else if (fact.kind === "launch-started") {
      const connection = state.connection;
      const pending = connection?.launches[fact.launchId];
      const start = pending?.launch.execution;
      if (!connection || pending?.kind !== "intended" || !start)
        return refuseConnection(state, now, "connection-conflict");
      const native = state.nativeSessions[pending.launch.registration.harness];
      const context = state.contextTurns[start.turnId];
      if (
        pending.launch.epoch !== state.epoch ||
        JSON.stringify(parseExecutionFact(state.executions[start.inputId])) !==
          JSON.stringify(start) ||
        !native?.current ||
        native.authority !== "harness-minted" ||
        native.profile !== "headless-turn" ||
        native.epoch !== start.epoch ||
        native.turnId !== start.turnId ||
        native.sessionId !== pending.launch.registration.nativeSessionId ||
        context?.ambiguous !== false
      )
        return refuseConnection(state, now, "connection-unverified");
      next = {
        ...state,
        connection: {
          ...connection,
          actions,
          launches: {
            ...connection.launches,
            [fact.launchId]: {
              identitySeq: native.seq,
              kind: "started",
              launch: pending.launch,
              startedActionId: fact.actionId,
            },
          },
          revision: state.seq + 1,
        },
        seq: state.seq + 1,
      };
    } else if (fact.kind === "launch-settled") {
      const connection = state.connection;
      const pending = connection?.launches[fact.launchId];
      if (!connection || (pending?.kind !== "intended" && pending?.kind !== "started"))
        return refuseConnection(state, now, "connection-conflict");
      const execution = state.executions[pending.launch.inputId];
      if (
        pending.launch.epoch !== state.epoch ||
        !pending.launch.execution ||
        execution?.kind !== "attempt-ended" ||
        JSON.stringify(execution.start) !== JSON.stringify(pending.launch.execution)
      )
        return refuseConnection(state, now, "execution-blocked");
      next = {
        ...state,
        connection: {
          ...connection,
          actions,
          launches: {
            ...connection.launches,
            [fact.launchId]: {
              kind: "settled",
              launch: pending.launch,
              outcome: execution.outcome,
              settledActionId: fact.actionId,
              start:
                pending.kind === "started"
                  ? { actionId: pending.startedActionId, identitySeq: pending.identitySeq }
                  : null,
            },
          },
          revision: state.seq + 1,
        },
        seq: state.seq + 1,
      };
    } else if (fact.kind === "launch-refused") {
      const connection = state.connection;
      const pending = connection?.launches[fact.launchId];
      if (!connection || pending?.kind !== "intended")
        return refuseConnection(state, now, "connection-conflict");
      const execution = state.executions[pending.launch.inputId];
      if (
        !pending.launch.execution ||
        execution?.kind !== "attempt-ended" ||
        execution.outcome.kind !== "pre-start-failed" ||
        JSON.stringify(execution.start) !== JSON.stringify(pending.launch.execution)
      )
        return refuseConnection(state, now, "execution-blocked");
      next = {
        ...state,
        connection: {
          ...connection,
          actions,
          launches: {
            ...connection.launches,
            [fact.launchId]: {
              failure: execution.outcome.failure,
              kind: "refused",
              launch: pending.launch,
              refusedActionId: fact.actionId,
            },
          },
          revision: state.seq + 1,
        },
        seq: state.seq + 1,
      };
    } else if (fact.kind === "input-held") {
      const connection = state.connection;
      const hold = fact.hold;
      if (!connection || !matchingListener(state, hold, now))
        return refuseConnection(state, now, "connection-unverified");
      if (hasUnsettledNativeWork(state)) return refuseConnection(state, now, "execution-blocked");
      if (
        !state.inputs.some((input) => input.id === hold.inputId) ||
        Object.hasOwn(state.appliedInputs, hold.inputId)
      )
        return refuseConnection(state, now, "execution-ineligible");
      next = {
        ...state,
        connection: {
          ...connection,
          actions,
          heldInputs: { ...connection.heldInputs, [hold.inputId]: hold },
          revision: state.seq + 1,
        },
        seq: state.seq + 1,
      };
    } else if (fact.kind === "input-cancelled") {
      const connection = state.connection;
      if (!connection) return refuseConnection(state, now, "connection-unverified");
      const execution = state.executions[fact.inputId];
      if (
        Object.hasOwn(state.appliedInputs, fact.inputId) ||
        Object.values(connection.launches).some(
          (entry) => entry.kind === "intended" && entry.launch.inputId === fact.inputId,
        ) ||
        Object.values(connection.offers).some((entry) => entry.offer.inputId === fact.inputId) ||
        execution?.kind === "attempt-started" ||
        execution?.kind === "attempt-ended"
      )
        return refuseConnection(state, now, "input-already-dispatched");
      if (!state.inputs.some((input) => input.id === fact.inputId))
        return refuseConnection(state, now, "execution-ineligible");
      next = {
        ...state,
        connection: {
          ...connection,
          actions,
          cancelledInputs: { ...connection.cancelledInputs, [fact.inputId]: fact.actionId },
          heldInputs: clearInputHold(connection.heldInputs, fact.inputId),
          revision: state.seq + 1,
        },
        inputs: state.inputs.filter((input) => input.id !== fact.inputId),
        seq: state.seq + 1,
      };
    } else if (fact.kind === "listener-disabled") {
      const connection = state.connection;
      const listener = currentListener(connection);
      if (
        !connection ||
        !listener ||
        listener.id !== fact.participationId ||
        listener.epoch !== fact.epoch ||
        state.epoch !== fact.epoch
      )
        return refuseConnection(state, now, "connection-unverified");
      next = {
        ...state,
        connection: {
          ...connection,
          actions,
          disabledReason: fact.reason,
          listenerId: null,
          revision: state.seq + 1,
        },
        seq: state.seq + 1,
      };
    } else if (fact.kind === "listener-enabled") {
      const connection = state.connection;
      const p = fact.participation;
      const binding = connection?.binding;
      const reconnect = reconnectForListener(connection, p.registration);
      if (fact.source === "continuation" && !continuationListener(connection))
        return refuseConnection(state, now, "connection-not-admitted");
      if (
        !connection ||
        !binding ||
        !sameNativeTarget(p.registration, binding) ||
        Object.hasOwn(connection.participations, p.id) ||
        state.attachment !== null
      )
        return refuseConnection(state, now, "connection-conflict");
      if (
        p.epoch !== state.epoch + 1 ||
        p.expiresAt <= now ||
        p.expiresAt - now > LISTENER_WAIT_MAX_MS
      )
        return refuseConnection(state, now, "connection-unverified");
      if (hasUnsettledNativeExecution(state) || (currentReconnect(connection) && !reconnect))
        return refuseConnection(state, now, "execution-blocked");
      next = {
        ...state,
        connection: {
          ...connection,
          actions,
          disabledReason: null,
          explicitListenerEpoch:
            fact.source === "explicit" ? p.epoch : connection.explicitListenerEpoch,
          listenerId: p.id,
          participations: { ...connection.participations, [p.id]: p },
          reconnectId: reconnect ? null : connection.reconnectId,
          reconnects: reconnect
            ? {
                ...connection.reconnects,
                [reconnect.request.request.id]: {
                  ...reconnect.request,
                  kind: "fulfilled",
                  started: reconnect.started,
                  participationId: p.id,
                  fulfilledActionId: fact.actionId,
                },
              }
            : connection.reconnects,
          revision: state.seq + 1,
        },
        epoch: p.epoch,
        seq: state.seq + 1,
      };
    } else if (fact.kind === "offer-started") {
      const connection = state.connection;
      const o = fact.offer;
      if (!connection || !matchingListener(state, o, now))
        return refuseConnection(state, now, "connection-unverified");
      if (hasUnsettledNativeWork(state)) return refuseConnection(state, now, "execution-blocked");
      if (Object.hasOwn(connection.offers, o.id) || Object.hasOwn(state.seenTurns, o.turnId))
        return refuseConnection(state, now, "connection-conflict");
      if (
        o.attempt !== 1 ||
        !state.inputs.some((input) => input.id === o.inputId) ||
        Object.hasOwn(state.appliedInputs, o.inputId)
      )
        return refuseConnection(state, now, "execution-ineligible");
      next = {
        ...state,
        connection: {
          ...connection,
          actions,
          heldInputs: clearInputHold(connection.heldInputs, o.inputId),
          offers: { ...connection.offers, [o.id]: { kind: "sending", offer: o } },
          revision: state.seq + 1,
        },
        seenTurns: { ...state.seenTurns, [o.turnId]: true },
        seq: state.seq + 1,
      };
    } else if (fact.kind === "receipt-confirmed") {
      const connection = state.connection;
      const pending = matchingOffer(state, fact);
      if (!connection || !pending) return refuseConnection(state, now, "receipt-stale");
      if (pending.kind !== "sending") return refuseConnection(state, now, "connection-conflict");
      if (
        !state.inputs.some((input) => input.id === pending.offer.inputId) ||
        Object.hasOwn(state.appliedInputs, pending.offer.inputId)
      )
        return refuseConnection(state, now, "receipt-stale");
      next = {
        ...state,
        appliedInputs: { ...state.appliedInputs, [pending.offer.inputId]: true },
        connection: {
          ...connection,
          actions,
          offers: {
            ...connection.offers,
            [fact.offerId]: {
              kind: "received",
              offer: pending.offer,
              receiptActionId: fact.actionId,
            },
          },
          revision: state.seq + 1,
        },
        inFlightInputs: InputLedger.inputDelivered(state.inFlightInputs),
        inputs: state.inputs.filter((input) => input.id !== pending.offer.inputId),
        seq: state.seq + 1,
      };
    } else {
      const connection = state.connection;
      const pending = matchingOffer(state, fact);
      if (!connection || !pending) return refuseConnection(state, now, "receipt-stale");
      if (pending.kind === "sending") return refuseConnection(state, now, "receipt-required");
      if (pending.kind === "finished") return refuseConnection(state, now, "connection-conflict");
      next = {
        ...state,
        completedTurns: { ...state.completedTurns, [pending.offer.turnId]: state.seq + 1 },
        connection: {
          ...connection,
          actions,
          offers: {
            ...connection.offers,
            [fact.offerId]: {
              kind: "finished",
              offer: pending.offer,
              outcome: fact.outcome,
              outcomeActionId: fact.actionId,
              receiptActionId: pending.receiptActionId,
            },
          },
          revision: state.seq + 1,
        },
        inFlightInputs: InputLedger.turnEnded(state.inFlightInputs, EventKind.done),
        questionOpen:
          fact.outcome.kind === "question"
            ? { question: fact.outcome.text, turnId: pending.offer.turnId }
            : null,
        seq: state.seq + 1,
      };
    }
  }
  return {
    effects: [],
    record: {
      conversationId: state.conversationId,
      epoch: next.epoch,
      kind: "input",
      now,
      seq: next.seq,
      verdict: "accepted",
    },
    state: next,
    verdict: "accepted",
  };
}

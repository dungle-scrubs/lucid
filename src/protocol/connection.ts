import { EventKind } from "./events.js";
import { type ContextBoundary, parseContextBoundary } from "./execution.js";
import type { HarnessName, ProtocolIssue } from "./frames.js";
import { isWireId, isWireText } from "./frames.js";
import { InputLedger } from "./ledgers/input.js";
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
  readonly listenerId: string | null;
  readonly offers: Readonly<Record<string, NativeOfferState>>;
  readonly participations: Readonly<Record<string, ListenerParticipation>>;
  readonly revision: number;
}

export const LISTENER_WAIT_MAX_MS = 45_000;
export type ListenerDisabledReason = "expired" | "interrupted" | "owner-lost";

export interface ListenerParticipation {
  readonly epoch: number;
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

export type ConnectionFact =
  | { readonly actionId: string; readonly inputId: string; readonly kind: "input-cancelled" }
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

export function connectionRegistration(
  connection: ConnectionState | null,
  fact: ConnectionFact,
): NativeBinding | undefined {
  switch (fact.kind) {
    case "input-cancelled":
      return undefined;
    case "bound":
      return fact.binding;
    case "listener-enabled":
      return fact.participation.registration;
    case "offer-started":
      return connection?.participations[fact.offer.participationId]?.registration;
    case "receipt-confirmed":
    case "offer-outcome":
    case "listener-disabled":
      return connection?.participations[fact.participationId]?.registration;
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
  return owners;
}

export const connectionId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
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

export function parseConnectionFact(value: unknown): ConnectionFact | null {
  if (!object(value) || !connectionId(value.actionId)) return null;
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
    if (!registration || !connectionId(p.id) || !positive(p.epoch) || !positive(p.expiresAt))
      return null;
    return {
      actionId: value.actionId,
      kind: value.kind,
      participation: { epoch: p.epoch, expiresAt: p.expiresAt, id: p.id, registration },
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
      typeof value.stamp !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.stamp)
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
          listenerId: state.connection?.listenerId ?? null,
          offers: state.connection?.offers ?? {},
          participations: state.connection?.participations ?? {},
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
      if (
        fact.source === "continuation" &&
        (!connection?.listenerId ||
          connection.disabledReason !== null ||
          !Object.values(connection.offers).some(
            (entry) =>
              entry.kind === "finished" && entry.offer.participationId === connection.listenerId,
          ))
      )
        return refuseConnection(state, now, "connection-not-admitted");
      if (
        !connection ||
        !binding ||
        p.registration.nativeSessionId !== binding.nativeSessionId ||
        p.registration.harness !== binding.harness ||
        p.registration.interface !== binding.interface ||
        p.registration.workingDirectory !== binding.workingDirectory ||
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
      if (
        hasUnresolvedOffer(connection) ||
        Object.values(state.executions).some(
          (entry) =>
            entry.kind === "attempt-started" ||
            (entry.kind === "attempt-ended" && entry.outcome.kind === "uncertain"),
        )
      )
        return refuseConnection(state, now, "execution-blocked");
      next = {
        ...state,
        connection: {
          ...connection,
          actions,
          disabledReason: null,
          listenerId: p.id,
          participations: { ...connection.participations, [p.id]: p },
          revision: state.seq + 1,
        },
        epoch: p.epoch,
        seq: state.seq + 1,
      };
    } else if (fact.kind === "offer-started") {
      const connection = state.connection;
      const o = fact.offer;
      const listener = currentListener(connection);
      if (
        !connection ||
        !listener ||
        listener.id !== o.participationId ||
        listener.epoch !== o.epoch ||
        state.epoch !== o.epoch ||
        listener.expiresAt <= now
      )
        return refuseConnection(state, now, "connection-unverified");
      if (hasUnresolvedOffer(connection)) return refuseConnection(state, now, "execution-blocked");
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

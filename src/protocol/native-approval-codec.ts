import { EventKind } from "./events.js";
import { isWireId } from "./frames.js";

export interface ApprovalChoice {
  readonly id: string;
  readonly label: string;
  readonly scope: "once" | "turn" | "session" | "persistent" | "deny" | "cancel";
}

export interface ApprovalRequest {
  readonly category: "command" | "file-change" | "permissions";
  readonly choices: readonly ApprovalChoice[];
  readonly details: string;
  readonly kind: typeof EventKind.approvalRequest;
  readonly requestId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly v: 1;
}

export interface ApprovalAttempt {
  readonly attempt: number;
  readonly epoch: number;
  readonly inputId: string;
  readonly turnId: string;
}

export interface ApprovalDecision {
  readonly choiceId: string;
  readonly id: string;
  readonly requestId: string;
}

export type ApprovalDelivery = ApprovalDecision &
  (
    | { readonly status: "decided" | "sending" | "sent" }
    | { readonly status: "rejected"; readonly reason: string }
  );

export type ApprovalFact = ApprovalAttempt &
  (
    | { readonly kind: "request"; readonly request: ApprovalRequest }
    | { readonly kind: "decision"; readonly decision: ApprovalDecision }
    | { readonly kind: "write-intent"; readonly id: string; readonly requestId: string }
    | {
        readonly kind: "cleared";
        readonly requestId: string;
        readonly reason: "native-resolved" | "turn-ended" | "process-ended" | "channel-failed";
      }
    | {
        readonly kind: "disposition";
        readonly id: string;
        readonly requestId: string;
        readonly status: "sent";
      }
    | {
        readonly kind: "disposition";
        readonly id: string;
        readonly requestId: string;
        readonly status: "rejected";
        readonly reason: string;
      }
  );

export type ApprovalState = ApprovalAttempt & {
  readonly request: ApprovalRequest;
  readonly seq: number;
} & (
    | { readonly status: "pending"; readonly decision?: never }
    | {
        readonly status: "decided";
        readonly decision: ApprovalDecision & { readonly status: "decided" };
      }
    | {
        readonly status: "sending";
        readonly decision: ApprovalDecision & { readonly status: "sending" };
      }
    | {
        readonly status: "sent";
        readonly decision: ApprovalDecision & { readonly status: "sent" };
      }
    | {
        readonly status: "cleared" | "unavailable";
        readonly reason: string;
        readonly decision?: ApprovalDelivery;
      }
  );

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && isWireId(value);
const approvalId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const nat = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).length <= max;

export function parseApprovalRequest(value: unknown): ApprovalRequest | null {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "v",
          "kind",
          "requestId",
          "sessionId",
          "turnId",
          "category",
          "choices",
          "details",
        ].includes(key),
    ) ||
    value.v !== 1 ||
    value.kind !== EventKind.approvalRequest ||
    !approvalId(value.requestId) ||
    !id(value.sessionId) ||
    !id(value.turnId) ||
    typeof value.category !== "string" ||
    !["command", "file-change", "permissions"].includes(value.category) ||
    !text(value.details, 65536) ||
    !Array.isArray(value.choices) ||
    value.choices.length === 0 ||
    value.choices.length > 16
  )
    return null;
  const choices: ApprovalChoice[] = [];
  for (const choice of value.choices) {
    if (
      !object(choice) ||
      !id(choice.id) ||
      !text(choice.label, 512) ||
      typeof choice.scope !== "string" ||
      !["once", "turn", "session", "persistent", "deny", "cancel"].includes(choice.scope) ||
      Object.keys(choice).some((key) => !["id", "label", "scope"].includes(key))
    )
      return null;
    choices.push({
      id: choice.id,
      label: choice.label,
      scope: choice.scope as ApprovalChoice["scope"],
    });
  }
  if (new Set(choices.map((choice) => choice.id)).size !== choices.length) return null;
  return {
    category: value.category as ApprovalRequest["category"],
    choices,
    details: value.details,
    kind: EventKind.approvalRequest,
    requestId: value.requestId,
    sessionId: value.sessionId,
    turnId: value.turnId,
    v: 1,
  };
}

export function parseApprovalDecision(value: unknown): ApprovalDecision | null {
  if (
    !object(value) ||
    !approvalId(value.id) ||
    !approvalId(value.requestId) ||
    !id(value.choiceId) ||
    Object.keys(value).some((key) => !["id", "requestId", "choiceId"].includes(key))
  )
    return null;
  return { choiceId: value.choiceId, id: value.id, requestId: value.requestId };
}

export function parseApprovalFact(value: unknown): ApprovalFact | null {
  if (
    !object(value) ||
    !nat(value.attempt) ||
    !nat(value.epoch) ||
    !id(value.inputId) ||
    !id(value.turnId)
  )
    return null;
  const bound = {
    attempt: value.attempt,
    epoch: value.epoch,
    inputId: value.inputId,
    turnId: value.turnId,
  };
  if (value.kind === "request") {
    const request = parseApprovalRequest(value.request);
    return request ? { ...bound, kind: "request", request } : null;
  }
  if (value.kind === "decision") {
    const decision = parseApprovalDecision(value.decision);
    return decision ? { ...bound, decision, kind: "decision" } : null;
  }
  if (
    value.kind === "cleared" &&
    approvalId(value.requestId) &&
    typeof value.reason === "string" &&
    ["native-resolved", "turn-ended", "process-ended", "channel-failed"].includes(value.reason)
  )
    return {
      ...bound,
      kind: "cleared",
      requestId: value.requestId,
      reason: value.reason as Extract<ApprovalFact, { kind: "cleared" }>["reason"],
    };
  if (
    value.kind === "disposition" &&
    approvalId(value.id) &&
    approvalId(value.requestId) &&
    value.status === "rejected" &&
    text(value.reason, 512)
  )
    return {
      ...bound,
      id: value.id,
      kind: "disposition",
      requestId: value.requestId,
      reason: value.reason,
      status: "rejected",
    };
  if (
    value.kind === "disposition" &&
    approvalId(value.id) &&
    approvalId(value.requestId) &&
    value.status === "sent"
  )
    return {
      ...bound,
      id: value.id,
      kind: "disposition",
      requestId: value.requestId,
      status: "sent",
    };
  return value.kind === "write-intent" && approvalId(value.id) && approvalId(value.requestId)
    ? { ...bound, id: value.id, kind: "write-intent", requestId: value.requestId }
    : null;
}

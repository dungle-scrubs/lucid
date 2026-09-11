import type { HarnessName, ProtocolIssue } from "./frames.js";
import { isWireId } from "./frames.js";
import type { ProcessOwner } from "./process-owner.js";
import { parseProcessOwner } from "./process-owner.js";
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
}

export interface ConnectionFact {
  readonly actionId: string;
  readonly binding: NativeBinding;
  readonly kind: "bound";
}

export function nativeOwners(state: ChannelState): readonly { readonly owner?: ProcessOwner }[] {
  const owners: { readonly owner?: ProcessOwner }[] = [...state.terminalParticipations];
  const binding = state.connection?.binding;
  if (
    binding &&
    !owners.some(
      (entry) =>
        entry.owner?.pid === binding.owner.pid &&
        entry.owner.startedAt === binding.owner.startedAt &&
        entry.owner.executable === binding.owner.executable,
    )
  )
    owners.push({ owner: binding.owner });
  return owners;
}

export const connectionId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
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
  if (!object(value) || !connectionId(value.actionId) || value.kind !== "bound") return null;
  const binding = parseNativeBinding(value.binding);
  return binding ? { actionId: value.actionId, binding, kind: "bound" } : null;
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

/** Live writes verify native authority in the host; replay repeats this same transition. */
export function reduceConnection(state: ChannelState, raw: unknown, now: number): ReduceResult {
  const fact = parseConnectionFact(raw);
  if (!fact) return refuseConnection(state, now, "invalid-connection");
  const serialized = JSON.stringify(fact);
  const prior = state.connection?.actions[fact.actionId];
  if (
    (prior !== undefined && prior !== serialized) ||
    (state.connection && JSON.stringify(state.connection.binding) !== JSON.stringify(fact.binding))
  )
    return refuseConnection(state, now, "connection-conflict");
  const next: ChannelState =
    prior === serialized
      ? state
      : {
          ...state,
          connection: {
            actions: { ...state.connection?.actions, [fact.actionId]: serialized },
            binding: fact.binding,
          },
          seq: state.seq + 1,
        };
  return {
    effects: [],
    record: {
      conversationId: state.conversationId,
      epoch: state.epoch,
      kind: "input",
      now,
      seq: next.seq,
      verdict: "accepted",
    },
    state: next,
    verdict: "accepted",
  };
}

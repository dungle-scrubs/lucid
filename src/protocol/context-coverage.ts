import { EventKind } from "./events.js";
import type { AttemptStart, ContextBoundary } from "./execution.js";
import { HARNESS_NAMES, type HarnessName, isWireId } from "./frames.js";
import type { ChannelState, ReduceResult } from "./reducer.js";

export interface ContextOfferRequest {
  readonly context: ContextBoundary;
  readonly harness: HarnessName;
  readonly sessionId: string;
  readonly turnId: string;
}
interface ContextSupply extends ContextOfferRequest {
  readonly epoch: number;
  readonly managed?: { readonly attempt: number; readonly inputId: string };
}
export interface ContextOffer extends ContextSupply {
  readonly kind: "coverage-offered";
}
export interface ContextConfirmation extends ContextSupply {
  readonly evidence: { readonly kind: "completed-turn"; readonly seq: number };
  readonly kind: "coverage-confirmed";
  readonly through: number;
}
export type ContextFact = ContextOffer | ContextConfirmation;
export type SessionContext = ContextFact;

export interface ContextTurn {
  readonly ambiguous: boolean;
  readonly ended: boolean;
  readonly epoch: number;
  readonly harness: HarnessName | undefined;
  readonly sessionId: string | null;
}

export function recordContextTurn(
  turns: Readonly<Record<string, ContextTurn>>,
  turnId: string,
  epoch: number,
  harness: HarnessName | undefined,
  event: Readonly<Record<string, unknown>>,
): Readonly<Record<string, ContextTurn>> {
  if (event.kind !== EventKind.identity && event.kind !== EventKind.done) return turns;
  const prior = turns[turnId];
  if (event.kind === EventKind.done)
    return {
      ...turns,
      [turnId]: {
        epoch,
        harness,
        sessionId: prior?.sessionId ?? null,
        ended: true,
        ambiguous: prior?.ambiguous ?? false,
      },
    };
  const sessionId =
    !prior?.ended &&
    typeof event.sessionId === "string" &&
    isWireId(event.sessionId) &&
    (event.authority === "harness-minted" || event.authority === "caller-assigned")
      ? event.sessionId
      : null;
  const ambiguous =
    prior?.ambiguous === true ||
    prior?.ended === true ||
    (prior?.sessionId !== null && prior?.sessionId !== undefined && sessionId !== prior.sessionId);
  return {
    ...turns,
    [turnId]: {
      epoch,
      harness,
      sessionId: ambiguous ? null : sessionId,
      ended: prior?.ended ?? false,
      ambiguous,
    },
  };
}

interface ContentRange {
  readonly from: number;
  readonly through: number;
  readonly kind: "input" | "turn";
  readonly id: string;
}

/** Consecutive events from one turn form one range, including metadata gaps.
 * Updating the current range costs no copy of the accumulated history. */
export interface ContextContent {
  readonly current: ContentRange | null;
  readonly earlier: readonly ContentRange[];
}

export function recordContextContent(
  content: ContextContent,
  kind: ContentRange["kind"],
  id: string,
  seq: number,
): ContextContent {
  const current = content.current;
  if (current?.kind === kind && current.id === id)
    return { ...content, current: { ...current, through: seq + 1 } };
  return {
    current: { from: seq, through: seq + 1, kind, id },
    earlier: current ? [...content.earlier, current] : content.earlier,
  };
}

export function contextConfirmationLimit(
  state: ChannelState,
  offer: ContextSupply,
  terminalSeq: number,
): number {
  let through = terminalSeq + 1;
  const visit = (range: ContentRange): void => {
    if (range.through <= offer.context.through || range.from >= through) return;
    if (
      (range.kind === "turn" && range.id === offer.turnId) ||
      (range.kind === "input" && range.id === offer.managed?.inputId)
    )
      return;
    through = Math.max(range.from, offer.context.through);
  };
  if (state.contextContent.current) visit(state.contextContent.current);
  for (let index = state.contextContent.earlier.length - 1; index >= 0; index--) {
    const range = state.contextContent.earlier[index];
    if (!range || range.through <= offer.context.through) break;
    visit(range);
  }
  return through;
}

const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const natural = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const id = (v: unknown): v is string => typeof v === "string" && isWireId(v);
export const contextSessionKey = (harness: HarnessName, sessionId: string): string =>
  JSON.stringify([harness, sessionId]);
export const confirmedContextThrough = (
  state: ChannelState,
  harness: HarnessName,
  sessionId: string,
): number => state.contextCoverage[contextSessionKey(harness, sessionId)] ?? 0;

export function parseContextFact(raw: unknown): ContextFact | null {
  if (
    !object(raw) ||
    !id(raw.turnId) ||
    !natural(raw.epoch) ||
    !HARNESS_NAMES.includes(raw.harness as HarnessName) ||
    !id(raw.sessionId)
  )
    return null;
  const { context: c, managed: m } = raw;
  if (
    !object(c) ||
    !natural(c.from) ||
    !natural(c.through) ||
    c.from > c.through ||
    typeof c.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(c.digest)
  )
    return null;
  let managed: ContextSupply["managed"];
  if (m !== undefined) {
    if (!object(m) || !id(m.inputId) || !natural(m.attempt) || m.attempt === 0) return null;
    managed = { attempt: m.attempt, inputId: m.inputId };
  }
  const supply: ContextSupply = {
    epoch: raw.epoch,
    harness: raw.harness as HarnessName,
    sessionId: raw.sessionId,
    turnId: raw.turnId,
    context: { digest: c.digest, from: c.from, through: c.through },
    ...(managed ? { managed } : {}),
  };
  if (raw.kind === "coverage-offered") return { ...supply, kind: raw.kind };
  if (
    raw.kind !== "coverage-confirmed" ||
    !natural(raw.through) ||
    !object(raw.evidence) ||
    raw.evidence.kind !== "completed-turn" ||
    !natural(raw.evidence.seq)
  )
    return null;
  return {
    ...supply,
    kind: raw.kind,
    through: raw.through,
    evidence: { kind: "completed-turn", seq: raw.evidence.seq },
  };
}

export function contextAttempt(state: ChannelState, turnId: string): AttemptStart | undefined {
  for (const execution of Object.values(state.executions)) {
    const start =
      execution.kind === "attempt-started"
        ? execution
        : execution.kind === "attempt-ended"
          ? execution.start
          : undefined;
    if (start?.turnId === turnId) return start;
    if (execution.previous?.start.turnId === turnId) return execution.previous.start;
  }
  return undefined;
}

function suppliedByAttempt(fact: ContextSupply, start: AttemptStart | undefined): boolean {
  return (
    !!start &&
    fact.managed?.inputId === start.inputId &&
    fact.managed.attempt === start.attempt &&
    fact.turnId === start.turnId &&
    fact.epoch === start.epoch &&
    fact.harness === start.driver.harness &&
    fact.context.from === start.context.from &&
    fact.context.through === start.context.through &&
    fact.context.digest === start.context.digest &&
    (start.native.kind === "fresh" || start.native.sessionId === fact.sessionId)
  );
}

function sameSupply(a: ContextSupply, b: ContextSupply): boolean {
  return (
    a.epoch === b.epoch &&
    a.harness === b.harness &&
    a.sessionId === b.sessionId &&
    a.turnId === b.turnId &&
    a.context.from === b.context.from &&
    a.context.through === b.context.through &&
    a.context.digest === b.context.digest &&
    a.managed?.attempt === b.managed?.attempt &&
    a.managed?.inputId === b.managed?.inputId
  );
}

/** Offers are evidence of supply, never an input disposition or delivery cursor. */
export function reduceContextCoverage(
  state: ChannelState,
  raw: unknown,
  now: number,
  executor: boolean,
): ReduceResult {
  const fact = parseContextFact(raw);
  const reject = (): ReduceResult => ({
    verdict: "refused",
    issue: executor ? "execution-ineligible" : "executor-required",
    state,
    effects: [],
    record: {
      verdict: "refused",
      kind: "input",
      conversationId: state.conversationId,
      epoch: state.epoch,
      issue: executor ? "execution-ineligible" : "executor-required",
      now,
    },
  });
  if (!fact || !executor) return reject();
  const accept = (next: ChannelState): ReduceResult => ({
    verdict: "accepted",
    state: next,
    effects: [],
    record: {
      verdict: "accepted",
      kind: "input",
      conversationId: state.conversationId,
      epoch: state.epoch,
      seq: next.seq,
      now,
    },
  });
  const old = state.contextOffers[fact.turnId];
  const native = state.contextTurns[fact.turnId];
  const actualNative =
    native?.harness === fact.harness &&
    native.epoch === fact.epoch &&
    native.sessionId === fact.sessionId;
  const attempt = contextAttempt(state, fact.turnId);
  if (fact.kind === "coverage-offered") {
    if (old) return sameSupply(old, fact) ? accept(state) : reject();
    if (
      !actualNative ||
      fact.epoch !== state.epoch ||
      state.attachment?.harness !== fact.harness ||
      state.turn?.turnId !== fact.turnId ||
      native?.ended === true ||
      fact.context.through > state.seq + 1 ||
      fact.context.from > confirmedContextThrough(state, fact.harness, fact.sessionId) ||
      (attempt ? !suppliedByAttempt(fact, attempt) : fact.managed !== undefined)
    )
      return reject();
    return accept({
      ...state,
      seq: state.seq + 1,
      contextOffers: { ...state.contextOffers, [fact.turnId]: fact },
    });
  }
  if (old?.kind === "coverage-confirmed")
    return JSON.stringify(old) === JSON.stringify(fact) ? accept(state) : reject();
  if (
    state.completedTurns[fact.turnId] !== fact.evidence.seq ||
    fact.through < fact.context.through ||
    fact.through > contextConfirmationLimit(state, fact, fact.evidence.seq)
  )
    return reject();
  // A managed attempt persisted its offer before dispatch. Recovery can bind
  // that offer to the verified native identity and terminal evidence directly.
  if (
    !actualNative ||
    (old
      ? !sameSupply(old, fact)
      : !suppliedByAttempt(fact, attempt) ||
        fact.context.from > confirmedContextThrough(state, fact.harness, fact.sessionId))
  )
    return reject();
  const key = contextSessionKey(fact.harness, fact.sessionId);
  return accept({
    ...state,
    seq: state.seq + 1,
    contextOffers: { ...state.contextOffers, [fact.turnId]: fact },
    contextCoverage: {
      ...state.contextCoverage,
      [key]: Math.max(state.contextCoverage[key] ?? 0, fact.through),
    },
  });
}

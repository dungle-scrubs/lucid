import type { HarnessName, ProtocolIssue } from "./frames.js";
import { HARNESS_NAMES, isWireId } from "./frames.js";
import type { ChannelState, ReduceResult } from "./reducer.js";

export interface ExecutionDriver {
  readonly effort: string;
  readonly harness: HarnessName;
  readonly model: string;
  readonly profile: "headless-turn" | "headless-session";
  readonly provider?: string;
}

export interface ContextBoundary {
  readonly digest: string;
  readonly from: number;
  readonly through: number;
}

export type NativeIntent =
  | { readonly kind: "fresh" }
  | { readonly kind: "resume"; readonly sessionId: string };
export interface AttemptStart {
  readonly epoch: number;
  readonly attempt: number;
  readonly context: ContextBoundary;
  readonly driver: ExecutionDriver;
  readonly inputId: string;
  readonly kind: "attempt-started";
  readonly native: NativeIntent;
  readonly turnId: string;
}

export interface ExecutionFailure {
  readonly code: string;
  readonly evidence: "dispatch-not-called" | "harness-refusal" | "terminal-error" | "process-lost";
  readonly reason: string;
}

export type AttemptOutcome =
  | { readonly kind: "completed"; readonly terminalSeq: number }
  | {
      readonly kind: "pre-start-failed" | "failed-after-start" | "uncertain";
      readonly failure: ExecutionFailure;
    };

export interface ExecutionHold {
  readonly actions: readonly string[];
  readonly code: "E-HUB-03" | "E-HUB-04" | "E-HUB-06" | "E-COMP-07";
  readonly prerequisite: string;
  readonly reason: string;
}

export type ExecutionFact =
  | AttemptStart
  | {
      readonly attempt: number;
      readonly inputId: string;
      readonly kind: "held";
      readonly hold: ExecutionHold;
    }
  | {
      readonly actionId: string;
      readonly acknowledgeEffects: boolean;
      readonly attempt: number;
      readonly inputId: string;
      readonly kind: "retry-authorized" | "fresh-authorized";
    }
  | {
      readonly attempt: number;
      readonly inputId: string;
      readonly kind: "attempt-ended";
      readonly outcome: AttemptOutcome;
      readonly turnId: string;
    };

interface ExecutionBase {
  readonly actions: Readonly<Record<string, string>>;
  readonly attempt: number;
  readonly previous?: { readonly start: AttemptStart; readonly outcome: AttemptOutcome };
}

export type ExecutionState = ExecutionBase &
  (
    | { readonly kind: "requested" }
    | {
        readonly kind: "held";
        readonly hold: ExecutionHold;
        readonly authorization: "requested" | "retry-authorized" | "fresh-authorized";
      }
    | { readonly kind: "retry-authorized" | "fresh-authorized" }
    | AttemptStart
    | {
        readonly kind: "attempt-ended";
        readonly outcome: AttemptOutcome;
        readonly start: AttemptStart;
      }
  );

const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === "string" && isWireId(v);
const nat = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 4096;

/** Both API writes and log replay validate the internal payload here. */
export function parseExecutionFact(value: unknown): ExecutionFact | null {
  if (!object(value) || !id(value.inputId) || !nat(value.attempt)) return null;
  const base = { attempt: value.attempt, inputId: value.inputId };
  switch (value.kind) {
    case "attempt-started": {
      const { context: c, driver: d, native: n, turnId, epoch } = value;
      if (
        !id(turnId) ||
        !nat(epoch) ||
        !object(c) ||
        !nat(c.from) ||
        !nat(c.through) ||
        c.from > c.through ||
        typeof c.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(c.digest) ||
        !object(d) ||
        !HARNESS_NAMES.includes(d.harness as HarnessName) ||
        !id(d.model) ||
        !id(d.effort) ||
        (d.profile !== "headless-turn" && d.profile !== "headless-session") ||
        (d.provider !== undefined && !id(d.provider)) ||
        !object(n) ||
        (n.kind !== "fresh" && !(n.kind === "resume" && id(n.sessionId)))
      )
        return null;
      return {
        ...base,
        kind: value.kind,
        epoch,
        turnId,
        context: { digest: c.digest, from: c.from, through: c.through },
        driver: {
          effort: d.effort,
          harness: d.harness as HarnessName,
          model: d.model,
          profile: d.profile,
          ...(d.provider === undefined ? {} : { provider: d.provider as string }),
        },
        native:
          n.kind === "fresh"
            ? { kind: "fresh" }
            : { kind: "resume", sessionId: n.sessionId as string },
      };
    }
    case "held": {
      const h = value.hold;
      if (
        !object(h) ||
        !["E-HUB-03", "E-HUB-04", "E-HUB-06", "E-COMP-07"].includes(String(h.code)) ||
        !text(h.reason) ||
        !text(h.prerequisite) ||
        !Array.isArray(h.actions) ||
        h.actions.length > 8 ||
        !h.actions.every(id)
      )
        return null;
      return {
        ...base,
        kind: value.kind,
        hold: {
          code: h.code as ExecutionHold["code"],
          reason: h.reason,
          prerequisite: h.prerequisite,
          actions: [...h.actions],
        },
      };
    }
    case "retry-authorized":
    case "fresh-authorized":
      return id(value.actionId) && typeof value.acknowledgeEffects === "boolean"
        ? {
            ...base,
            kind: value.kind,
            actionId: value.actionId,
            acknowledgeEffects: value.acknowledgeEffects,
          }
        : null;
    case "attempt-ended": {
      if (!id(value.turnId) || !object(value.outcome)) return null;
      const o = value.outcome;
      if (o.kind === "completed")
        return nat(o.terminalSeq)
          ? {
              ...base,
              kind: value.kind,
              turnId: value.turnId,
              outcome: { kind: "completed", terminalSeq: o.terminalSeq },
            }
          : null;
      const f = o.failure;
      if (
        (o.kind !== "pre-start-failed" &&
          o.kind !== "failed-after-start" &&
          o.kind !== "uncertain") ||
        !object(f) ||
        !id(f.code) ||
        !text(f.reason) ||
        !["dispatch-not-called", "harness-refusal", "terminal-error", "process-lost"].includes(
          String(f.evidence),
        )
      )
        return null;
      if (
        o.kind === "pre-start-failed" &&
        f.evidence !== "dispatch-not-called" &&
        f.evidence !== "harness-refusal"
      )
        return null;
      return {
        ...base,
        kind: value.kind,
        turnId: value.turnId,
        outcome: {
          kind: o.kind,
          failure: {
            code: f.code,
            reason: f.reason,
            evidence: f.evidence as ExecutionFailure["evidence"],
          },
        },
      };
    }
    default:
      return null;
  }
}

export function reduceExecution(
  state: ChannelState,
  raw: unknown,
  now: number,
  executor: boolean,
): ReduceResult {
  const fact = parseExecutionFact(raw);
  const reject = (issue: ProtocolIssue = "execution-ineligible"): ReduceResult => ({
    verdict: "refused",
    issue,
    state,
    effects: [],
    record: {
      verdict: "refused",
      kind: "input",
      conversationId: state.conversationId,
      epoch: state.epoch,
      issue,
      now,
    },
  });
  if (!fact) return reject("invalid-execution");
  if (!executor && fact.kind !== "retry-authorized" && fact.kind !== "fresh-authorized")
    return reject("executor-required");
  if (!Object.hasOwn(state.executions, fact.inputId)) return reject("unknown-input");
  const current = state.executions[fact.inputId];
  if (!current) return reject();
  const accept = (next: ExecutionState, duplicate = false): ReduceResult => ({
    verdict: "accepted",
    effects: [],
    state: duplicate
      ? state
      : { ...state, seq: state.seq + 1, executions: { ...state.executions, [fact.inputId]: next } },
    record: {
      verdict: "accepted",
      kind: "input",
      conversationId: state.conversationId,
      epoch: state.epoch,
      seq: state.seq + (duplicate ? 0 : 1),
      now,
      inputId: fact.inputId,
    },
  });
  const previous =
    current.kind === "attempt-ended"
      ? { start: current.start, outcome: current.outcome }
      : current.previous;
  const base = {
    actions: current.actions,
    attempt: fact.attempt,
    ...(previous ? { previous } : {}),
  };
  if (fact.kind === "retry-authorized" || fact.kind === "fresh-authorized") {
    const signature = JSON.stringify(fact);
    if (Object.hasOwn(current.actions, fact.actionId))
      return current.actions[fact.actionId] === signature
        ? accept(current, true)
        : reject("execution-stale");
    if (current.attempt !== fact.attempt) return reject("execution-stale");
    if (current.kind === "held") {
      const action = fact.kind === "retry-authorized" ? "retry" : "continue-fresh";
      if (current.hold.code === "E-COMP-07" || !current.hold.actions.includes(action))
        return reject();
      return accept({
        ...base,
        kind: fact.kind,
        actions: { ...current.actions, [fact.actionId]: signature },
      });
    }
    if (current.kind !== "attempt-ended" || current.outcome.kind === "completed") return reject();
    if (
      current.outcome.kind !== "pre-start-failed" &&
      (fact.kind !== "fresh-authorized" || !fact.acknowledgeEffects)
    )
      return reject();
    return accept({
      ...base,
      kind: fact.kind,
      actions: { ...current.actions, [fact.actionId]: signature },
    });
  }
  if (fact.kind === "attempt-started") {
    if (
      fact.attempt !== current.attempt + 1 ||
      fact.context.through > state.seq + 1 ||
      fact.epoch !== state.epoch ||
      Object.hasOwn(state.seenTurns, fact.turnId) ||
      !["requested", "held", "retry-authorized", "fresh-authorized"].includes(current.kind)
    )
      return reject();
    // A conversation with an unresolved external attempt cannot run later work.
    if (
      Object.values(state.executions).some(
        (e) =>
          e.kind === "attempt-started" ||
          (e.kind === "attempt-ended" && e.outcome.kind === "uncertain"),
      )
    )
      return reject("execution-blocked");
    const authorization = current.kind === "held" ? current.authorization : current.kind;
    if (authorization === "fresh-authorized" && fact.native.kind !== "fresh") return reject();
    return accept({ ...fact, actions: current.actions, ...(previous ? { previous } : {}) });
  }
  if (fact.attempt !== current.attempt) return reject("execution-stale");
  if (fact.kind === "held") {
    if (
      current.kind !== "requested" &&
      current.kind !== "held" &&
      current.kind !== "retry-authorized" &&
      current.kind !== "fresh-authorized"
    )
      return reject();
    if (current.kind === "held" && JSON.stringify(current.hold) === JSON.stringify(fact.hold))
      return accept(current, true);
    return accept({
      ...base,
      kind: fact.kind,
      hold: fact.hold,
      authorization: current.kind === "held" ? current.authorization : current.kind,
    });
  }
  if (
    fact.kind !== "attempt-ended" ||
    current.kind !== "attempt-started" ||
    fact.turnId !== current.turnId ||
    (fact.outcome.kind === "completed" &&
      state.completedTurns[fact.turnId] !== fact.outcome.terminalSeq)
  )
    return reject();
  const { actions: _actions, previous: _previous, ...start } = current;
  return accept({ ...base, kind: "attempt-ended", start, outcome: fact.outcome });
}

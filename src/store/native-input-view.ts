import { compatibilityText } from "../protocol/compatibility.js";
import type { NativeOutcome } from "../protocol/connection.js";
import { requiresNativeConnection } from "../protocol/connection.js";
import type { ConnectionStatus, NativeInputDelivery } from "../protocol/connection-status.js";
import { EventKind } from "../protocol/events.js";
import type { ChannelState } from "../protocol/reducer.js";
import type { Transcript } from "./log.js";

/** Delivery facts belong to the input; current ownership only qualifies unfinished work. */
export function nativeInputViews(
  state: ChannelState,
  transcript: Transcript,
  connection: ConnectionStatus,
): readonly NativeInputDelivery[] {
  if (!requiresNativeConnection(state)) return [];
  const offers = new Map(
    Object.values(state.connection?.offers ?? {}).map((entry) => [entry.offer.inputId, entry]),
  );
  const responding = connection.state === "not-listening" && connection.reason === null;
  let outcomes: ReadonlyMap<string, NativeOutcome> | undefined;
  const outcomeFor = (turnId: string): NativeOutcome | null => {
    outcomes ??= transcriptOutcomes(transcript);
    return outcomes.get(turnId) ?? null;
  };
  const uncertainInputs = new Set(state.nativePublication?.legacyDelivery.uncertainInputs);
  return transcript.inputs.map((input): NativeInputDelivery => {
    const offer = offers.get(input.id);
    if (offer?.kind === "finished")
      return {
        inputId: input.id,
        message: offer.outcome.text,
        outcome: offer.outcome,
        state: "finished",
      };
    if (Object.hasOwn(state.connection?.cancelledInputs ?? {}, input.id))
      return {
        inputId: input.id,
        message: "Cancelled before it was sent. The message remains in this conversation.",
        outcome: null,
        state: "cancelled",
      };
    if (offer?.kind === "sending")
      return {
        inputId: input.id,
        message: responding
          ? "Waiting for the interactive session to confirm receipt."
          : "Receipt was not confirmed. This message will not be sent again automatically.",
        outcome: null,
        state: responding ? "sending" : "delivery-uncertain",
      };
    if (offer?.kind === "received")
      return {
        inputId: input.id,
        message: responding
          ? "The session confirmed receipt. Waiting for its response."
          : "The session confirmed receipt, but its response outcome is unknown. This message will not be sent again automatically.",
        outcome: null,
        state: "received",
      };
    const execution = state.executions[input.id];
    if (execution?.kind === "attempt-started" || execution?.kind === "attempt-ended") {
      const start = execution.kind === "attempt-started" ? execution : execution.start;
      if (execution.kind === "attempt-ended" && execution.outcome.kind === "pre-start-failed") {
        const failure = execution.outcome.failure;
        return {
          inputId: input.id,
          message: failure.reason,
          outcome: {
            kind: failure.evidence === "harness-refusal" ? "refusal" : "failure",
            text: failure.reason,
          },
          state: "not-started",
        };
      }
      if (state.completedTurns[start.turnId] !== undefined) {
        const outcome = outcomeFor(start.turnId);
        return {
          inputId: input.id,
          message:
            outcome?.text ??
            "The session recorded a clean end to the response, but no reply was recorded.",
          outcome,
          state: "finished",
        };
      }
      if (execution.kind === "attempt-ended" && execution.outcome.kind === "failed-after-start") {
        const recorded = outcomeFor(start.turnId);
        const outcome: NativeOutcome =
          recorded?.kind === "failure" || recorded?.kind === "refusal"
            ? recorded
            : { kind: "failure", text: execution.outcome.failure.reason };
        return { inputId: input.id, message: outcome.text, outcome, state: "finished" };
      }
      const received = Object.hasOwn(state.appliedInputs, input.id);
      const active =
        connection.state === "headless-starting" || connection.state === "headless-running";
      return {
        inputId: input.id,
        message: received
          ? active
            ? "The session confirmed receipt. Waiting for its response."
            : "The session confirmed receipt, but its response outcome is unknown. This message will not be sent again automatically."
          : active
            ? "Preparing or sending this message to the same native session. Receipt is not confirmed."
            : "Receipt was not confirmed. This message will not be sent again automatically.",
        outcome: null,
        state: received ? "received" : active ? "sending" : "delivery-uncertain",
      };
    }
    if (input.status === "applied")
      return {
        inputId: input.id,
        message:
          "Receipt is recorded. A response outcome correlated to this earlier message is not available.",
        outcome: null,
        state: "received",
      };
    if (uncertainInputs.has(input.id))
      return {
        inputId: input.id,
        message:
          "This earlier message has no confirmed receipt. It will not be sent again automatically.",
        outcome: null,
        state: "delivery-uncertain",
      };
    return {
      inputId: input.id,
      message:
        state.connection?.heldInputs[input.id]?.message ??
        (execution?.kind === "held"
          ? compatibilityText(execution.hold.reason)
          : "Saved in this conversation. Waiting to send to the native session."),
      outcome: null,
      state: "saved",
    };
  });
}

function transcriptOutcomes(transcript: Transcript): ReadonlyMap<string, NativeOutcome> {
  const outcomes = new Map<string, NativeOutcome>();
  for (const { event, turnId } of transcript.events) {
    if (event.kind === EventKind.question && typeof event.question === "string")
      outcomes.set(turnId, { kind: "question", text: event.question });
    else if (
      event.kind === EventKind.message &&
      event.role === "assistant" &&
      typeof event.text === "string"
    )
      outcomes.set(turnId, { kind: "answer", text: event.text });
    else if (
      (event.kind === EventKind.failure ||
        event.kind === EventKind.error ||
        event.kind === EventKind.limit) &&
      typeof event.message === "string"
    )
      outcomes.set(turnId, {
        kind: event.class === "refusal" ? "refusal" : "failure",
        text: event.message,
      });
  }
  return outcomes;
}

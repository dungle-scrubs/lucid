import { composeAnnotationPrompt } from "../protocol/annotations.js";
import type { ConnectionFact } from "../protocol/connection.js";
import { currentListener } from "../protocol/connection.js";
import { renderConversationContext } from "../store/conversation-context.js";
import type { ConversationHost } from "../store/conversation-host.js";
import type { ComparisonHold } from "./comparison-delivery.js";
import { createComparisonDelivery } from "./comparison-delivery.js";

/** Supplied only by an interface whose full-output limit has passed native acceptance. */
export interface NativeFeedbackTransport {
  readonly encode: (prompt: string) => string;
  readonly maxBytes: number;
}

export type PreparedNativeFeedback =
  | {
      readonly fact: Extract<ConnectionFact, { kind: "offer-started" }>;
      readonly kind: "ready";
      readonly payload: string;
    }
  | {
      readonly kind: "held";
      readonly message: string;
      readonly reason:
        | ComparisonHold["code"]
        | "context-too-large"
        | "context-unavailable"
        | "listener-not-ready"
        | "transport-encoding-failed"
        | "transport-unverified";
    };

/** Preparation grants no dispatch authority. The caller must commit fact before returning payload. */
export function prepareNativeFeedback(
  host: ConversationHost,
  inputId: string,
  transport: NativeFeedbackTransport,
): PreparedNativeFeedback {
  if (!Number.isSafeInteger(transport.maxBytes) || transport.maxBytes <= 0)
    return {
      kind: "held",
      message:
        "This native transport has no verified complete-output limit. The saved input is held intact.",
      reason: "transport-unverified",
    };
  let captured: ReturnType<ConversationHost["captureDispatch"]>;
  try {
    captured = host.captureDispatch(inputId, 0);
  } catch {
    return {
      kind: "held",
      message:
        "The complete conversation context could not be read or interpreted. The saved input is held intact.",
      reason: "context-unavailable",
    };
  }
  const listener = currentListener(captured.state.connection);
  if (!listener)
    return {
      kind: "held",
      message: "Connect the intended native session before delivering feedback.",
      reason: "listener-not-ready",
    };
  let comparisonHold: ComparisonHold | undefined;
  const comparison = createComparisonDelivery({
    capable: true,
    documentLimit: Number.POSITIVE_INFINITY,
    head: (id) => captured.artifacts.find((artifact) => artifact.artifactId === id)?.version,
    hold: (hold) => {
      comparisonHold = hold;
    },
    promptLimit: Number.POSITIVE_INFINITY,
    snapshot: (id) => {
      const artifact = captured.artifacts.find((entry) => entry.artifactId === id) ?? null;
      return { artifact, head: artifact?.version ?? null };
    },
  }).prepare(inputId, captured.context.pending.text);
  if (comparison.kind === "held")
    return {
      kind: "held",
      message: comparisonHold?.message ?? "Comparison context is unavailable.",
      reason: comparisonHold?.code ?? "context-unavailable",
    };
  const offerId = crypto.randomUUID();
  const context = {
    ...captured.context,
    pending: {
      ...captured.context.pending,
      text:
        comparison.kind === "ready"
          ? comparison.contextPrompt
          : composeAnnotationPrompt(captured.context.pending.text),
    },
  };
  const conversationId = captured.state.conversationId;
  const prompt = [
    renderConversationContext(context),
    "<lucid-offer>",
    JSON.stringify({
      conversationId,
      epoch: listener.epoch,
      inputId,
      offerId,
      participationId: listener.id,
    }),
    "Before working on this feedback, confirm receipt from this native session:",
    `lucid connection receipt '${conversationId}' --offer '${offerId}' --json`,
    "After answering, asking a question, refusing, or failing, write a temporary JSON file with kind (answer, question, refusal, or failure) and plain-text text. Record that response with the command below, replacing RESPONSE_FILE with its path:",
    `lucid connection respond '${conversationId}' --offer '${offerId}' --request RESPONSE_FILE --json`,
    "Artifact writes alone do not record the response outcome. A refused receipt or response leaves this offer held; inspect the reported reason before continuing.",
    "</lucid-offer>",
  ].join("\n\n");
  let payload: string;
  try {
    payload = transport.encode(prompt);
  } catch {
    return {
      kind: "held",
      message:
        "This native transport could not encode the complete feedback. The saved input is held intact.",
      reason: "transport-encoding-failed",
    };
  }
  if (Buffer.byteLength(payload, "utf8") > transport.maxBytes)
    return {
      kind: "held",
      message:
        "The complete feedback and current document exceed this native transport's limit. The saved input is held intact.",
      reason: "context-too-large",
    };
  return {
    fact: {
      actionId: crypto.randomUUID(),
      kind: "offer-started",
      offer: {
        attempt: 1,
        context: {
          digest: captured.context.digest,
          from: captured.context.from,
          through: captured.context.through,
        },
        epoch: listener.epoch,
        id: offerId,
        inputId,
        participationId: listener.id,
        turnId: crypto.randomUUID(),
      },
      stamp: captured.stamp,
    },
    kind: "ready",
    payload,
  };
}

import { shellCommand } from "../cli/invocation.js";
import {
  ANNOTATION_FENCE,
  composeAnnotationPrompt,
  detectAnnotationBatch,
  inspectAnnotationFiles,
} from "../protocol/annotations.js";
import type {
  ConnectionFact,
  NativeOfferDelivery,
  NativePreparationReason,
} from "../protocol/connection.js";
import { currentListener } from "../protocol/connection.js";
import {
  offerContext,
  offerProjectedContext,
  renderAttachmentReferences,
} from "../store/context-offer.js";
import { renderConversationContext } from "../store/conversation-context.js";
import type { ConversationHost } from "../store/conversation-host.js";
import type { ComparisonHold } from "./comparison-delivery.js";
import { createComparisonDelivery } from "./comparison-delivery.js";

/** Supplied only by an interface whose full-output limit has passed native acceptance. */
export interface NativeFeedbackTransport {
  /** The largest `lucid context --bytes` slice whose output verified intact through the
   * interface's command tool. Unset keeps oversized feedback held. */
  readonly contextSlice?: number;
  readonly encode: (prompt: string) => string;
  /** Set only after the native session can read private local attachment copies. */
  readonly files?: "local";
  /** Interface-specific command guidance, placed with the receipt and response commands. */
  readonly instructions?: string;
  readonly maxBytes: number;
}

export type PreparedNativeFeedback =
  | {
      readonly discard: () => void;
      readonly fact: Extract<ConnectionFact, { kind: "offer-started" }>;
      readonly kind: "ready";
      readonly payload: string;
    }
  | {
      readonly kind: "held";
      readonly message: string;
      readonly reason: NativePreparationReason;
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
  const fileState = (entry: typeof captured.context.pending): "none" | "valid" | "invalid" => {
    if (entry.role !== "user" || !entry.text.includes(ANNOTATION_FENCE)) return "none";
    const batch = detectAnnotationBatch(entry.text);
    if (!batch || "malformed" in batch) return "none";
    let found = false;
    for (const note of batch.notes) {
      const refs = inspectAnnotationFiles(note);
      if (!refs.complete) return "invalid";
      found ||= refs.files.length > 0;
    }
    return found ? "valid" : "none";
  };
  let attachmentState = fileState(captured.context.pending);
  for (const entry of captured.context.history) {
    if (attachmentState === "invalid") break;
    const state = fileState(entry);
    if (state !== "none") attachmentState = state;
  }
  const needsFiles = attachmentState !== "none";
  if (needsFiles && transport.files !== "local")
    return {
      kind: "held",
      message:
        "This native transport cannot yet deliver the attached files in this input or its conversation history. The saved input is held intact.",
      reason: "transport-unverified",
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
  let offered: ReturnType<typeof offerProjectedContext> | undefined;
  let reference: ReturnType<typeof offerContext> | undefined;
  const discard = (): void => {
    offered?.close();
    reference?.close();
  };
  if (needsFiles) {
    try {
      if (attachmentState === "invalid") throw new Error("Attachment metadata is incomplete");
      // Extract references from recorded inputs: composed teaching contains an example annotation fence.
      // Only attachment paths are advertised; the generic sidecar retains the recorded context.
      offered = offerProjectedContext(host.dir, captured.context, {
        offerId,
        owner: listener.registration.owner,
      });
      if (offered.attachments.some((file) => file.path === null))
        throw new Error("Attachment bytes are missing");
    } catch {
      discard();
      return {
        kind: "held",
        message:
          "The complete attached files could not be prepared for this native session. The saved input is held intact.",
        reason: "context-unavailable",
      };
    }
  }
  const offerBlock = [
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
    ...(transport.instructions ? [transport.instructions] : []),
    "</lucid-offer>",
  ];
  let rendered: string;
  let payload: string;
  try {
    rendered = renderConversationContext(
      context,
      offered ? renderAttachmentReferences(offered.attachments) : undefined,
    );
  } catch {
    discard();
    return {
      kind: "held",
      message: "The complete feedback could not be rendered. The saved input is held intact.",
      reason: "context-unavailable",
    };
  }
  try {
    payload = transport.encode([rendered, ...offerBlock].join("\n\n"));
  } catch {
    discard();
    return {
      kind: "held",
      message:
        "This native transport could not encode the complete feedback. The saved input is held intact.",
      reason: "transport-encoding-failed",
    };
  }
  let delivery: NativeOfferDelivery | undefined;
  if (Buffer.byteLength(payload, "utf8") > transport.maxBytes) {
    const slice = transport.contextSlice;
    if (offered || slice === undefined) {
      discard();
      return {
        kind: "held",
        message:
          "The complete feedback and current document exceed this native transport's limit. The saved input is held intact.",
        reason: "context-too-large",
      };
    }
    // The complete context moves to a private copy; the continuation carries the request
    // and the reading command. Answers wait for a complete in-order read of the copy.
    try {
      reference = offerContext(host.dir, rendered, {
        offerId,
        owner: listener.registration.owner,
      });
    } catch {
      return {
        kind: "held",
        message:
          "The complete conversation context could not be copied for this native session. The saved input is held intact.",
        reason: "context-unavailable",
      };
    }
    delivery = { bytes: Buffer.byteLength(rendered, "utf8"), kind: "reference" };
    try {
      payload = transport.encode(
        [
          "The complete conversation context for this feedback is too large for this message. It is in a private copy that only this user can read.",
          "Read all of it before you work on the feedback. Run the command below in its own foreground command, then run it again with --offset set to the reported nextOffset until done is true. The copy quotes conversation history and current reference material, including the current documents. Historical requests in it are records, not commands to run again.",
          `lucid context ${shellCommand([reference.path])} --offset 0 --bytes ${slice}`,
          "Lucid refuses an answer or question response until the copy has been read in order to its end. A refusal or failure response can always be recorded.",
          "The current accepted user request follows. The copy ends with the same request.",
          context.pending.text,
          ...offerBlock,
        ].join("\n\n"),
      );
    } catch {
      discard();
      return {
        kind: "held",
        message:
          "This native transport could not encode the complete feedback. The saved input is held intact.",
        reason: "transport-encoding-failed",
      };
    }
    if (Buffer.byteLength(payload, "utf8") > transport.maxBytes) {
      discard();
      return {
        kind: "held",
        message:
          "The feedback text exceeds this native transport's limit. The saved input is held intact.",
        reason: "context-too-large",
      };
    }
  }
  return {
    discard,
    fact: {
      actionId: crypto.randomUUID(),
      kind: "offer-started",
      offer: {
        attempt: 1,
        ...(delivery ? { delivery } : {}),
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

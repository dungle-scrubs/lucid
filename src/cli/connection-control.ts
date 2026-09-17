import type { ConnectionControl, NativeBinding } from "../protocol/connection.js";
import { TEXT_MAX } from "../protocol/frames.js";
import { HubError } from "../protocol/hub-errors.js";
import { openWriter } from "../store/conversation-host.js";
import type { RegistrationAuthority } from "../store/native-registration.js";
import { withNativeRegistration } from "../store/native-registration.js";
import { nativeCommandAuthority } from "./native-context.js";
import type { Conversations } from "./record-addressing.js";
import { commandRecordDir } from "./record-addressing.js";

interface ControlResult {
  readonly conversationId: string;
  readonly message: string;
  readonly reason: string | null;
  readonly verdict: "accepted" | "refused";
}

export type ConnectionControlResult = ControlResult &
  ({ readonly inputId: string } | { readonly offerId: string });

type ControlOutcome =
  | { readonly reason: null; readonly verdict: "accepted" }
  | { readonly reason: string; readonly verdict: "refused" };

export async function readResponseRequest(path: string): Promise<unknown> {
  // Four UTF-8 bytes per event character bounds allocation before JSON decoding.
  const limit = TEXT_MAX * 4;
  let bytes: ArrayBuffer;
  try {
    bytes = await Bun.file(path)
      .slice(0, limit + 1)
      .arrayBuffer();
  } catch {
    throw new HubError("The response request file is missing or unreadable.", "E-HUB-03", 400, []);
  }
  if (bytes.byteLength > limit)
    throw new HubError(
      "The response request exceeds the supported size. Keep it as one response within the event limit.",
      "E-HUB-03",
      400,
      [],
    );
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HubError("The response request must contain valid UTF-8 JSON.", "E-HUB-03", 400, []);
  }
}

function refusalMessage(reason: string): string {
  switch (reason) {
    case "input-already-dispatched":
      return "Feedback has already started dispatching. It cannot be cancelled through this control.";
    case "execution-ineligible":
      return "No unsent feedback matches this input.";
    case "receipt-required":
      return "Confirm receipt of this offer before recording its response.";
    case "receipt-stale":
      return "This offer does not match the current native participation. Check the offer and connection status.";
    case "connection-unverified":
      return "Run this command from the native session that received the offer. Its registration and process must be verified.";
    case "connection-conflict":
      return "This command conflicts with a recorded result. The recorded receipt or response was kept.";
    case "context-unread":
      return "Read the offered context in order to its end with the lucid context command before recording an answer or question. Follow nextOffset until done is true.";
    case "context-missing":
      return "The offered context copy is no longer available. Record a failure response; the person can send the feedback again.";
    case "invalid-connection":
      return "The offer reference or response is invalid or exceeds the event limit.";
    default:
      return "The connection control was refused. Check connection status before retrying.";
  }
}

/** Resolve native authority before entering the host's serialized control transaction. */
export function runConnectionControl(
  records: Conversations,
  conversationId: string,
  control: ConnectionControl,
  authority: RegistrationAuthority = nativeCommandAuthority(),
): ConnectionControlResult {
  const dir = commandRecordDir(records, conversationId);
  const write = (registration?: NativeBinding): ControlOutcome => {
    const host = openWriter(dir, {
      connectionAuthority: () =>
        registration && authority.callerOwns(registration) === true ? registration : undefined,
      ownerPresence: authority.ownerPresence,
    });
    try {
      const result = host.controlConnection(control);
      return result.verdict === "accepted"
        ? { verdict: "accepted", reason: null }
        : { verdict: "refused", reason: result.issue };
    } finally {
      host.close();
    }
  };
  const result =
    control.kind === "cancel-input"
      ? { ok: true as const, value: write() }
      : withNativeRegistration(records.rootDir, undefined, write, authority);
  const outcome = result.ok ? result.value : { verdict: "refused" as const, reason: result.reason };
  let message: string;
  if (!result.ok) message = result.message;
  else if (outcome.verdict === "refused")
    message = refusalMessage(outcome.reason ?? "connection-unverified");
  else if (control.kind === "cancel-input") message = "Unsent feedback cancelled.";
  else message = control.kind === "receipt" ? "Feedback receipt recorded." : "Response recorded.";
  return {
    conversationId,
    message,
    ...(control.kind === "cancel-input"
      ? { inputId: control.inputId }
      : { offerId: control.offerId }),
    reason: outcome.reason,
    verdict: outcome.verdict,
  };
}

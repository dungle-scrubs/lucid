import type { ConnectionControl, NativeBinding } from "../../protocol/connection.js";
import type { NativeOperation } from "../../store/native-proposals.js";
import type { RegistrationAuthority } from "../../store/native-registration.js";
import { connectPublication } from "../artifact-publish.js";
import { runConnectionControl } from "../connection-control.js";
import { requestNativeListening } from "../native-listening.js";
import type { Conversations } from "../record-addressing.js";

/** Commit one proposed operation through the host operations every native
 * lifecycle callback shares (RFC 28 step 3: Pi commits through the same
 * operations the Claude PostToolUse hook uses). */
export function commitOperation(
  records: Conversations,
  operation: NativeOperation,
  registration: NativeBinding,
  authority: RegistrationAuthority,
): string {
  const { conversationId } = operation;
  switch (operation.kind) {
    case "bind": {
      const status = connectPublication(
        records,
        conversationId,
        registration.registrationId,
        authority,
      );
      return `Connection for ${conversationId}: ${status.state}. ${status.message}`;
    }
    case "listen":
      return `Listening for ${conversationId}: ${requestNativeListening(records, conversationId, authority).message}`;
    case "receipt":
    case "respond": {
      const control: ConnectionControl =
        operation.kind === "receipt"
          ? { kind: "receipt", offerId: operation.offerId }
          : { kind: "respond", offerId: operation.offerId, outcome: operation.outcome };
      const result = runConnectionControl(records, conversationId, control, authority);
      return `${operation.kind === "receipt" ? "Receipt" : "Response"} for offer ${operation.offerId}: ${result.verdict}. ${result.message}`;
    }
  }
}

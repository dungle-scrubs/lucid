import { listeningCommand, lucidCommand } from "../cli/invocation.js";
import type {
  BrowserConnection,
  ConnectionInstruction,
  ConnectionProjection,
} from "../protocol/connection-status.js";

/** Commands name the serving executable and record root, never a browser-supplied path. */
export function connectionControls(
  connection: ConnectionProjection,
  root: string,
): BrowserConnection {
  return {
    ...connection,
    instructions: connection.actions.flatMap((action): readonly ConnectionInstruction[] => {
      switch (action) {
        case "resume-listening-instructions":
          return [
            {
              action,
              command: listeningCommand(root, connection.conversationId),
              label: "Resume listening instructions",
              text: "Tell the already-open native session to run this command once, then finish its turn so its Stop hook can listen. A requested result is not yet a listening connection. Report a held result without retrying.",
            },
          ];
        case "reconnect-instructions":
          return [
            {
              action,
              command: lucidCommand(root, ["reconnect", connection.conversationId]),
              label: "Reconnect in a terminal",
              text: "Run this command in a terminal pane. It rechecks ownership, waits for the current response and process cleanup, then opens the same native session there. Ctrl+C in that pane cancels a wait before launch. It does not cancel the current response or saved feedback.",
            },
          ];
        case "setup-instructions":
          return [
            {
              action,
              command: lucidCommand(root, ["connection", "setup", "--help"]),
              label: "Connection setup instructions",
              text: "Read the retained reason above. Review the Codex hooks configuration source and trusted Lucid hooks. This help command makes no changes. Repair does not retry the held request or prove that a session is listening.",
            },
          ];
        default:
          return [];
      }
    }),
  };
}

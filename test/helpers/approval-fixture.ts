import type { ApprovalAttempt, ApprovalRequest } from "../../src/protocol/native-approvals.js";
import type { ConversationHost } from "../../src/store/conversation-host.js";

/** Synthetic native data. No native process or captured transcript is used. */
export function seedApprovalAttempt(
  host: ConversationHost,
  secret: string,
): {
  readonly attempt: ApprovalAttempt;
  readonly request: ApprovalRequest;
} {
  const accepted = (result: { readonly verdict: string }, step: string): void => {
    if (result.verdict !== "accepted") throw new Error(`Approval fixture refused ${step}`);
  };
  accepted(
    host.acceptInput({ id: "input", mode: "queue", text: "Fixture prompt" }, { managed: true }),
    "input",
  );
  accepted(
    host.handleFrame(
      JSON.stringify({
        kind: "attach",
        conversationId: "approval",
        secret,
        version: 1,
        harness: "codex",
        profile: "headless-turn",
        capabilities: ["managed-input-v1"],
        attachmentOrigin: "automatic",
      }),
    ),
    "attachment",
  );
  const attempt = { attempt: 1, epoch: 1, inputId: "input", turnId: "lucid-turn" };
  accepted(
    host.writeExecution({
      ...attempt,
      kind: "attempt-started",
      driver: { harness: "codex", model: "fixture", effort: "high", profile: "headless-turn" },
      native: { kind: "resume", sessionId: "native-session" },
      context: { digest: "a".repeat(64), from: 0, through: 1 },
    }),
    "attempt",
  );
  return {
    attempt,
    request: {
      v: 1,
      kind: "approval-request",
      requestId: "207feafe-e82b-4df4-91ba-4f1aeb987508",
      sessionId: "native-session",
      turnId: "native-turn",
      category: "command",
      details: "Command: echo <script>fixture</script>\nWorking folder: /fixture",
      choices: [{ id: "once", label: "Approve once", scope: "once" }],
    },
  };
}

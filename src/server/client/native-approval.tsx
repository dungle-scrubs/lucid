import { useMutation } from "@tanstack/react-query";
import * as React from "react";
import type {
  ApprovalChoice,
  ApprovalDecision,
  ApprovalState,
} from "../../protocol/native-approvals.js";
import { Button } from "./ui/button.js";

const scopeHelp: Record<ApprovalChoice["scope"], string> = {
  cancel: "Stops this response.",
  deny: "Does not grant the requested permission.",
  once: "Applies to this request only.",
  persistent: "The agent saves the rule described above for future use.",
  session: "Applies within this agent session. The exact scope is shown above.",
  turn: "Applies to this response only.",
};

function approvalStatus(entry: ApprovalState): string {
  if (entry.status === "pending") return "The agent is waiting for your choice.";
  if (entry.status === "decided") return "Your choice was saved. It has not been sent yet.";
  if (entry.status === "sending")
    return "Your choice is being sent. Delivery is not yet confirmed.";
  if (entry.status === "sent") return "Answer sent. Subsequent agent output shows what happened.";
  if (entry.decision?.status === "rejected")
    return "The agent connection refused this answer. It cannot be sent again for this request.";
  if (entry.status === "cleared") return "This request is no longer waiting for an answer.";
  if (entry.reason === "process-unverified")
    return "Lucid cannot verify the waiting process. Choices are unavailable until its status can be confirmed.";
  if (entry.decision?.status === "sending")
    return "Your choice may have reached the session. Delivery is unknown. It will not be sent again.";
  if (entry.decision?.status === "sent")
    return "Answer sent. The session stopped before a result was confirmed.";
  if (entry.decision?.status === "decided")
    return "Your choice was saved but was not sent. The session stopped.";
  return "The waiting process is no longer available. This request cannot be answered.";
}

interface NativeApprovalProps {
  readonly disabled: boolean;
  readonly entry: ApprovalState;
  readonly send: (decision: ApprovalDecision) => Promise<string | null>;
}

/** Only an explicit click saves a choice. Polling and remounting perform no mutation. */
export function NativeApproval(props: NativeApprovalProps) {
  const { disabled, entry, send } = props;
  const descriptionId = React.useId();
  const selected = React.useRef<ApprovalDecision | null>(null);
  const mutation = useMutation({ mutationFn: send, retry: false });
  const choose = (choiceId: string): void => {
    if (disabled || entry.status !== "pending" || mutation.isPending) return;
    if (selected.current !== null && selected.current.choiceId !== choiceId) return;
    const decision = selected.current ?? {
      choiceId,
      id: crypto.randomUUID(),
      requestId: entry.request.requestId,
    };
    // The ref closes the same-event double-click window before React renders.
    if (selected.current !== null && !mutation.isError && !mutation.data) return;
    selected.current = decision;
    mutation.mutate(decision);
  };
  const choice = entry.decision
    ? entry.request.choices.find((item) => item.id === entry.decision?.choiceId)
    : null;
  const problem = mutation.isError
    ? "Lucid could not confirm that your choice was saved. Check the same choice below; this does not repeat an answer to the agent."
    : mutation.data;
  const awaitingPoll = mutation.isSuccess && mutation.data === null && entry.status === "pending";
  return (
    <section
      aria-label="Agent permission request"
      className="card input-recovery min-w-0"
      data-approval-state={entry.status}
    >
      <h3 className="card-title text-balance">
        {
          {
            command: "Allow this command?",
            "file-change": "Allow these file changes?",
            permissions: "Grant these permissions?",
          }[entry.request.category]
        }
      </h3>
      <p className="card-body">
        Review the full request before choosing. Nothing is approved by default.
      </p>
      <pre
        className="card-body whitespace-pre-wrap [overflow-wrap:anywhere] font-mono"
        id={descriptionId}
      >
        {entry.request.details}
      </pre>
      {choice && <p className="card-body">You chose: {choice.label}</p>}
      <p className="card-body" role="status">
        {awaitingPoll
          ? "Your choice was saved. Waiting for the record to refresh."
          : approvalStatus(entry)}
      </p>
      {entry.decision?.status === "sent" && entry.status === "cleared" && (
        <p className="card-body">Answer sent. Check subsequent agent output for the result.</p>
      )}
      {entry.decision?.status === "sending" && entry.status === "cleared" && (
        <p className="card-body">
          Delivery of your choice was not confirmed. It will not be sent again.
        </p>
      )}
      {entry.status === "pending" && (
        <>
          {problem && (
            <p className="card-body" role="alert">
              {problem}
            </p>
          )}
          {disabled && <p className="card-body">Reload to reconnect before choosing.</p>}
          <div className="card-actions flex flex-col items-stretch gap-2">
            {entry.request.choices.map((item) => (
              <Button
                aria-describedby={descriptionId}
                className="h-auto! min-h-11 py-2! leading-normal! rounded-md!"
                disabled={
                  disabled ||
                  mutation.isPending ||
                  awaitingPoll ||
                  (selected.current !== null && selected.current.choiceId !== item.id)
                }
                key={item.id}
                onClick={() => choose(item.id)}
                variant="outline"
              >
                <span className="whitespace-normal [overflow-wrap:anywhere] text-left min-w-0 w-full">
                  <span className="block">
                    {mutation.isPending && selected.current?.choiceId === item.id
                      ? "Saving your choice…"
                      : problem && selected.current?.choiceId === item.id
                        ? `Check saved choice: ${item.label}`
                        : item.label}
                  </span>
                  <span className="block font-normal">{scopeHelp[item.scope]}</span>
                </span>
              </Button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

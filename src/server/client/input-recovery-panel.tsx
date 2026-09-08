import { useSyncExternalStore } from "react";
import { stripAnnotationBatch } from "../../protocol/annotations.js";
import type { InputRecovery, PendingInput } from "./input-recovery.js";
import { pendingInputText } from "./input-recovery.js";
import { Button } from "./ui/button.js";

export interface InputRecoveryPanelProps {
  readonly onReload: () => void;
  readonly onRestore: (request: PendingInput, error: string) => void;
  readonly recovery: InputRecovery;
}

/** An unresolved request stays separate from the editable note and retains
 * its exact submitted identity and body until reconciliation succeeds. */
export function InputRecoveryPanel(props: InputRecoveryPanelProps) {
  const { onReload, onRestore, recovery } = props;
  const state = useSyncExternalStore(
    recovery.subscribe,
    recovery.getSnapshot,
    recovery.getSnapshot,
  );
  if (state.kind === "idle") return null;
  const text =
    state.kind === "pending"
      ? pendingInputText(state.request)
      : state.kind === "settled"
        ? pendingInputText(state.outcome.request)
        : state.text;
  const outcome = state.kind === "settled" || state.kind === "storage-error" ? state.outcome : null;
  const message =
    state.kind === "pending"
      ? state.message
      : state.kind === "invalid"
        ? "This saved send cannot be recovered. Inspect the conversation before discarding it."
        : state.kind === "storage-error"
          ? outcome?.kind === "accepted"
            ? "Note sent. Browser recovery data could not be cleared."
            : outcome?.kind === "refused"
              ? `Not sent: ${outcome.error}. Browser recovery data could not be cleared.`
              : "Browser recovery storage is unavailable. No new note was sent."
          : state.outcome.kind === "accepted"
            ? "Note sent."
            : `Not sent: ${state.outcome.error}`;
  return (
    <section
      aria-label="Note send recovery"
      className="grid gap-3 rounded-md border border-[var(--color-divider)] p-3 text-[var(--color-text)]"
    >
      <p role="status" className="text-balance text-sm">
        {message}
      </p>
      {text !== "" && (
        <p className="whitespace-pre-wrap break-words text-sm">{stripAnnotationBatch(text)}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {state.kind === "pending" &&
          (state.phase === "reload" ? (
            <Button onClick={onReload}>Reload</Button>
          ) : (
            <Button
              disabled={state.phase === "sending"}
              onClick={() => {
                void recovery.retry();
              }}
            >
              Retry
            </Button>
          ))}
        {state.kind === "storage-error" && (
          <Button onClick={recovery.refreshStorage}>Retry storage</Button>
        )}
        {state.kind === "invalid" && (
          <>
            <p className="basis-full text-balance text-sm">
              Discarding recovery data does not cancel an accepted input or send a replacement note.
            </p>
            <Button onClick={recovery.discardInvalid}>Discard recovery data</Button>
          </>
        )}
        {state.kind === "settled" &&
          (state.outcome.kind === "accepted" ? (
            <Button onClick={recovery.dismiss}>Done</Button>
          ) : (
            <Button
              onClick={() => {
                if (state.outcome.kind !== "refused") return;
                onRestore(state.outcome.request, state.outcome.error);
                recovery.dismiss();
              }}
            >
              Return to note
            </Button>
          ))}
      </div>
    </section>
  );
}

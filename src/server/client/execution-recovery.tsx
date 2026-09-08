import { useRef, useState } from "react";
import type { ExecutionView } from "../../protocol/execution-view.js";
import { Button } from "./ui/button.js";

interface ExecutionRecoveryProps {
  readonly entry: ExecutionView;
  readonly disabled: boolean;
  readonly send: (inputId: string, body: string) => Promise<string | null>;
}

export function ExecutionRecovery(props: ExecutionRecoveryProps) {
  const { entry, disabled, send } = props;
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const pending = useRef(false);
  const requests = useRef(new Map<string, string>());
  const recover = async (action: "retry" | "continue-fresh"): Promise<void> => {
    if (pending.current || disabled) return;
    pending.current = true;
    setBusy(true);
    const body =
      requests.current.get(action) ??
      JSON.stringify({
        action,
        actionId: crypto.randomUUID(),
        expectedAttempt: entry.attempt,
        acknowledgeEffects: entry.acknowledgeEffects && acknowledged,
      });
    requests.current.set(action, body);
    try {
      setProblem(await send(entry.inputId, body));
    } catch {
      setProblem("Recovery was not confirmed. Use the same action to check it again.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  // Routine progress belongs to the single status above the composer.
  if (
    entry.status === "pending" ||
    entry.status === "starting" ||
    entry.status === "running" ||
    entry.status === "completed"
  )
    return null;
  const title = {
    held: "Prompt needs attention",
    failed: "Turn failed",
    uncertain: "Turn outcome is uncertain",
  }[entry.status];
  return (
    <section
      className="card input-recovery"
      aria-label={`Execution ${entry.inputId}`}
      aria-live="polite"
    >
      <div className="card-title text-balance">{title}</div>
      <p className="card-body">{entry.reason}</p>
      {entry.acknowledgeEffects && (
        <label className="card-body flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={busy || disabled}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          I understand that partial workspace effects may already exist.
        </label>
      )}
      {problem && (
        <p role="status" className="card-body">
          {problem}
        </p>
      )}
      <div className="card-actions flex flex-wrap gap-2">
        {entry.actions.map((action) => (
          <Button
            key={action}
            variant="outline"
            disabled={busy || disabled || (entry.acknowledgeEffects && !acknowledged)}
            onClick={() => void recover(action)}
          >
            {busy ? "Checking…" : action === "retry" ? "Retry" : "Continue in a new session"}
          </Button>
        ))}
      </div>
    </section>
  );
}

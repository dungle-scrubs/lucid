import { clampSnippet, stripAnnotationBatch } from "../../protocol/annotations.js";
import type { InputSubmissionState } from "./input-submission.js";
import { Button } from "./ui/button.js";

interface InputRecoveryProps {
  readonly busy: boolean;
  readonly dead: boolean;
  readonly onDiscard: () => void;
  readonly onRetry: () => void;
  readonly reason: string | null;
  readonly state: InputSubmissionState;
}

export function InputRecovery(props: InputRecoveryProps) {
  const { busy, dead, onDiscard, onRetry, reason, state } = props;
  if (state.status === "idle") return null;
  // Persisting a request before transport does not mean it needs recovery.
  // An explicit retry keeps its existing recovery card while checking.
  if (state.status === "unresolved" && busy && reason === null) return null;
  return (
    <section className="card input-recovery" aria-label="Saved send" aria-live="polite">
      <div className="card-title text-balance">
        {state.status === "invalid"
          ? "Saved send needs attention"
          : busy
            ? "Sending…"
            : "Send not confirmed"}
      </div>
      <p className="card-body">
        {state.status === "invalid"
          ? (reason ?? state.reason)
          : (reason ?? "Retry checks this same request. It does not add a second prompt.")}
      </p>
      {state.text === null ? null : (
        <pre className="input-recovery-text">{clampSnippet(stripAnnotationBatch(state.text))}</pre>
      )}
      <div className="card-actions">
        {state.status === "invalid" ? (
          <Button variant="outline" onClick={onDiscard} disabled={busy}>
            Discard local recovery data
          </Button>
        ) : (
          <Button className="primary" onClick={onRetry} disabled={busy || dead}>
            {busy ? "Checking…" : "Retry send"}
          </Button>
        )}
      </div>
      {state.status === "invalid" ? (
        <p className="card-body">
          Discarding local data does not cancel an input already accepted.
        </p>
      ) : null}
    </section>
  );
}

# A listener inside the originating session

Research for [Decide how artifact creation connects the originating session](https://github.com/dungle-scrubs/lucid/issues/257). Producer: the parent Codex session, 2026-09-11. This is planning evidence, not a shipped Lucid integration.

## Finding

**Observed:** a synchronous Stop hook can wait for external feedback and continue the same native conversation in both Muse's TUI and Codex's TUI. This path does not require an external sender to inject a new message into an idle session. Its user-visible cost is an active turn with a running hook while it waits. The user has been asked whether that behavior is acceptable; it is not yet an adopted connection contract.

The tests used a synthetic feedback file as the browser-side stand-in. They did not connect a Lucid record or browser. Muse used its echo provider. Codex used a deterministic response server bound to loopback, with the desktop application's bundled executable running as a terminal CLI. No reviewer model or Anthropic model was invoked.

## Native evidence

| Check | Observation | Standing and limit |
| --- | --- | --- |
| Muse SessionStart | Hook received native session ID and exact canonical working folder. Its parent PID was the owning Muse TUI. | **Observed**, Muse 1.1.1-R2514.1, own temporary workspace. This supplies registration inputs; it does not bind a Lucid record by itself. |
| Muse waiting hook | Stop remained running while a separate process wrote a synthetic feedback marker. Its JSON continuation result added that marker as runtime-hook developer context and caused another response in the same session. | **Observed** in native export. Echo repeated the original user prompt, so this proves context injection and continuation, not semantic handling of the feedback. |
| Muse interruption | Escape ended the waiting hook with status cancelled. The hook process exited; the TUI stayed open. A marker posted afterward was absent from native context. | **Observed** negative control. A production listener must revoke readiness and preserve undelivered work. A stale readiness file is insufficient. |
| Muse wait expiry | The probe's own 45-second wait expired and returned success with no feedback. The native turn completed; the TUI stayed open. | **Observed** application-level wait expiry, not a test of the harness killing a timed-out hook. No idle wakeup is implied after that point. |
| Codex hook trust | The native UI listed the two temporary project hooks as new. Each exact definition was reviewed and trusted through /hooks. | **Observed**, bundled codex-cli 0.153.4. No hook-trust bypass flag was used. Trust settings were written by the native UI for these temporary hooks. |
| Codex SessionStart | Hook received the native ID and canonical folder. Its parent PID was the exact Codex TUI process. | **Observed**. Later Stop callbacks carried the same ID and folder. This was a terminal session, not an existing desktop window. |
| Codex waiting hook | A separate process supplied a feedback marker. The next request to the local response stub contained it, and the next Stop event had stop_hook_active=true. | **Observed** native continuation on the same ID. The stub produced fixed replies; no model-recall or task-quality claim follows. |
| Existing Codex desktop app | No hook was installed into or exercised through an existing desktop conversation. | **Unverified**. Sharing its executable does not prove desktop trust UI, per-conversation client ownership, or end-to-end delivery there. |

Local ignored evidence lives under artifacts/evidence/interactive-artifact-wayfinder/: muse-listener-hook-events.ndjson, muse-listener-marker-events.json, muse-listener-export.json, muse-listener-interruption-proof.json, muse-listener-timeout-proof.json, codex-listener-proof.json, codex-listener-hook-events.ndjson, and codex-listener-requests.ndjson. The two *-listener-location.json files locate the exact throwaway scripts and configurations. The reusable minimal hook below captures the mechanism; it is not a durable queue implementation.

Both TUI processes and the local response server were stopped after verification. Native trust was accepted only for the agent-created temporary workspaces and the two specific Codex project hooks. No shared hook registration or production Lucid code was edited.

## Documentation and source disagreement

**Documented:** Codex hooks receive session_id and cwd. Synchronous Stop hooks can return decision=block and a continuation reason. The continuation acts as a new user prompt. Background hook completion does not start a new turn when the session is idle. Sources: [common hook input](https://learn.chatgpt.com/docs/hooks#common-input-fields), [Stop](https://learn.chatgpt.com/docs/hooks#stop), and [background hooks](https://learn.chatgpt.com/docs/hooks#run-hooks-in-the-background), retrieved 2026-09-11. Thus moving the wait into a Codex background hook does not preserve the same wakeup behavior.

**Documented and observed:** current Muse discovers project hooks in .muse/hooks.json at startup, after workspace trust. The tested nested hooks/event/handler configuration ran successfully. Source: [Muse extending, Hooks and Lifecycle events](https://dev.meta.ai/docs/muse-code/extending#hooks), current local cache read 2026-09-11, plus the installed TUI. The older local agents-setup reference describes a plugin-only mechanism based on a much older binary and marks it unconfirmed. That older description does not describe the installed behavior and was not used to configure this probe.

**Observed semantic difference:** Muse stored the Stop continuation as developer context and echoed the original prompt; Codex sent the reason in its next model request under the documented continuation semantics. A shared Lucid delivery adapter must preserve each harness's native framing and must not label hook output as an acknowledged user message merely because the hook exited successfully.

## Connection design constraints

These are consequences of the evidence, not new product decisions:

- Native identity, exact artifact-record binding, process ownership, and listener readiness need separate evidence. A hook supplies the native identity; artifact creation still needs an explicit binding to the returned Lucid conversation ID.
- A listener is ready only while its delivery path remains active and capable of returning feedback. A previously successful hook, saved interactive preference, live TUI PID, or stale marker file cannot prove readiness.
- Queue acceptance belongs to Lucid. Returning bytes through a hook and confirming that the native conversation consumed them are separate boundaries. Crashes between those boundaries require uncertain-delivery handling; this probe does not supply exactly-once delivery or cancellation after dispatch.
- A cooperative wait remains active until feedback, interruption, or its bound. It must stop advertising readiness when the native run stops waiting. Automatic re-entry after a completed answer, wait duration, cancellation, and busy-turn ordering remain to be specified.
- Neither interruption nor wait expiry proves interactive process exit. Both observed cases leave the TUI open and therefore cannot authorize headless takeover.
- No external desktop control endpoint is required for feedback returned through a hook that the desktop itself invokes. Whether the installed desktop exposes and runs that integration is still a separate acceptance check.

## Fit and remaining decision

The candidate serves the existing user: one person who opens an artifact from an interactive coding session and sends browser feedback back to that session. It serves Lucid's stated purpose of routing the live conversation into a durable record and back to its viewers. Scope direction: hold. It does not introduce a dashboard, another conversation, or a replacement session.

The unresolved product question is whether a visibly active waiting session is acceptable for Codex and Muse. Fully idle background wakeup is not established by these probes. The connection ticket remains open pending that answer and the remaining desktop validation; no interface was silently removed from scope.

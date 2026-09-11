# Connecting the session that creates an artifact

Draft for [Decide how artifact creation connects the originating session](https://github.com/dungle-scrubs/lucid/issues/257). This specifies proposed Lucid operations, not commands that already ship. User-approved behavior is recorded on the issue; this draft remains open while the installed Codex desktop path is checked.

## The operation

Artifact authoring performs one Lucid publication operation carrying the document, the intended existing record when revising, an idempotent creation identity when creating, and a reference to the originating session's registration. Lucid stores the artifact, binds the returned conversation ID to that registration, and returns the direct artifact URL plus the actual connection result. The authoring agent opens that URL and enters the listener through its installed integration. It does not change a browser mode preference to manufacture an attachment.

Publication and connection have separate outcomes. A valid document can be published and opened even when registration is missing or connection fails. Lucid retains accepted feedback and names the reason. The result never labels a disconnected artifact as ready to receive feedback. Retrying connection reuses that record; it does not repeat creation or allocate another conversation.

The operation uses Lucid's configured record root and existing local authorization boundary. Record credentials stay inside the Lucid process; model-visible registration references and conversation IDs do not replace authentication.

## Registration, binding, and readiness

| Fact | Required evidence | Failure behavior |
| --- | --- | --- |
| Native identity | The installed integration receives the native session ID from the harness lifecycle or session API. It records the harness and interface separately. | An ID guessed by the model, a folder match, or a session name alone cannot authorize resume. Publish disconnected if native identity is unavailable. |
| Working folder | Capture the native working-folder value and validate the folder used for continuation. Retain provenance needed to detect native path mismatches. | Preserve the input and report a folder problem. Do not override a native workspace refusal merely because two paths resolve to the same directory. |
| Interactive owner | Corroborate the native runtime process and its identity when registering, independently of the short-lived hook or listener process. | Unknown owner status stays unknown. Never treat loss of a hook as proof of native process exit. Desktop per-thread ownership remains a separate verification requirement. |
| Artifact record | Publication returns the authoritative conversation ID and binds it to the registration. Revisions and reconnects name that exact ID. | Reject conflicting identity or a missing record without creating a replacement. Never select the newest record in a shared working folder. |
| Ready to listen | A current integration participation is attached to that exact record and has an active path that can deliver feedback back into the native session. | A prior registration, live runtime PID, configured hook, saved preference, or expired participation cannot claim readiness. Keep undelivered input queued. |

Native identity is captured by the integration, not assembled by the authoring model. Registration alone holds no execution authority. Actual participation follows the existing executor lease and epoch checks. Binding an artifact does not itself consume a queued message or launch a headless process.

When a harness changes its current native session through new, resume, clear, fork, or equivalent behavior, its integration refreshes registration. It cannot silently carry an old record binding into a new native conversation. Reconnecting requires an explicit record reference and verified matching native identity; a cross-session or cross-harness transfer belongs to the ownership decision.

## Integration by interface

| Interface | Connection mechanism | Standing |
| --- | --- | --- |
| Codex CLI | Trusted lifecycle hooks supply identity. Artifact publication binds the record. A synchronous session-owned wait returns feedback as a native continuation. | Native SessionStart and Stop path observed with codex-cli 0.153.4 in the isolated terminal probe. The user accepts visibly active waiting. |
| Codex desktop | Use the desktop's own supported lifecycle integration and the same session-owned wait, without requiring Lucid to connect to a hidden app-server endpoint. | Official documentation includes lifecycle hooks in ChatGPT Work/Codex. Installation, trust, hook execution, and ownership evidence in the installed desktop still require confirmation. The CLI test is not that confirmation. |
| Muse CLI | Startup-loaded hooks supply identity and invoke a synchronous wait in the originating session. | Native hook identity, context injection, continuation, interruption, and wait expiry observed with Muse 1.1.1-R2514.1. The user accepts visibly active waiting. External session-message sender admission is not required for this path. |
| Pi CLI | An installed extension reads its current session identity and folder, binds the record, and submits accepted feedback through the current-session extension API. | Documented extension primitives. Complete Lucid extension delivery and acknowledgement still need implementation tests and a live confirmation. Do not substitute a new RPC runtime for the existing TUI. |
| Claude CLI | Installed lifecycle hooks supply identity and feed the originating session through the hook integration. | Documented hook primitives and existing Lucid hook code, with known managed-input delivery gaps. No Anthropic model run is required for this planning session. The remaining delivery decision selects the supported timing behavior. |

Every interface retains the same publication fallback. An unsupported or unverified attachment produces a specific disconnected result and queued feedback. It is not reported as supported merely because the harness has a similarly named API. Whether an interface can ship with that limitation requires an explicit product decision; this draft does not narrow the agreed five-interface scope.

## One-time setup and normal use

Setup installs only the integration for the selected harness through its supported hook or extension mechanism. It preserves existing registrations. Any required native trust review, restart, or reload is explained as part of setup. Setup verifies that the integration actually runs in the selected interface; file installation alone is insufficient. On this machine, permanent registrations belong in the existing shared hook and dotfiles arrangement; the research fixtures remain temporary.

After setup, the authoring skill uses the publication operation, keeps its returned record reference, opens the direct URL, and establishes listening automatically. After processing browser feedback it returns to listening while the interactive participation remains enabled. It does not require the user to switch Lucid modes. Active waiting can show the native session as running; the user has explicitly accepted this behavior for Codex and Muse.

The exact wait bound and re-entry behavior belong to the feedback-delivery decision. No repeated empty model turns should be used just to keep a listener marked alive. If the wait ends, the displayed state follows the actual loss of listening.

## Reconnect and failure actions

Reconnect is a Lucid operation invoked from the intended native session with the exact conversation ID. It verifies the record, current native identity, working folder, owner evidence, and execution ownership before starting a new listener participation. Repeating it for the same live participation is idempotent. A stale request cannot reclaim an epoch after ownership changed.

The browser supplies a copyable instruction containing the record reference and the supported reconnect operation for the selected interface. An operation that is not implemented or unavailable for that interface has no working-action label. A missing integration gets setup guidance; an open session with a stopped listener gets the accepted resume-listening instruction. A reason that cannot be repaired by reconnect remains visible.

Retry detection is read-only and cannot dispatch input. Retry connection cannot override a live executor or bypass identity checks. Retry resume is a separate operation after verified departure. Cancel send is available only when its durable delivery state can prove the message has not crossed dispatch; that implementation and its races belong to the delivery decision. No action assumes the interactive session is closed or silently creates a fresh native session.

## Responsibilities and remaining validation

Lucid owns the record, publication and binding, durable queue, exact-record reconnect, executor/epoch checks, and user-visible state. Its interactive integrations translate native lifecycle and delivery callbacks at the integration boundary. HCN owns headless invocation and harness operation results through the existing harness seam. This adds no coordinator daemon, alternate message store, or duplicated harness/model registry.

The delivery decision specifies ordering, context preparation, native acknowledgement, partial delivery, and listener loss. The ownership decision specifies confirmed exit, desktop client lifetimes, reopen races, and same-ID headless continuation. The interface prototype presents these states using the accepted explanations. Those responsibilities are not settled by a successful hook return.

Before this connection decision closes, the desktop result must identify the installed interface, prove or explicitly fail its setup/identity/listening path, and state any support limitation for a user decision. The full product will additionally require deterministic registration and reconnect scenarios plus separate live confirmations for each interface.

Evidence: [native listener tests](interactive-artifact-session-listener.md), [existing Lucid and HCN boundary](interactive-artifact-recovery.md), and the capability reports linked from the decision issue. [Official plugin support](https://learn.chatgpt.com/docs/plugins#use-plugins-from-a-supported-surface) documents hooks in the Codex runtime including ChatGPT Work; [hook semantics](https://learn.chatgpt.com/docs/hooks) owns their input and continuation contract. Both documentation sources were retrieved on 2026-09-11. On that date Computer Use refused access to the installed desktop app with the stated reason that it was not allowed for safety reasons. No alternate UI-control path was attempted.

# 03: Connect Codex CLI authors through bounded listening

Status: done
Blocked by: 01, 02

## What to build

Installed Codex CLI integration registers the current session, connects publication, and handles browser feedback in that native session.

## Acceptance criteria

- [x] Isolated native setup preserves other hooks and excludes subagents and managed headless children.
- [x] A 45-second synchronous wait performs no model calls while waiting; interruption or expiry disables listening until explicit resume-listen.
- [x] Native receipt and response commands preserve identity and full feedback context; output preview or spill cannot masquerade as full delivery.
- [x] Real native acceptance covers publication, feedback, cancellation, interruption and same-session identity.

## Native probe checkpoint - 2026-09-12

An isolated Codex CLI 0.154.0 session in Herdr passed a two-second Stop-hook continuation with local Qwen. One human prompt produced the initial reply and one automatic feedback reply. SessionStart and both Stop events carried the same native session ID and process ID. Hooks were reviewed and trusted through the native UI. Evidence is under the main checkout's ignored `artifacts/evidence/interactive-artifact-wayfinder/herdr-cli-check-result.md` and its JSON, event, and screen files.

This is a transport probe only. All acceptance criteria above remain open, including production Lucid delivery, the full listening interval, interruption, full-context limits, and provenance. It supplies no actual desktop evidence.

The follow-up native CLI probe used a local response stub. It observed a 45,009 ms synchronous wait with no intervening model request and exact delivery of 7,948 feedback bytes. A real native subagent emitted distinct SubagentStart/SubagentStop callbacks. Parent and child shared the native session ID and process, while tool processes had different native thread IDs. Evidence: `codex-contract-result.json` and associated metadata under the same ignored evidence directory. Cancellation, managed-child exclusion, and production integration still require acceptance.

The common registration authority now requires independent native-session proof in addition to process ancestry. Without an adapter verifier it refuses authority. The registry tests cover matching proof, different-thread refusal, missing proof and failed inspection. This checkpoint does not enable an adapter.

## Parent

RFC 26 and planning map https://github.com/dungle-scrubs/lucid/issues/253. Machine-made implementation slice under the approved autonomous continuation.

## Implementation checkpoint - ef363f5

Native Codex lifecycle capture, parent-thread command authority, managed-child role propagation, explicit feedback commands, and Stop continuation are committed. Four Muse review axes completed; applied fixes include current-participation matching after an explicit same-ID return, shared continuation/equality checks, source diagnostics and hook dispatch coverage. `bun run check`: 1,540 passing tests, no failures; `bun run build` passed.

The isolated native CLI lane published and bound an artifact, delivered complete feedback, and saved a receipt and outcome under session `01a09366-15ce-72c3-9bd7-e34321a78391`. The larger check delivered 4,981 feedback bytes in a 7,325-byte native tool result. The production Stop hook waited 44,999 ms from its durable enabled fact (45,000 ms configured) with no model requests during that interval, then saved expired. Evidence: `codex-production-delivery-result.json`, `codex-production-wait-result.json`, and related files under the main checkout's ignored evidence directory.

Native Escape killed the helper and a later Stop did not renew listening. A durable interrupted fact is still missing. Initial empty-queue listening must move completely through the synchronous Stop boundary so it cannot depend on a tool-output session surviving or repeated model polling. Exact-record selection and isolated setup remain incomplete. No acceptance box is closed by this checkpoint; no global integration is installed.

## Native interruption checkpoint

The verified native parent can now revoke its exact listener without acquiring the helper's executor lease. The host still refuses a different lifecycle, unknown ownership, or parent-issued expiry. The waiting helper observes durable revocation and releases its lease. Stop cannot renew interrupted listening.

Four Muse review axes reported no findings. The full check passed 1,541 tests with no failures; the binary build passed. An isolated native Codex CLI resume retained the same session ID after the previous process exited. Escape during the production Stop wait saved `interrupted`; a subsequent ordinary turn did not renew listening. The helper and resumed native process both exited. Evidence: `native-interrupt-review-*.json`, `native-interrupt-final-check.log`, `native-interrupt-build.log`, and `codex-native-interrupt-result.json` under the ignored evidence directory.

Initial empty-queue listening, exact-record selection, isolated setup, and remaining native acceptance still keep this ticket open. CLI evidence does not establish desktop support.

## Next slice: request listening at the native turn boundary

Machine-made implementation detail under RFC 26 sections 2, 5 and 9. Fit: holds scope for the person publishing and reviewing an artifact in an existing native conversation.

`resume-listen` verifies the exact bound conversation, records a private lifecycle-scoped selection hint and returns `requested`. The hint contains the conversation ID and one activation action ID. It grants no readiness or executor lease. The next Stop uses exact record lookup and the shared listener admission; its durable `listener-enabled` action consumes that activation. After an offer finishes, the current participation can continue normally. Expiry or interruption prevents later unrelated turns from renewing. Interrupt clears a pending request even if the listener has not started. Lifecycle refresh clears the hint.

The record remains authoritative. Missing or invalid hints select nothing; they never trigger a newest-record fallback. Explicit selection checks other records for unresolved delivery or active execution in the same native session. Each listener transaction verifies that its selection remains current under the registration-before-append lock order. A stale helper cannot dispatch after selection changes. Setup and the authoring instructions must request listening, finish the native turn, and explain the bounded wait.

Test seams and order:

1. Native registration operations preserve an exact selection only within its verified lifecycle, reject stale callers, and keep invalid hint data separate from valid receipt authority.
2. Native listener admission consumes one activation ID once; stale selection cannot start or dispatch work.
3. CLI request plus native Stop delivers complete feedback and starts an empty-queue wait without a long-running tool response. Existing receipt/outcome assertions move across that Stop boundary without weakening them.
4. Expiry, Interrupt before admission, Interrupt during waiting, repeated Stop, and lifecycle refresh do not renew automatically.
5. Exact selection ignores unrelated record histories at hook time, refuses conflicting binding, and cannot escape an unresolved offer by selecting another conversation.

## Listening request checkpoint

The slice above is implemented. The CLI returns `requested`; only native Stop starts the bounded wait. Exact selection, single activation, lifecycle refresh, pending and active interruption, unrelated unreadable histories, stale preparation, and cross-record unresolved work/owner checks are covered. Malformed hint data cannot authorize listening and does not invalidate receipt authority.

Four Muse review axes completed. Reuse fixes share target comparison, unsettled-work detection, and held results; the review disposition records why the remaining suggestions were skipped. The final check passed 1,549 tests with no failures; the binary build passed.

The isolated native Codex CLI run observed a 113 ms request round trip, a 45,002 ms initial wait with zero model requests, then complete delivery of 3,067 feedback bytes through Stop. The same native session recorded receipt and response. Escape recorded interruption, and a later ordinary turn did not renew. All helper processes and the native test process exited; test pane `w2M:pT` and the local response stub were closed. Evidence: `codex-listen-request-result.json`, its facts/events, `listen-request-review.md`, `listen-request-review-fixes.md`, and `listen-request-reviewed-check.log` under the main checkout's ignored evidence directory.

Isolated setup, authoring instructions, and remaining native cancellation acceptance keep the ticket open. Global installation, headless continuation, reconnect, other interfaces and desktop acceptance remain separate work.

## Setup and authoring slice

Machine-made detail under RFC 26 section 5; scope holds. `lucid connection setup --interface codex-cli --hooks-file FILE [--json]` targets an explicit configuration source. It merges SessionStart, Stop and Interrupt handlers, retains unrelated registrations, and refuses invalid or conflicting existing Lucid handlers. Repeating the same setup changes nothing. Hook commands preserve argv quoting and the configured Lucid record root. Setup reports installed configuration separately from native trust, lifecycle registration and listening readiness; it never starts a native process or grants hook trust.

Permanent configuration targets the user's managed source file, not a deployed symlink. Tests use isolated configuration. SessionStart and Stop retain 60-second deadlines; Interrupt uses 3 seconds. Stop labels its 45-second wait. After reviewing hooks through the native interface, a subsequent SessionStart registers the intended session. Authoring instructions retain the current record when registration is unavailable and keep the existing headless artifact protocol.

Tests attach to CLI dispatch through configuration persistence, then the native hook/authoring integration. Order: preserve unrelated hooks and repeat setup safely; refuse invalid, conflicting or symlink targets without replacement; verify literal command arguments and root selection; run the installed hooks in the isolated native CLI lane; verify cancellation before offer and authoring's exact-record failure behavior. Setup is not evidence that listening is ready.

## Setup checkpoint

Explicit setup and native authoring instructions are implemented. Seven setup tests cover preservation, idempotency, missing and malformed files, symlinks, conflicts, serialization, missing flag values, and literal shell argument/root round trips. Four Muse review axes completed; parser, documentation and verification findings were applied. The full check passed 1,556 tests with no failures.

The generated hooks ran in native Codex CLI 0.154.0 after trust and a later SessionStart. The native session published, cancelled an unsent input and requested listening. Its configured root contained spaces, single quotes and command-substitution syntax; the path remained literal despite a different inherited root, and an unrelated SessionStart hook ran. Evidence: `codex-setup-cancellation-reproduction.json`, `codex-setup-review.md`, `codex-setup-review-fixes.md` and `codex-setup-reviewed-check.log` under the ignored evidence directory.

That run exposed a remaining cancellation defect: the cancelled input was excluded from offers but its text appeared in the next offer's quoted history. The failed offer remains unresolved and will not be replayed. The native owner and helpers exited. Correct the shared context projection before repeating acceptance; cancellation must exclude the withdrawn content from later model context while keeping the durable transcript's cancellation record. This correction holds scope under the accepted cancellation contract and uses the existing host capture/native preparation seams. The ticket remains open.

## Cancellation correction checkpoint

The shared context projection now excludes cancelled input content and refuses a cancelled pending input. The durable transcript retains the cancelled input. A host/native-preparation regression reproduced the leak before the fix; the full check now passes 1,557 tests with no failures. Four Muse review axes completed, with the error-specific test assertion strengthened. The build passed.

A fresh native Codex CLI session used the generated hooks, cancelled the first saved input, and received the next 1,114 feedback bytes in full. The cancelled text was absent from its 3,398-byte context. The same session recorded receipt and response, then Escape saved interrupted; the next ordinary turn did not renew. The failed earlier offer was not replayed. All native/helper processes, pane `w2M:pV`, and the response stub exited. Evidence: `codex-setup-native-result.json`, `codex-setup-native-facts.json`, `cancelled-context-review.md`, and `cancelled-context-reviewed-check.log` under ignored evidence.

These production-adapter runs used a real native CLI with a local response stub. The earlier live-Qwen run established the small hook transport. A production-adapter run with live Qwen remains before closing this lane's live-model confirmation.

## Codex CLI lane complete

Live local Qwen `qwen3.6-35b-a3b-ud-mlx`, selected from mini's current model inventory, ran the production adapter through native Codex CLI with the generated hooks. It published the artifact, requested listening, received the saved feedback, confirmed receipt and recorded `QWEN_NATIVE_FEEDBACK_RECORDED` in the same native session. Escape revoked listening. The native owner and helpers exited, and test pane `w2M:pW` was closed. Evidence: `codex-qwen-production-result.json` and `codex-qwen-production-facts.json` under the ignored evidence directory. Together with the deterministic provenance/exclusion tests and the native subagent, bounded-wait, cancellation and interruption runs above, this closes ticket 03. It does not establish other native interfaces or desktop support, and the integration has not been installed globally.

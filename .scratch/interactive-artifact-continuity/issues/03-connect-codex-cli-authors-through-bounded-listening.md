# 03: Connect Codex CLI authors through bounded listening

Status: open
Blocked by: 01, 02

## What to build

Installed Codex CLI integration registers the current session, connects publication, and handles browser feedback in that native session.

## Acceptance criteria

- [ ] Isolated native setup preserves other hooks and excludes subagents and managed headless children.
- [x] A 45-second synchronous wait performs no model calls while waiting; interruption or expiry disables listening until explicit resume-listen.
- [x] Native receipt and response commands preserve identity and full feedback context; output preview or spill cannot masquerade as full delivery.
- [ ] Real native acceptance covers publication, feedback, cancellation, interruption and same-session identity.

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

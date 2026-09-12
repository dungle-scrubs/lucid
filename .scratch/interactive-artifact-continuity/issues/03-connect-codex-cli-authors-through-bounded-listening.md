# 03: Connect Codex CLI authors through bounded listening

Status: open
Blocked by: 01, 02

## What to build

Installed Codex CLI integration registers the current session, connects publication, and handles browser feedback in that native session.

## Acceptance criteria

- [ ] Isolated native setup preserves other hooks and excludes subagents and managed headless children.
- [ ] A 45-second synchronous wait performs no model calls while waiting; interruption or expiry disables listening until explicit resume-listen.
- [ ] Native receipt and response commands preserve identity and full feedback context; output preview or spill cannot masquerade as full delivery.
- [ ] Real native acceptance covers publication, feedback, cancellation, interruption and same-session identity.

## Native probe checkpoint - 2026-09-12

An isolated Codex CLI 0.154.0 session in Herdr passed a two-second Stop-hook continuation with local Qwen. One human prompt produced the initial reply and one automatic feedback reply. SessionStart and both Stop events carried the same native session ID and process ID. Hooks were reviewed and trusted through the native UI. Evidence is under the main checkout's ignored `artifacts/evidence/interactive-artifact-wayfinder/herdr-cli-check-result.md` and its JSON, event, and screen files.

This is a transport probe only. All acceptance criteria above remain open, including production Lucid delivery, the full listening interval, interruption, full-context limits, and provenance. It supplies no actual desktop evidence.

The follow-up native CLI probe used a local response stub. It observed a 45,009 ms synchronous wait with no intervening model request and exact delivery of 7,948 feedback bytes. A real native subagent emitted distinct SubagentStart/SubagentStop callbacks. Parent and child shared the native session ID and process, while tool processes had different native thread IDs. Evidence: `codex-contract-result.json` and associated metadata under the same ignored evidence directory. Cancellation, managed-child exclusion, and production integration still require acceptance.

The common registration authority now requires independent native-session proof in addition to process ancestry. Without an adapter verifier it refuses authority. The registry tests cover matching proof, different-thread refusal, missing proof and failed inspection. This checkpoint does not enable an adapter.

## Parent

RFC 26 and planning map https://github.com/dungle-scrubs/lucid/issues/253. Machine-made implementation slice under the approved autonomous continuation.

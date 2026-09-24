# Brief: code review of the RFC 32 T2 review-hold implementation

## Task
Review the implementation diff for correctness, protocol safety, and test strength. Report findings with file:line evidence. Read-only work; change no source, write no files.

## Scope
Repo /Users/kevin/dev/lucid, branch feat/rfc32-review-hold, exact commit a635fb5. Review ONLY these files from that commit (run `git show a635fb5 -- <file>` yourself):
- src/cli/detach.ts (new: hold-release writer)
- src/cli/managed-worker.ts (hold loop, holdActivity, detach handling)
- src/cli/mapping.ts, src/cli/dispatch.ts (detach hunks only)
- src/config/user-config.ts (hold_minutes)
- src/protocol/connection-status.ts, src/protocol/connection.ts (hold-released fact)
- src/protocol/reducer.ts (holdRelease + lastActivityAt)
- src/server/server.ts (holdMs threading hunk only)
- src/store/connection-view.ts (hold projection branches)
- src/store/conversation-host.ts (local-trust bypass hunks only)
- test/cli/review-hold.test.ts, test/config/user-config.test.ts (new tests)

Spec: /Users/kevin/dev/lucid/docs/rfc/32_any-session-handoff-to-lucid.rfc.md (Accepted, v2), Design 4-5, State Machine, Error Handling. Ticket: https://github.com/dungle-scrubs/lucid/issues/307 (read if reachable).

## Inputs (read these yourself)
- /Users/kevin/dev/lucid/AGENTS.md and CONTEXT.md
- The reducer and connection-fact machinery the code extends: src/protocol/connection.ts reduceConnection, src/store/conversation-host.ts evaluateConnection/writeConnection

## Requirements
1. Verify against the actual code: (a) every presence-acquire/release path in the worker loop; (b) the hold-released fact cannot be forged into a conflicting binding and needs no native authority without opening a bypass for other facts; (c) lastActivityAt advances only on accepted inputs and lossless events and is replay-deterministic; (d) the legacy idleMs worker path behaves exactly as before when holdMs is unset; (e) the projection branches cannot misreport a native-bound record as hold-connected.
2. Hunt: reducer state-shape changes that break replay of old logs (fold of a log written before these fields existed); action-id dedup gaps for hold-released across the three actions maps; the DETACHING abort path (does running.abort() send shutdown as the RFC requires?); config validation gaps.
3. Judge test strength against #307's acceptance criteria. Name untested criteria.
4. Grade each finding: hunch, observation, or demonstrated. Say which.
5. Return the findings list with file:line, what, why, grade, plus cleared and not-reviewed lists. Write no files.

## Output slot
Return the full review text. No file writes.

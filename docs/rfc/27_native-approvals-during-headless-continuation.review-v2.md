# RFC-27 v2 focused follow-up review

Named version: `docs/rfc/27_native-approvals-during-headless-continuation.rfc.md`, version 2, status Draft. Read whole v2 (202 lines), whole v1 review, all six allowed HCN sources, all three allowed evidence files. No edits, no shell, no network, no delegation.

Validator result (specified, not re-derived; shell disabled this run):

```
{"passed":true,"errors":[],"warnings":[]}
```

## Verdict on actionable F1-F12: all resolved as spec

F1 - fingerprint defined. V2 sec "Recorded settings authority" names the operation (`hcn inspect codex --native-settings --resume ID --cwd ABSOLUTE --json`), owner (HCN), typed snapshot plus 64-char lowercase SHA-256 fingerprint, hash-as-opaque-change-detector with retained snapshot for field comparison, algorithm owner files, and full input list. Confirmed in source (rung 2): `src/execution/native-settings.ts:127-142` hashes `[source, harness, sessionId, cwd, dev/ino/size/mtimeNs/ctimeNs, settingsOrdinal, model, effort, provider, permissions]` via sha256 hex; `src/knowledge/native-settings.ts:11` enforces `^[a-f0-9]{64}$`. Resolved.

F2 - authoritative settings channel. V2 passes fingerprint only, never caller-authored settings; HCN re-reads the native source, retains the matching snapshot, restores the supported triple through native resume parameters, and compares effective settings (exact thread ID, folder, model, effort, provider, approval policy, reviewer, filesystem/network scope) before prompt submit. Parser exact-checks verified (rung 2): `src/interpretation/native-settings.ts:36-71` requires `read-only` / `managed` / `restricted` / single root-read entry and rejects unknown policy fields. Effective-settings-before-turn plausibility supported by `native-approval-app-server-explicit-sandbox-probe.json:14-19` (`noTurnSubmitted: true` with full sandbox/model/provider). Resolved as spec; resume-param restoration and effective comparison are design-required-not-implemented (v2 states current seams lack approval support), not contradictions.

F3 - resume identity pinned. Terminology defines Native ID as exact resumable `thread.id` including forks, states HCN normalized `sessionId` means that ID and not root-group `thread.sessionId`, and requires resume plus compare of `thread.id` with no substitution. Supported by `codex-app-server-permissions-excerpt.md:48-60` (sessionId vs threadId, resume by threadId). Correlation rule covers method, native thread, native turn, and request ID including turn-start-ack arrivals. Resolved. Minor naming note in warnings.

F4 - grouped network approvals. V2 defines one request as one native server-initiated RPC, models a grouped network prompt as one request and one write, requires details to state group coverage (host, protocol, port when supplied), forbids invented sibling requests, and matches subsequent clears to the original RPC ID; unshowable grouping is unsupported. Addresses the double-write/hang/understatement defect against `codex-app-server-permissions-excerpt.md:130`. Resolved; group-clear matching is implementation acceptance.

F5 - autoResolutionMs. V2 scopes `tool/requestUserInput` including `autoResolutionMs` outside the responder and triggers unsupported-interaction cleanup, never auto-answers. Matches evidence placement (`codex-app-server-permissions-excerpt.md:142-148`, timer documented only under requestUserInput). Resolved.

F6 - hold vs fail contradiction. V2 separates phases: unsupported recorded settings hold feedback pre-prompt; unsupported requests arising in-turn fail that attempt after cleanup with feedback visibly held. Resolved.

F7 - projection vs native schema. V2 keeps HCN-owned plain-text projection with a completeness rule (every selected permission, path, grant root, destination, amendment represented; no approval when unrepresentable; bounds instead of truncation) plus payload-vs-projection tests, and defines lossless as durable event delivery rather than RPC forwarding. Per run constraints, native formats in Lucid are not required, so this division is accepted as a design decision. Resolved.

F8 - choice mapping and persistence. V2 adds the native decision table (accept / acceptForSession / decline / cancel / acceptWithExecpolicyAmendment with labels and scopes), permission subset turn/session/deny mapping, verified-default-scope rule, duration-and-effects disclosure for amendments and session grants, and states persistent means the native harness saves policy while HCN stores no cross-process decisions. Resolved.

F9 - write-path race. V2 pins the pipe (HCN-to-native JSON-RPC write, consume right before write), defines uncertain-not-retryable write failure, `sent`-means-submitted semantics, private native request IDs, duplicate-ID same-content dedup vs different-content reject, no resend after write intent, the chose/sent/no-longer-waiting UI distinction, all three crash messages (decided-no-intent, intent-no-sent, sent-no-result) with no retry against a replacement, and browser verification now covering pending, decided, sending, sent, cleared, unavailable. Resolved; residual uncertainty is surfaced, not silent.

F10 - timers. V2 names the owner (HCN runner inactivity timeout, injected `RunnerDeps.stallMs`), pause-while-waiting then restart rule, continuing caller hard deadline (`--timeout`, 0 disables), 30-second init/resume/ack protocol deadlines shortened by the hard deadline, injected-clock tests, no native timer changed. Owner and fields confirmed (rung 2): `src/execution/deps.ts:74-83` (`stallMs`, `turnTimeoutMs`, `clock`); `src/execution/stream-turn.ts:302-363` (supervision, both budgets). Resolved.

F11 - uncovered states. 33rd-request behavior now explicit (whole-attempt failure, all pending unavailable). Decided-without-intent loss now has exact UI text. Pre-ack arrivals must be correlated including turn-start acknowledgement, bounded by the 30-second ack deadline with general cleanup-to-unavailable on timeout. Resolved; see warning on the pre-ack buffer bound wording.

F12 - seams named. V2 lists `src/cli/plan-turn.ts:planTurn`, `src/cli/run.ts:run`, `src/execution/stream-turn.ts:streamTurn`, `src/execution/deps.ts:RunnerDeps`, plus Lucid `HarnessRunner`, `ConversationHost`, attempt reducer, and states these do not yet implement approvals. HCN-side names verified present (rung 2): `plan-turn.ts:143`, `stream-turn.ts:118`, `deps.ts:74`. Resolved.

## Design-required-not-implemented (not defects)

- Native resume-param restoration, effective-settings comparison, reviewer-authority retention, newer thread-settings event detection, and the native-approvals transport itself. V2 says so directly. Note the parser currently returns provider/model/effort/permissions without reviewer (`src/interpretation/native-settings.ts:74-100`), so reviewer retention is future work as specified; missing reviewer must stay unknown, never default to user.

## Warnings (non-actionable)

- Approval-request event field is still named `sessionId` while Terminology redefines it as the resumable thread ID. Correlation rule pins the thread; suggest a name or comment to prevent misreading. Not a behavior gap.
- Pre-ack native-request buffering is required by combination (correlate during ack, 30-second deadline, 32-pending whole-attempt overflow) but no single sentence states the pre-ack buffer bound. Suggest one line.
- `stallMs` "existing default" value lives outside the allowed reads; testability via injected clock holds regardless.

## Cleared (do not re-review without new evidence)

- Authority split, no-fallback/no-replay direction, first-write-wins with dedup, fail-closed bounds, browser/agent separation, newer-over-older settings preference, staged exact-permission lane, out-of-scope list. V1 cleared items remain sound; v2 does not disturb them.

## Not reviewed

- `src/cli/run.ts`, Lucid-side seams, live native behavior, browser pixel checks, env/credentials/user config, concurrent unpublished patches, validator re-derivation.

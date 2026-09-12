# RFC-27 v1 review (Draft) - native approvals during headless continuation

## What was reviewed

- RFC under review: `docs/rfc/27_native-approvals-during-headless-continuation.rfc.md`, number 27, version 1, status Draft.
- Governing docs in this worktree: `docs/rfc/26_interactive-artifact-conversation-continuity.rfc.md` (v4, Accepted), `CONTEXT.md`, `docs/adr/0008-browser-and-agent-content-have-separate-authority.md`.
- Method: `/Users/kevin/.agents/skills/review-rfc/SKILL.md` plus evidence ladder (`rung 1` asserted, `rung 2` pointed at file:line, `rung 4` ran - not reached; shell execution forbidden this run).
- Development evidence read (only allowed paths under `/Users/kevin/dev/lucid/artifacts/evidence/interactive-artifact-wayfinder`): `codex-app-server-permissions-excerpt.md`, `codex-0.154.0-persisted_resume_settings.rs`, `codex-0.154.0-thread_processor.rs` (partial, through line 600), `native-approval-app-server-probe.json`, `native-approval-app-server-changed-defaults-probe.json`.
- Scope obeyed: native approval UI and autonomous implementation are approved - not reopened. No edits made. Report text returned, no review file written.

## Structural results (verbatim)

The caller-supplied structural validation result is:

```
{"passed":true,"errors":[],"warnings":[]}
```

I did not re-derive it. Shell execution is disabled in this session so I could not run the validator myself.

## Findings

### F1 - `--native-settings-fingerprint HASH` is undefined (dangling reference)

Lands in: Message Formats / HCN command and framing (`27_native-approvals-during-headless-continuation.rfc.md:53-55`) and Security Considerations (`:125`, `:127`).

The flag is REQUIRED (`MUST require ... a valid fingerprint`), and `native-settings-unavailable / native-settings-changed` refuses without spawning (`:110`), but the RFC never defines: hash algorithm, hash inputs (which files/values), who computes the recorded value, or what "valid" means. "File-backed prompts remain supported" (`:55`) also names no flag. Two implementers will pick different fingerprint inputs and diverge on what refuses.

Why it changes implementation: admission-before-spawn is unimplementable as specified. HCN cannot distinguish "changed" from "unavailable" without the input set. Rung 2 (points at RFC lines; absence established by whole-document read).

### F2 - No authoritative expected-settings channel; persisted native state does not cover what must be compared

Lands in: Protocol Overview (`:42`), Message Formats (`:53-55`), Security Considerations (`:125`).

RFC-27 requires comparing before turn start: "exact session, folder, model, effort, provider, approval policy, reviewer and filesystem/network scope" (`:125`). The CLI passes only `--resume ID --cwd --prompt` plus a hash (`:53`); caller model/effort/provider/access/sandbox overrides are forbidden (`:55`). A hash cannot produce the field-level `native-settings-mismatch` diagnosis (`:111`).

Native evidence shows the gap is real, not theoretical:

- Persisted resume settings store only `approval_policy`, `approvals_reviewer`, `active_permission_profile` (`codex-0.154.0-persisted_resume_settings.rs:8-12`, rung 2). No sandbox/filesystem/network scope, no model/effort/provider there.
- Model/provider/effort are restored from `ThreadMetadata` (`codex-0.154.0-thread_processor.rs:223-241`, rung 2), but the changed-defaults probe proves legacy sandbox follows current config, not the recording: `sandbox` flips from `readOnly` (`native-approval-app-server-probe.json:13-16`) to `workspaceWrite` (`native-approval-app-server-changed-defaults-probe.json:13-22`) while `approvalPolicy: never` is retained in both (rung 2).
- Native resume-time mismatch detection itself is coarse for sandbox (`codex-0.154.0-thread_processor.rs:168-191` matches variants with `{ .. }`, ignoring `writableRoots`/`networkAccess` detail) and treats a supplied `permissions` override as ignored (`:192-197`), rung 2.

Why it changes implementation: as written HCN must "restore supported recorded settings" (`:42`) it was never given, from a rollout that (per excerpt) does not persist sandbox/network scope, while being forbidden the override channel that could carry Lucid's recorded values. Either the CLI must carry authoritative recorded values (contradicting `:55`), or the RFC must prove where recorded read-only/restricted-network values live natively and narrow the first lane to refuse otherwise. This is the insufficient-native-permission-authority defect.

### F3 - Resume ID is ambiguous across thread-id vs session-id (fork hazard)

Lands in: Protocol Overview (`:42`), Message Formats (`:53`), Security Considerations (`:125`).

The RFC uses "resume ID", "native ID", "exact session", "sessionId" interchangeably. Native distinguishes them: "read the session id from `thread.sessionId` instead of deriving it from the thread id" and "forked threads keep the session id of the root" (`codex-app-server-permissions-excerpt.md:48-50`, rung 2); resume takes `threadId` (`:56-61`). The approval event carries `sessionId, turnId` (`27:65`) with no `threadId`/`itemId`, while native approval params carry `threadId, turnId` plus `itemId` (`codex-app-server-permissions-excerpt.md:115,122,137,152`, rung 2).

Why it changes implementation: if HCN resumes by session-id it can continue the wrong thread after a fork; if by thread-id, "exact session" checks and the `sessionId` event field are misnamed. The correlation rule "MUST correlate method, native thread and native turn as well as request ID" (`27:83`) needs the pinned identity (thread.id at resume vs live thread at request) or a fork during the headless turn is unhandled.

### F4 - Grouped concurrent network approvals break the 1:1 request/decision model

Lands in: Message Formats / Lossless events (`27:65-73`).

Evidence: "Codex groups concurrent network approval prompts by destination ... one prompt that unblocks multiple queued requests to the same destination" (`codex-app-server-permissions-excerpt.md:130`, rung 2). The RFC models each native request as an independent `requestId` with its own response right, first-write-wins (`27:81`), up to 32 simultaneous pending (`:71`), clearing per-request (`:67,:99`).

Why it changes implementation: answering one grouped prompt natively resolves several queued requests. HCN's per-request consume/write map will either leave grouped siblings unanswered (hang), double-write them (second write rejected or, worse, double-granted), or understate what the person authorized. `networkApprovalContext` (host/protocol, port-separated, `command` not meaningful, `:128`) must either be refused as unsupported until grouping is specified or given explicit group-resolution semantics.

### F5 - `autoResolutionMs` is unhandled and contradicts the no-timeout-authorizes claim

Lands in: State Machine (`27:104`), Security Considerations (`:121`).

Evidence: `tool/requestUserInput` carries `autoResolutionMs` integer-or-null; "host clients can resolve the prompt automatically after that interval" (`codex-app-server-permissions-excerpt.md:146-148`, rung 2). The RFC pauses "native inactivity timeout" while awaiting a person (`:104`) and states no elapsed timeout authorizes a response (`:121`), but never mentions `autoResolutionMs`.

Why it changes implementation: if native auto-resolves (clears or answers) while Lucid still shows pending, the UI trilogy ("You chose / Answer sent / no longer waiting", `:102`) misreports, and pausing a timeout may exceed the native auto-resolution window. HCN must either surface the countdown, refuse `autoResolutionMs`-bearing requests as unsupported, or define which auto-resolution outcome maps to which `approval-cleared` reason. Currently uncovered.

### F6 - Contradiction: unsupported forms "remain visible holds" vs "fail the turn"

Lands in: Introduction (`27:23`) vs Message Formats (`:71`) and Error Handling (`:112`).

`:23` says unsupported permission forms "remain visible holds until verified". `:71` says an unsupported approval variant "fails the turn explicitly and cleans up"; `:112` ends the owned attempt with non-retryable failure. Both cannot hold for one unsupported request arriving beside valid ones.

Why it changes implementation: abort discards up to 31 valid concurrent pending requests; hold needs a specified hold UI and turn-continuation rule that does not exist. The author must pick one. Rung 2 (two cited normative statements).

### F7 - Approval event drops structured scope fields; "lossless" is by plain-text flattening

Lands in: Message Formats (`27:65-71`), Lucid durable authority (`:87-89`).

Native command approvals can carry `command, cwd, commandActions, proposedExecpolicyAmendment, networkApprovalContext, additionalPermissions` (absolute paths), `availableDecisions` (`codex-app-server-permissions-excerpt.md:122-123,128`, rung 2); file approvals carry `grantRoot` (`:137`); permission requests carry a requested set answered by "only the granted subset" plus session/turn scope (`:152-158`). The RFC's event has only `category, details (plain text), choices` (`27:65`), and permission subsets become "exact grant choices plus refusal" (`:73`) with no caller subset editor.

Why it changes implementation: flattening structured scope into `details` plain text means Lucid "saves them losslessly" (`:44`) only as prose. Audit cannot machine-check that the granted subset equals the requested subset, that `additionalPermissions` paths or `grantRoot` were fully shown, or that an execpolicy amendment's duration/effects were exact. Either each structured field needs an event mapping or those variants must be refused as unrepresentable (per the RFC's own no-truncation rule, `:71`).

### F8 - `Choice.scope` conflates outcome with duration; native mapping is private

Lands in: Message Formats (`27:69`), Protocol Overview (`:47`).

Each choice has exactly `id, label, scope` with scope from `once, turn, session, persistent, deny, cancel` (`:69`). Native has `accept / acceptForSession / decline / cancel / acceptWithExecpolicyAmendment` plus permission grants scoped `session` vs `turn`/omitted (excerpt `:112-113,:152-158`, rung 2). No mapping table is given; the payload mapping is explicitly private (`27:69`). `persistent` scope also sits beside "HCN MUST NOT persist or recover decisions across its own process lifetime" (`:47`) without distinguishing native-side persistence from HCN-side persistence.

Why it changes implementation: the person sees `scope` but its duration semantics are guessed by the implementer; a session grant shown as `once` (or vice versa) misstates authority. The RFC needs the explicit choice-to-native-decision table plus the rule already hinted at `:73` (amendments/session grants identify duration/effects in `details`).

### F9 - Write-path race leaves a crash-after-write gap and unverified states

Lands in: Decision command (`27:81`), State Machine (`:99-102`), Implementation Notes (`:137`).

"The first valid decision consumes its request's response right before pipe write" (`:81`) does not say which pipe (Lucid→HCN stdin vs HCN→native JSON-RPC response). Native order is request → client decision → `serverRequest/resolved` → `item/completed` (excerpt `:120-126,:133-140`, rung 2). `sent` means submitted, not accepted (`:81`); a cleared request loses its response right and delayed acks cannot reopen it (`:102`); a worker with write intent MUST NOT resend after restart/missing ack (`:89`); process/channel loss makes sending/sent-history terminal-unavailable (`:100-102`).

Why it changes implementation: HCN crashing after the native write but before `sent` means native may execute while Lucid permanently shows unavailable (write intent retained as history, but the person never sees "Answer sent"). The required fix is to pin consume-vs-write ordering, define the uncertainty UI for write-intent-without-ack, and verify the omitted states: browser verification lists pending, sent, cleared, unavailable (`:137`) but not decided/sending.

### F10 - Timeout/pause timers are invented without owner, values, or native source

Lands in: State Machine (`27:104`), Implementation Notes (`:137`).

"Native inactivity timeout pauses while requests await a person, then restarts when none remain; the caller's explicit hard deadline continues running. Init/resume verification retains bounded protocol waits" (`:104`). No native inactivity timeout appears in the allowed evidence; no bound is given for verification waits or the hard deadline. Deterministic tests "MUST cover ... timeout pause, hard deadline" (`:137`) without values to test against.

Why it changes implementation: untestable as written. Name the timer owner (HCN runner vs native server vs Lucid worker), the pause/resume rule interaction with F5, and numeric bounds, or drop the pause claim. Rung 1 for the absence claim (no timer in allowed evidence; I could not run code), rung 2 for the RFC lines imposing the untestable test.

### F11 - Uncovered states: pre-turnId requests, 33rd concurrent request, decided-without-write-intent loss

Lands in: Message Formats (`:65`), State Machine (`:93-100`), Error Handling (`:117`).

- Turn-start-ack race (`:83`) requires correlating requests "arriving during turn-start acknowledgement", but `approval-request` requires `turnId` (`:65`). A request arriving before the turn id is known has no representable event: buffer, refuse, or fail is unspecified.
- The 32-pending bound (`:71`) plus fail-closed (`:71`) implies the 33rd concurrent native request fails the whole turn, aborting 32 valid pendings. Whether the 33rd is refused individually or poisons the turn is unspecified.
- `decided` (browser decision saved, no write intent yet) lost to executor replacement goes `unavailable` (`:100`); the saved decision fact remains but can never dispatch. That matches "loss never authorizes replacement" but leaves the transcript showing a decision the person made that died silently - UI text (`:102`) does not cover it.

Why it changes implementation: each is a first-implementation branch the worker/HCN author will hit. Rung 2 (RFC lines) with rung 1 on frequency (I assert these occur; native grouping in F4 makes high concurrency plausible).

### F12 - Seam-compatibility claims are unverifiable (no seam named)

Lands in: Implementation Notes (`27:135,139`).

"Use HCN's descriptor-owned protocol vocabulary, pure interpretation and injected process primitives. Extend the one-turn runner" (`:135`) and "integrate [the concurrent native-interaction termination policy's] surviving contract without overwriting that work" (`:139`) name no file, function, or behavior. RFC-26's strict-resume checks "native ID and folder only" (`26:174`) while RFC-27 demands full effective comparison - an intentional extension, but the one-turn-runner extension point is unnamed.

Why it changes implementation: the reviewer cannot check drift from the codebase (a whole-document-read duty). The author must name the HCN runner entry and Lucid worker seams or mark this integration unverified. Rung 1 (unverifiable as cited).

## Cleared (checked, sound, do not re-review without new evidence)

- Direction of authority: HCN owns native formats/permissions/process supervision; Lucid owns durable decisions/presentation; HCN keeps no cross-lifetime decision state (`27:47`). Consistent with RFC-26 harness-seam ownership (`26:62,198`).
- No fallback: no fresh-session or ordinary-exec fallback (`27:42`); old HCN refuses the flag rather than silently downgrading (`:131`); no automatic command/decision replay on channel loss (`:114`). Matches RFC-26 no-fresh-fallback (`26:23,269`).
- Exactly-once direction: decision append guards + write-intent claim + HCN first-write-wins + duplicate-ID same-content dedup vs different-content reject (`27:81,89`). Safe direction; F9's gap is observability, not double-write permission.
- Fail-closed bounds: 4 KiB decision line, 64 KiB details, 512-byte labels, 16 choices, 32 pending; exceeding bound or unrepresentable details fails explicitly, never truncates authority (`:57,71`). Safe choice.
- Browser/agent separation: decision surface bound to epoch+attempt with existing auth/origin/agent-content separation and artifact/agent sources unable to mint approvals (`:87`); consistent with ADR-0008 accepted boundary. No widening proposed.
- Newer-over-older settings rule (`:125`) matches native `latest_persisted_resume_settings` preferring the most recent TurnContext/ThreadSettingsApplied (`codex-0.154.0-persisted_resume_settings.rs:17-47`, rung 2).
- Effective-settings verification without a turn is plausible: both probes report full effective settings with `noTurnSubmitted: true` (`native-approval-app-server-probe.json:11`, rung 2).
- Out-of-scope list (general sessions, auto-approval, arbitrary RPC forwarding, model questions, MCP elicitation, cross-process brokers, new users, `:25`) is explicit; MCP elicitation exclusion is consistent with F6 needing a hold-vs-fail decision rather than silent support.

## Not reviewed

- HCN source (`/Users/kevin/dev/lucid/artifacts/worktrees/hcn-interactive-launch/src`) and Lucid working-tree source beyond the excerpts above: per instruction, source pointers only, no broad exploration. F12 records the resulting seam gap.
- Live native behavior, network fetches, browser pixel checks at 390/768/1440, env/credentials/user config, native history: forbidden or unrunnable in this session.
- Whether the five allowed evidence files are the complete probe set; whether unpublished concurrent patches change `:139`.
- Re-verification of the structural validator beyond reporting the caller-supplied `{"passed":true,"errors":[],"warnings":[]}`.


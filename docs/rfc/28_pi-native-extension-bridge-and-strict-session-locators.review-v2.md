# RFC 28 v3 review

Reviewer: muse-spark-1.3-contributor@muse. Draft version 3, commit e9653c2. The full reviewer report follows unchanged, except that paths to git-ignored prototype files are cited as findings, not paths. v4 answers it in "Response to v2 review".


Reviewer route: Muse Code powered by Meta Muse Spark, static review only. No live harness run in this session. Evidence is the cited repo text, Pi 0.87.1 docs/types, hcn source, and the prototype artifacts. Session transcript files under the prototype session stores were not read per the brief.

The `review-rfc` skill is disabled in this session, so this is a direct review with the same focus.

## Summary

v3 is a real improvement over v2: the locator is gone, `agent_settled` replaces the blocking `agent_end` wait, and P1 proves the delete-race outcome end to end through hcn with 0 model calls. The disposition table is broadly honest about removals.

It is not yet sound on its two load-bearing claims:

1. Verify-after-open fails open when the extension does not run or throws.
2. The Bash-propose / `tool_result`-commit split has no proven subagent separation for Pi, unlike Claude's `agent_id`.

Plus a concrete argv contradiction with hcn's Pi descriptor, a missing folder check, and several RFC 26 contradictions by omission.

## Findings

### G1 - Blocking: Pi subagent proposals are committable, the split is unsound

Severity: blocking.

Evidence:

- `dist/core/extensions/types.d.ts:791-837` - `ToolResultEvent` has `toolCallId, input, content, isError, toolName, details`. No `agent_id` or subagent marker.
- `src/cli/hooks/claude.ts:78,193,214-225` - Claude safety rests on `input.agent_id !== undefined` to skip registration and to claim-and-refuse proposals.
- `docs/rfc/28_pi-native-extension-bridge-and-strict-session-locators.rfc.md:160-166` - claims a Pi subagent, RPC client, or background job "has no `tui` parent callback, so its proposal is never committed".
- the prototype findings (P2) and RFC E-table P2/P4 - prove only `ctx.mode` (`tui` vs `rpc` vs `json` vs `print`). No subagent negative control.

Analysis: a Pi subagent runs inside the same Pi process. Its Bash tool call fires `tool_result` in the same extension runtime with the same `ctx.mode === "tui"` and the same helper parent (the Pi PID). The RFC's parent check (`readProcessOwner(process.ppid)`, RFC lines 144-150) therefore passes for subagent tool output exactly as it does for foreground output. `PI_SESSION_ID` locates the same registration, the nonce marker is in the same output text, and `registrationId` equality passes. Nothing in the cited evidence distinguishes the two.

Where it lands: Protocol Overview steps 2-3, Security Considerations "model cannot nominate an owner", Message Formats per-operation table "as Claude PostToolUse", Implementation Notes slice 4, disposition row F6.

Required fix: prove the negative control or hold the lane. Either document the Pi subagent marker that `tool_result` carries and mirror Claude's claim-and-refuse (including bind-operation refusal written beside the publication, as Claude does), or state that Pi subagent provenance is unverified and `pi-cli` stays unavailable with `subagent-provenance-unverified` until that probe passes. P2/P4 do not satisfy v1 F6; do not mark F6 closed on mode evidence alone.

### G2 - Blocking: verify-after-open fails open on extension load or handler error

Severity: blocking.

Evidence:

- `docs/extensions.md:199-201` - "Pi reports handler errors and continues where possible."
- the prototype extension - sets `exitCode = 3` only on the refused path; a throw before that leaves exit 0 and continues.
- RFC lines 194-206 - assumes `session_start` comparison always runs and `input` returning `handled` always drops the prompt.

Analysis: any of these runs the model in the substituted session with success misread as success: `-e` path wrong or unreadable, extension factory throws, `session_start` handler throws, `input` handler throws or is superseded by another extension's handler ordering, `before_agent_start` `ctx.shutdown()` never reached. Pi's handler-error-continues rule makes this the default, not the edge case. The RFC's "Extension missing at resume time: Lucid refuses before invoking hcn" covers only the missing-file case, not the loaded-but-threw case.

Where it lands: Headless role steps 7-9, Error Handling table, Implementation Notes slices 2-3.

Required fix: fail closed. Wrap every headless handler so any error takes the refusal path (stderr marker, `input` returns `handled`, `shutdown()`, exit 3). Specify handler ordering relative to other extensions or require sole-extension semantics for the resume run. Define Lucid's reading of a headless Pi run with no marker and nonzero exit as uncertain hold, never success, and never retryable as a typed refusal.

### G3 - Blocking: wrong hcn passthrough shape and missing folder check

Severity: blocking.

Evidence:

- RFC line 191-193: `hcn run pi --resume <id> ... -- -e <extension path>`.
- `/Users/kevin/dev/harness-cli-normalizer/src/knowledge/pi.ts:27-34` - passthrough is `after-argv` with no separator; the comment explicitly says the `--` separator caused prompt-joining and was removed.
- RFC lines 194-202 - headless check compares session IDs and message count only.
- `docs/rfc/26_interactive-artifact-conversation-continuity.rfc.md:148,210` - requires exact native identity and folder; HCN strict-resume checks ID and folder.
- `/Users/kevin/dev/harness-cli-normalizer/src/cli/store-root.ts:50-58` vs `src/knowledge/pi.ts:124` - the store-root fix source is correct; the descriptor template is still the old `{home}/.pi/sessions/{cwdSlug}` path.

Analysis: the RFC's `--` argv contradicts the pinned descriptor and would regress to the prompt-joins behavior the descriptor documents. Separately, ID-only verification admits a same-ID session from a different working folder. The hcn guard is folder-scoped today (cwd slug) and is itself buggy until slice 1 lands, so the in-Pi check is the only TOCTOU-proof folder check and it omits the folder.

Where it lands: Headless role steps 7-8, Implementation Notes slice 1, Amendment 1.

Required fix: change step 7 to after-argv passthrough with no `--` (or amend the hcn descriptor first and re-prove). Add an expected-folder input alongside `LUCID_PI_EXPECTED_SESSION` and compare `ctx.cwd` and/or header `cwd` with it; refuse on mismatch. Keep slice 1 as a prerequisite, not a parallel nicety.

### G4 - Major: `session-substituted` mapping is underspecified and possibly spoofable

Severity: major.

Evidence:

- RFC lines 234-242 - marker `lucid-pi-session: {...}` on one stderr line, exit 3, "stderr contains exactly one such line".
- the prototype findings - P1 race emitted `class: "native"`, `nativeExitCode: 3`, marker inside `message`. Typed class does not exist yet.
- `src/knowledge/pi.ts:79-80` - Pi itself warns on stderr ("creating a new session with that id").

Analysis: "exactly one such line" does not say whether other stderr lines are allowed (they exist: Pi warnings, shim output, Node warnings). Exit 3 is not shown to be reserved by Pi. Most important: it is unproven that model-executed Bash output cannot reach process stderr. If a headless-run model can write process stderr (directly or via a tool that forwards), it can forge or duplicate the marker. The fallback ("older hcn reports `native`, Lucid holds, which is safe") is correct as a hold, but then Amendment 1's "counts as pre-model refusal" applies only to the new hcn, and the RFC should say so.

Where it lands: Message Formats refusal marker, Error Handling `session-substituted` row, Amendments, slice 2.

Required fix: pin the contract - exit code reservation, whether non-marker stderr lines are permitted, JSON field validators, duplicate-marker rule. Prove process-stderr isolation from model tool output or move the marker to a channel the model cannot write (control pipe or a file outside the session). State that until slice 2 lands, P1 outcomes stay uncertain holds.

### G5 - Major: `agent_settled` idle injection still has open races

Severity: major.

Evidence:

- `types.d.ts:209-250,1055-1058` - `isIdle()`, `sendUserMessage` with `deliverAs: steer | followUp`, `shutdown()` in all contexts.
- `docs/extensions.md:62-67` - `agent_before_settle` is the final actionable boundary; `agent_settled` is final and notification-only.
- RFC steps 4-6 (lines 167-185), State Machine lines 261-271, P3 (RFC lines 111, FINDINGS lines 52-56): timer injection at 1.5 s, `source: "extension"` ran, 4 `agent_end` + 1 `agent_settled`, `shutdown()` in `agent_settled` exited.

Analysis: P3 proves the happy path, not the races:

- `isIdle()` check then `sendUserMessage` is TOCTOU. `followUp` while streaming queues, which is safe, but shutdown/exit between check and send must map to delivery-uncertain, not silent drop.
- Person input arriving after the helper recorded `offer-started` but before `sendUserMessage` delivers: step 6 kills helpers "while a helper waits", but the helper already exited with the instruction. The extension holds an offer the person never saw. RFC 26 no-replay applies; the RFC states it once ("MUST NOT replay") but the State Machine's `waiting -> offered -> registered` path does not show the uncertain branch or where the undelivered offer fences the next `agent_settled`.
- One helper per settled point is assumed. Retries, compaction retries, and queued follow-ups can produce overlapping `agent_settled` handlers or a second settled while the first helper still waits. No singleton/supervisor is named.
- Replacement/shutdown ordering ("kill, await, then re-register") names the order but not the owner: the `session_start(reason: new/resume/fork)` handler runs in a runtime that `reload` may have just invalidated (`docs/extensions.md:50`). An orphan helper from the old runtime has no owner to kill it.
- The 45-second bound reuses RFC 26's number, but RFC 26 ties it to a native hook deadline of at least 60 s (`26:230`). Pi `agent_settled` has no hook deadline; there is no native bound to fit inside. Either justify 45 s standalone or declare Pi deadline-less and prove no truncation at the chosen bound.

Where it lands: Protocol Overview steps 4-6, State Machine, Implementation Notes slice 5, disposition rows F3/F8.

Required fix: name the helper supervisor (extension-global handle, spawn/kill/SIGTERM-then-SIGKILL-2 s/await ordering relative to re-registration and `session_shutdown`), singleton rule across overlapping settled events, `sendUserMessage` failure mapping to delivery-uncertain with no replay, and the person-input-during-delivery fence. Record the Pi hook-deadline absence as an explicit deviation from RFC 26 with acceptance evidence instead of borrowing the 60 s number.

### G6 - Major: Amendment 1 overclaims "proven pre-model refusal"

Severity: major.

Evidence:

- FINDINGS lines 20-26: closed-port provider, "Connection error" as model-call detector; new session has 2 non-message entries; Pi persists lazily so refused runs write nothing.
- RFC lines 293-298: process started but extension stopped it before the prompt reached the model, Pi wrote no session file, counts as pre-model refusal, no retry, no fresh session.
- RFC 26 lines 150-154, 185: launch-attempt notice, proven pre-start refusal uses same input with a new attempt ID; `resume-failed` offers `retry-resume`.

Analysis: the closed-port proof shows no model call for that provider configuration, not for all providers (cached models, local providers, future Pi paths that call before `input`). "Pi wrote no session file" is a lazy-write observation, not a contract; a future Pi that writes empty sessions would still refuse correctly on message count but the amendment's second clause would be false. And "pre-model refusal" in RFC 26 is retryable after repair with a new attempt ID, while this amendment says no retry. Both halves can be true (proven for this attempt, held with no auto-retry), but as written the amendment borrows RFC 26 authority while contradicting its retry projection.

Where it lands: Error Handling `session-substituted` row, Amendments item 1, Versioning "older hcn reports native ... holds, which is safe".

Required fix: narrow the amendment to what P1 proves - typed `session-substituted` is a proven pre-model refusal for that attempt; input stays held with reason `native-session-missing`; no automatic retry or fresh session; an explicit operator-admitted same-session retry after repair uses a new attempt ID per RFC 26. Caveat the lazy-write observation as version-specific behavior, not part of the refusal definition. The refusal definition should be marker plus 0-message/ID-mismatch plus `handled` input, not file absence.

### G7 - Major: silent RFC 26 deviations

Severity: major.

Each needs an explicit amendment line or removal:

1. Launch notice: RFC 26 section 6 requires the durable `No interactive session detected. Resuming headlessly with session <id>.` notice with a stable launch-attempt ID before creation. RFC 28 step 7 resumes through hcn with no notice. Add it or amend it.
2. Folder identity: see G3. RFC 26 requires ID plus folder; RFC 28 verifies ID plus message count.
3. Listener transport: `src/cli/native-listening.ts:53-65` (`STOP_TRANSPORTS`) has only `claude-cli` and `codex-cli`. RFC 28 step 4 assumes the Pi offer path exists. Adding `pi-cli` there is the acceptance contract (RFC 28 Amendment 2 gestures at this) - but step 4 should say the transport stays `transport-unverified` until the live TUI lane passes, not imply the helper alone enables it.
4. Binding across replacement: RFC 26 says new/resume/fork refresh registration and cannot silently carry a binding (`26:76`), and a changed registration cannot overwrite a conflicting binding. RFC 28 replaces registration with a new generation and moves to `none`, but never says the record binding is retained untouched and later commits under the old `registrationId` refuse. State it.
5. `PI_SESSION_ID` in headless runs: the propose step locates by `PI_SESSION_ID`. If a headless Pi run exports a session ID env, the model can propose. The RFC relies on mode-gating the commit helper, which is correct, but should say headless proposals are never committed because no `tui` callback exists, rather than leaving the reader to infer it.

### Disposition table audit (v3 lines 381-390)

- F1 (locator removed): agree. No locator or payload v4 remains.
- F2 (verify-after-open + typed class + store-root fix): provisional, not closed. Store-root diagnosis matches `store-root.ts:50-58`. But typed class is not in hcn (FINDINGS says "must map"), folder check is missing (G3), argv shape is wrong (G3).
- F3 (non-blocking settled helper + idle injection): provisional. Signal choice (`agent_settled`) is correct per docs, P3 proves delivery, but supervision and races (G5) remain.
- F4 (per-operation table): conditionally satisfied. Table exists (RFC lines 247-252) with validators and lock order. "Commit point as Claude PostToolUse" is where G1 hides; the table needs the subagent row.
- F5 (trust composition): textually satisfied (RFC lines 134-140) and the MUST NOT is present. Implementation phrase "Pi entry point's interpreter" still needs pinning (which executable: `node`, `bun`, wrapper script, shebang refusal).
- F6 (provenance P2/P4): mode part satisfied; subagent part still blocking. Keep `subagent-provenance-unverified` as the activation gate explicitly.
- F7 (locator bounds removed): agree the locator is gone, but folder scoping returns as G3. Removal of the locator did not remove the folder-identity requirement.
- F8 (helper lifecycle): provisional. Kill/await/re-register is stated (step 6, State Machine), but supervisor identity, reload invalidation, SIGKILL ownership, 64 KiB/48 KiB bound enforcement (refuse vs truncate), unknown-field refusal point, and truncated-result handling are still missing.

### Minor / correctness nits that should be fixed in the next revision

- Env name drift: RFC uses `LUCID_PI_EXPECTED_SESSION`; `run.sh` and the prototype use `LUCID_EXPECTED_PI_SESSION`. Unify before slice 3.
- Mode table should state `rpc` with the env var set still does nothing. Otherwise a headless RPC session could be mistaken for a verify lane.
- Refusal needs both `input -> handled` and `shutdown()` plus exit 3, with precedence stated. The prototype does all three; the RFC describes marker plus exit 3 plus handled but leaves `shutdown()` as prototype detail.
- Helper stdin 64 KiB / output 48 KiB: state who enforces (extension before spawn vs helper before parse) and that overrun refuses without mutation, and that unknown `event` values and unknown fields refuse. The Message Formats section says this; the supervision section should repeat the owner.
- OQ1 (queue vs hold when busy) is a protocol decision, not an open question to ship with. Queuing delivers sooner but risks stacking offers across retries; holding keeps one offer per idle point and matches RFC 26 uncertainty rules. Recommend hold until next `agent_settled` as the default, with queuing only if the live lane proves no stacking.
- OQ2 (`pi install` vs settings edit): minor, but the chosen path affects the trust story (package install runs more code than a settings edit). Decide with the setup slice.
- Exit code 3: verify Pi does not use it, or pick a value hcn owns and document the reservation.

## Verdict

v3 is not yet implementable as a `pi-cli` acceptance contract. It correctly retires the locator, correctly picks `agent_settled`, and P1 is genuine end-to-end evidence for the race outcome. But G1 (subagent commit), G2 (fail-open), and G3 (argv plus folder) are blocking, and G4-G7 must be closed or explicitly amended against RFC 26 before slices 3-5 proceed. Slices 1-2 (hcn store root, typed refusal mapping with fixtures) remain the correct next work and do not depend on the open injection questions.

Recommended next revision: fix G1-G3, narrow Amendment 1 per G6, add the missing RFC 26 amendment lines per G7, and change the disposition rows for F2, F3, F4, F8 from closed to provisional with the named probes (subagent tool_result marker, handler-throw refusal, folder mismatch refusal, replacement-during-wait kill/await ordering, `--`-less passthrough through hcn).


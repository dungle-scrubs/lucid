# Review of RFC 24 v1: Claude startup across compatible updates

Save as `docs/rfc/24_claude-startup-across-compatible-updates.review-v1.md`.

## What was reviewed

- **RFC:** `docs/rfc/24_claude-startup-across-compatible-updates.rfc.md` in worktree `artifacts/worktrees/claude-startup-plan`, branch `docs/claude-startup-contract-20260910`, base `61733ba`. The file is untracked.
- **Version:** v1 (frontmatter `version: v1`). **Status:** Draft. **Type:** protocol. **Author:** Codex.
- **Reviewer:** Claude Opus 5 (`claude-opus-5`) in the Claude Code harness. It was one pass, with no subagents, no delegation and no model tasks. Codex wrote the RFC and a Claude-family model reviewed it, so the review is cross-family as `docs/rfc/README.md:37-39` requires.
- **Inputs read:**
  - The whole RFC (lines 1-177).
  - `docs/rfc/README.md`, `docs/drivers.md`, `docs/compatibility.md`, ADR 0005, ADR 0009 and RFC 19.
  - HCN research `operations.md` and `native-context.md`.
  - HCN and Lucid source ranges listed under each finding.
- **Evidence levels:** Levels follow `~/.agents/skills/blast-radius/references/EVIDENCE-LADDER.md`. No finding reached level 4 or 5. Nothing was run, because this session has no shell tool. Each finding states its level inline.

## Structural results

**The validator was not run.** This session has no shell or command-execution tool, so `npx tsx /Users/kevin/dev/skills/skills/engineering/draft-rfc/scripts/validate-structure.ts docs/rfc/24_claude-startup-across-compatible-updates.rfc.md` could not be run. No validator output exists to quote. I did not re-derive its checks by hand, as the skill forbids that. Run it before this review is used.

## Findings

Severity:
- **High:** the RFC's central claim fails in a common flow, or the gap leaves normative behavior undecidable.
- **Medium:** two statements cannot both hold, or a rollout or regression gap would let a wrong implementation pass.
- **Low:** a precision or completeness gap.

### F1 (High): unconfirmed same-session content sends ordinary continuations back to the retained hold

**Lands in:**
- Terminology, "Imported history" (line 33)
- Lucid preparation selection (lines 59, 63, 65)
- State Machine (lines 92, 96)
- Error Handling (line 111)
- Regression evidence, Continuation and Imported history rows (lines 150-151)

**Problem.** Line 33 defines imported history as everything in the captured `history` after confirmed coverage. Line 59 allows the native route only when that set is empty. In current Lucid, that set is not empty after several ordinary same-session events:

- **Record history:** `projectConversationContext` puts every non-pending input and every projected event with `from <= seq < through` into `history`. Projected events include assistant messages, tool results and failures (`src/store/conversation-context.ts:138-162`). `from` is the confirmed coverage for the target native session (`src/modes/managed-preparation.ts:139-144`).
- **Coverage:** coverage advances only on `coverage-confirmed` with completed-turn evidence (`src/protocol/context-coverage.ts:177-190, 300-325`).
- **Queued input during a running turn (level 3, traced, not run):**
  1. The user submits input B while turn T1 streams.
  2. `contextConfirmationLimit` stops T1's confirmation at B's sequence (`context-coverage.ts:107-129`; also `docs/drivers.md:357-360`).
  3. When B is prepared, its history holds T1's output after B's sequence, including the final assistant message (`conversation-context.ts:143-162`).
  4. B takes the bounded route, even though the native session already holds that output.
- **Failed native attempt (level 3):** a native failure does not confirm coverage. Retrying the same input captures that attempt's partial output and failure event as history. This covers native prompt too long, failed or disabled compaction (line 111), a byte limit, auth failure and cancellation.
- **Held earlier input (level 3):** a later input can run while an earlier one is held (`docs/drivers.md:78`). The held input's sequence is at or after `from`, so it appears in the later input's history.

On the bounded route, line 63 recounts native occupancy. If occupancy exceeds the limit, preparation holds with E-HUB-06. E-HUB-06 holds never wake by themselves (`src/store/managed-readiness.ts:45-66`), and a retry recaptures the same non-empty history.

**Consequence.**
- **Core case:** the Introduction says a tiny continuation is held when native occupancy fills the budget (line 21). That still happens on the same harness and the same native session after one queued note or one native failure.
- **Worst case:** a session that fails natively near its limit cannot run the native turn that would compact it. The failure is most likely near the limit. Every retry holds before dispatch. The only way out is explicit fresh continuation, which abandons the native session.
- **Approved scope:** the approved boundary is about a *transfer* that cannot fit a full native session. The same-session tail is not a transfer, so line 33 is wider than the approval text.
- **Regression gap:** the regression table has no row for a continuation after a queued note, a failed attempt or a held input.

**Fit check.** Users continue artifacts, queue notes (commit `61733ba` touched this) and retry after failures. Stating the behavior holds scope. Routing same-session tails natively would change a history-protection rule. That choice belongs to the user and is not required by this finding. The blocking part is that the RFC does not say which way these states go, and does not test them.

### F2 (Medium): harness-wide operation authority conflicts with Claude-only resume semantics

**Lands in:** HCN operation authority (lines 43, 45); Message Formats, `resume` row (line 78); Versioning (line 127); Ordered handoff step 1 (line 137); Out of scope (line 25); Message Formats, Codex row (line 76); line 131; Regression evidence, Compatibility row (line 153).

**Problem.** Lines 43, 45 and 76 cannot all be met by one implementation:
- Line 43 is general: a different version "MUST NOT itself refuse an otherwise supported operation."
- Line 45 redefines `supported` only "for Claude runtime resume inspection."
- Line 76 says the Codex contract stays unchanged.

HCN computes the resume verdict in one shared function for every harness: `supported = version === harness.verifiedAgainst` (`src/cli/runtime-compatibility.ts:40`, called from `src/cli/inspect.ts:87` for any harness). Lucid gates every native resume on that field, whatever the harness (`src/modes/managed-preparation.ts:265-271`). Evidence level 2.

**Consequence.** An implementer has two options:
- **Keep version equality for Codex, pi and Muse.** This breaks line 43, and a compatible Codex update still holds Codex continuations with E-HUB-03.
- **Change the shared function.** This changes Codex resume admission, which lines 25, 76 and 131 say this RFC does not do, and line 153 has no test for it.

Either way, one `runtime.resume.status` field would carry two meanings chosen by harness, and Lucid reads it one way.

### F3 (Medium): the inspection execution guard is an open denylist with a dangling allowlist and an observed-value condition

**Lands in:** HCN operation authority (line 49); Regression evidence, Accounting row (line 148).

**Problem.** Line 49 rejects three things: assistant execution, tool execution and a positive-turn query result. It permits one example: a success result with zero turns and zero assistant usage. It also lets "existing permitted startup/control frames" and "unknown additive metadata" through. Four gaps follow:

1. **Dangling reference.** No list of "existing permitted startup/control frames" exists. The current interpreter ignores every frame except the matching control responses and the replay acknowledgment (`src/interpretation/context-inspection.ts:137-167`). The execution owner completes on the usage response (`src/execution/context-inspection.ts:101-106`). Evidence level 2.
2. **Unclassified results.** The RFC does not classify these cases:
   - a `result` frame with zero turns and an error subtype
   - a `result` with a missing or non-numeric turn count
   - zero turns with non-zero usage
   - execution frames that arrive after the usage response, when the probe is already `finished` (`interpretation/context-inspection.ts:138`)

   Read beside "unknown additive metadata is not itself an execution event," an unrecognized execution-shaped frame passes. The research asks for the opposite: it calls this a concrete missing guard (`operations.md:46`). Evidence level 2.
3. **Observed value used as a rule.** "Zero assistant usage" is the value seen in these probes (`operations.md:23`). It is not a documented contract. The research does not claim the probe makes no provider requests. If a compatible Claude update reports usage for the control exchange, accounting fails closed. Every Claude turn with imported history, and every F1 state, then holds. That is the per-release breakage this RFC removes, brought back through a value check. Evidence level 1 for the future-update scenario, unproven.
4. **Thin tests.** Line 148 lists only the allowed zero-turn result. No negative-control shapes from item 2 are listed.

### F4 (Medium): prompts already held by this defect have no stated recovery path

**Lands in:** State Machine (line 99); Error Handling (line 117); Ordered handoff (lines 139-141); Regression evidence (lines 147-153).

**Problem.** The observed failure has already created durable holds:
- **`unverified-adapter`:** becomes E-HUB-03 with actions `change-settings` and `retry` (`src/modes/context-preparation.ts:34-46`).
- **Native-occupancy hold:** becomes E-HUB-06 (`src/modes/managed-preparation.ts:376-379`).

Their wake rules differ:
- **E-HUB-03:** wakes only when the settings, location revision or native-session hash changes (`src/store/managed-readiness.ts:20-24, 62-66`). Installing new HCN changes none of these.
- **E-HUB-06:** never wakes and needs an explicit Retry.

Line 99 forbids silent replay, which is correct. But the RFC does not say which user action releases these existing holds after integration. RFC 19 specified one for its rollout (RFC 19, Error Handling). The live startup criterion (line 149) uses a *new* artifact, so it never exercises a held one. Evidence level 2.

**Consequence.** Existing held prompts stay held with no documented path. An implementer might also add an HCN-change wake to fix that, which would break line 99.

### F5 (Low): rollout does not define the intermediate pairing or "old Lucid"

**Lands in:** Versioning (line 129); Ordered handoff (lines 137-139).

**Problem.**
- **Earlier fix available.** Step 1 alone, with a Lucid pin bump, would clear the observed `unverified-adapter` startup hold on the bounded route. A short first prompt with empty history fits. The handoff defers all consumer integration to step 3. It does not say whether a step-1 pin bump and fixture recapture are allowed or forbidden.
- **Undefined test target.** "Newer HCN on old Lucid" (line 129) does not identify which old Lucid, such as the released `2.0.0-beta.3` at `26acd5c`.
- **Reachability.** The pairing is reachable only through `LUCID_HCN` or a PATH fallback (`docs/drivers.md:53-54`), because the exact pin normally prevents it.

Evidence level 2. **Consequence:** the verification target is unclear, and fixtures could be captured twice without a plan.

### F6 (Low): valid mode combinations for the new kind are unspecified

**Lands in:** Message Formats (lines 75, 83).

**Problem.** Line 83 says "recognize only known kind/mode combinations," but the RFC gives only `["headless-turn"]`. The existing decoder follows RFC 19 R4. It accepts any set of known modes that includes `headless-turn` for `auto-compaction` (`src/harness/inspection-facts.ts:8-13`; `test/harness/hcn-runner.test.ts:335`). The RFC does not say whether the new kind follows that superset rule or requires exactly `["headless-turn"]`.

Lucid also exposes the declaration as a boolean (`src/harness/runner.ts:52`; `src/harness/hcn-runner.ts:317-319`), and one branch consumes it (`managed-preparation.ts:303`). Both kinds will need to reach that branch distinctly. Line 151 would catch a merged boolean only if tested with the new kind. Evidence level 2.

### F7 (Low): the provenance requirement has no carrier

**Lands in:** Message Formats (line 83).

**Problem.** "HCN capability provenance MUST describe documented/curated support as such" does not specify a field or surface:
- The declaration carries only `kind` and `modes` (`src/knowledge/descriptor.ts:466-470`; `src/cli/inspect.ts:163-168`).
- The runtime resume object has no provenance field (`runtime-compatibility.ts:42-52`).
- The Message Formats table adds none, and Lucid reads none.
- HCN comments still say "verified at verifiedAgainst" (`descriptor.ts:459, 466`) and "Exact verified versions establish support" (`runtime-compatibility.ts:23`).

Evidence level 2. **Consequence:** the MUST cannot be tested as written.

### F8 (Low): disabled auto-compaction is invisible on the native route

**Lands in:** Lucid preparation selection (line 61); Message Formats (line 75); Error Handling (line 111).

**Problem.** The new kind is static descriptor data. Accounting would expose `isAutoCompactEnabled` (`src/interpretation/context-inspection.ts:90-100`), but the native route runs no accounting. With compaction disabled, turns grow until the native session fails. Through F1, the next turn then holds. The declaration's name claims auto-compaction for a configuration where it is off. Evidence level 2 for the mechanism, level 3 for the combined outcome.

**Fit check.** Detecting the setting would widen scope and is not asked for here. The gap is the missing statement of the limitation and of its recovery.

### F9 (Low): changes to the smaller-model outcome and to model-agreement checks are not stated

**Lands in:** HCN operation authority (line 51); State Machine; Regression evidence, Continuation row (line 150).

**Problem.**
- **Smaller-model criterion.** "Smaller-capacity model ... preserve continuity rules" gives no expected outcome, so it cannot fail.
- **Behavior change.** After this RFC, changing to a smaller-window model on the same harness resumes with empty history. A preference is not an event (ADR 0009; `docs/drivers.md:174-177`). The turn dispatches natively and may compact or fail. Today the turn holds before dispatch.
- **Lost check.** Ordinary Claude turns also lose the pre-dispatch `model-divergence` check (`src/harness/context-accounting.ts:56-61`). Line 51 keeps agreement checks only "before using accounting." The RFC does not carry over the statement in `docs/drivers.md:311-312` that observed model agreement is not measured on the native route.

Evidence level 2.

### F10 (Low): State Machine rows overlap and one outcome is missing

**Lands in:** Terminology, "Hold" (line 37); State Machine (lines 90-94).

**Problem.**
- **Overlap:** Rows 90 and 91 overlap without a stated precedence. Row 91 does not exclude row 90's "missing resume support."
- **Missing outcome:** Row 94 says "attempt recorded, then ... dispatched." Current code can record `pre-start-failed` (E-HUB-07, `dispatch-not-called`) when cancellation lands between the attempt write and dispatch (`managed-preparation.ts:339-357`). Neither the table nor line 37 lists that outcome.
- **Missing wake rules:** The table has no transitions for how holds wake. E-HUB-03 wakes on a prerequisite change. E-HUB-06 needs Retry.

Evidence level 2.

### F11 (Low): the target notice surface is ambiguous

**Lands in:** Error Handling (line 115).

**Problem.** "Current visible notice surface" could mean the compatibility diagnostic list or the transcript:
- **Compatibility list:** codes `inspection-unavailable` and `selection-unsupported`, announced once per document (`docs/compatibility.md:31-47`).
- **Transcript failure:** a dispatched native failure appears there (RFC 19, Error Handling).

Putting per-turn native failures in the compatibility list would conflict with that list's purpose and its once-per-document announcement. Evidence level 2.

### F12 (Low): an unused term and a numbering drift

**Lands in:** Terminology (line 31); frontmatter (line 2).

**Problem.**
- **Unused term:** "Compatible operation" is defined and never used again. The body says "otherwise supported operation" (line 43) and "valid operation" (line 147).
- **Numbering drift:** `docs/rfc/README.md:32` records the highest allocated number as 22 and the next as 23. This RFC is 24, and git status shows no README update. I did not check Git history for a 23 allocated elsewhere.

Evidence level 2.

## Cleared

- **Observed failure (line 21):** matches the source. The gate is at `inspect-context.ts:58-63` and `runtime-compatibility.ts:40`. The anchor is 2.1.263 (`claude-code.ts:28`). `operations.md:7,18` records the refusal. Level 2.
- **Accounting no longer depends on the resume verdict (line 47):** this correctly describes the change from `inspect-context.ts:59`. Level 2.
- **Forked, non-persistent resume accounting (line 53):** matches `claude-code.ts:155-159` and `interpretation/context-inspection.ts:22-26`. Level 2.
- **Old reader and new kind (line 83):**
  - The old decoder requires `kind === "auto-compaction"` (`inspection-facts.ts:8`). An unknown kind yields no native flag and falls back to bounded preparation (`managed-preparation.ts:302-309`).
  - The existing test covers an unknown kind (`hcn-runner.test.ts:338`).
  - With operation-based HCN, an old Lucid gets today's bounded behavior with working accounting.
  - Level 2. The test exists, but I did not run it.
- **Why a new kind (line 131):** the rationale is accurate. The old decoder ignores extra fields, so an optional restriction on `auto-compaction` would be bypassed. Level 2.
- **Native route keeps the offered copy, the fence and null accounting (lines 61, 80):** matches `managed-preparation.ts:273, 302-304, 314-330` and `test/modes/managed-preparation.test.ts:834-931`. Level 2.
- **Unprojectable content holds before either route (line 63):** capture and projection run before route selection (`managed-preparation.ts:139`; `conversation-context.ts:111-113`). Level 2.
- **Bounds (line 65):** the six passes, 64 summaries, 256 counts, 16,000 characters and 300 s all match `docs/drivers.md:325-328`. Level 2.
- **Progress label (line 81):** `compact_boundary` is an existing progress label (`native-context.md:24,26`). Level 2.
- **Attempt recorded before dispatch (line 99):** matches `managed-preparation.ts:314-330`. Level 2.
- **Runtime `resume` shape (line 78):** matches `runner.ts:55` and `hcn-runner.ts:263-269`. Level 2.
- **ADR 0005:** no version comparison moves into Lucid. Eligibility excludes harness name and version (line 57). Level 2.
- **ADR 0009:** selected settings are retained on failure (line 107). Level 2.
- **AGENTS.md fixture rules (line 155):** synthetic sequences are labeled, and fixtures are recaptured from the intended release. Level 2.
- **Records and rollback (line 141):** no new durable record field is added, because `attempt-started` carries no accounting (`managed-preparation.ts:314-330`). Rollback needs no record migration. Level 2.
- **Zero automatic retries (line 117):** consistent with `docs/drivers.md:180, 313-316`. Level 2.
- **RFC 2119 usage:** capitalized keywords are used consistently. This was not machine-checked, because the validator did not run.

## Not reviewed

- **Structural validator:** not run, because there is no shell tool.
- **codebase-memory graph:** the `list_projects` permission was denied, so no `check_index_coverage` call ran for any file. No source conclusion depends on graph results or on absence from the graph. All source evidence comes from direct reads of these ranges:
  - Lucid: `managed-preparation.ts:90-389`, `inspection-facts.ts`, `runner.ts:1-140`, `hcn-runner.ts:200-349`, `context-accounting.ts:25-84`, `context-preparation.ts:28-62`, `conversation-context.ts:100-188`, `context-coverage.ts`, `managed-readiness.ts`, `hcn-runner.test.ts:325-364`, `managed-preparation.test.ts:825-931`.
  - HCN: `inspect-context.ts`, `runtime-compatibility.ts`, `interpretation/context-inspection.ts`, `execution/context-inspection.ts`, `descriptor.ts:440-484`, `claude-code.ts:1-170`, `capabilities.ts`, `inspect.ts:30-99`.
- **HCN code not read:** `inspectSessionRuntime` (the headless-session runtime path), the `installedVersion` timeout, and `check.ts`.
- **Research artifacts:** the recordings, probe scripts and JSON results were not opened. The research claims are used as reported.
- **External sources:** official Claude documentation, HCN issue #149, and the immutable GitHub links (commits `f38cbd1`, `51014fc`, `cd2328d`) were not fetched. I did not check that the research worktree matches `f38cbd1`.
- **Lucid areas not read:** the server and UI notice code, `reconcileExecution`, persistent-session and interactive paths, Codex behavior beyond the decoder, `context-offer.ts`, `CONTEXT.md` and `docs/README.md`. The fit checks use the RFC's own fit statement (line 23).
- **Excluded by instruction:** main's dirty diagnostic patch, account settings, private configuration, raw probe stderr and native transcripts.
- **Git history:** not checked for RFC number allocation.
- **Execution:** no tests, builds or live runs.

This review gives no verdict on whether to implement.

## Driving-session verification

The driving session ran the structural validator against v1. Output:

```json
{
  "passed": true,
  "errors": [],
  "warnings": []
}
```

Reviewed v1 SHA-256: `b3843dc710e62a014e603c3e1ac98759047e2ab2bde694908d5358b76775201a`. The original response and local v1 snapshot are retained in ignored research evidence. The reviewer did not have shell access; execution claims above remain unverified unless separately addressed in the RFC revision notes.

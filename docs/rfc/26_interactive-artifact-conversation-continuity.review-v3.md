# Review: RFC-26 Interactive artifact conversation continuity, v3

## What was reviewed

- Path: `docs/rfc/26_interactive-artifact-conversation-continuity.rfc.md`
- Version: `v3` (frontmatter `version: v3`), status `Review`, type `feature`, dated 2026-09-11.
- Companion: `docs/rfc/26_interactive-artifact-conversation-continuity.review-v2.md` (v2 review, N1-N7) and `.review-v1.md` (F1-F10), both read in full.
- Scope note, per instruction: this review preserves the accepted five-interface scope (Codex CLI, Codex desktop, Claude CLI, Pi CLI, Muse CLI), the finish-current-headless-turn policy, and the required Claude/Pi Lucid reconnect path. It proposes no global coordinator and no product redesign.

Assumption proceeded under: the supplied validator result is quoted verbatim below because this session is read-only and cannot execute the validator.

## Structural results

Supplied validation (author ran `validate-structure.ts` on this exact v3):

```json
{"passed":true,"errors":[],"warnings":[]}
```

Not independently re-executed in this session (read-only tool scope). No structural objection re-derived by hand.

## N1-N7 resolution status (v2 follow-up)

- **N1 (native-ID bound): resolved.** Design 9 line 164 now states native IDs use the existing wire-ID validator "including its 128-character bound," confirmed against `src/protocol/frames.ts:126` (`ID_MAX = 128`). The v2 contradiction (512-byte allowance vs 128-byte validator) is gone. Residual nit only: the trailing clause "an additional 512 UTF-8 byte ceiling cannot widen that validator" is convoluted; deleting it would leave a cleaner sentence. Not a finding. Rung 2.
- **N2 (two-lock rule): resolved.** Lines 176-179 now state the acquisition order explicitly: operations needing both locks "always acquire the registration lock before the record append lock and release them in reverse order," with generation stability plus `stale-registration` refusal on movement, and record-only operations never acquiring a registration lock while holding append. The v2 ambiguity (fresh check vs no-joint-holding) is closed. Rung 2.
- **N3 (presence-acquisition fence): resolved in text, implementation-gated.** Line 214 now specifies "a shared record admission operation around the existing presence lock, including managed workers, manual headless run/resume, interactive listeners, and reconnect," checking control projection, acquiring presence, then rechecking under the append lock before granting a lease. Line 206 transfers presence from reconnect command to matching listener via reservation rather than continuous holding, and line 212 wires `managedCandidates`, the server launch reconciler (`src/server/managed-launch.ts:26-48`), preparation recheck, and per-turn dispatch recheck to the same fence. The v2 gap (fence at dispatch seams but not at lease acquisition) is textually closed; no second lock is added, consistent with ADR-0003. Whether every future entry point routes through the admission operation is implementation work. Rung 2.
- **N4 (projection rows): resolved except one residual, see R1 below.** `headless-running` and `cleanup` now have Design 8 rows (lines 145-146). `closed` still has none.
- **N5 (prototype acceptance): resolved.** Introduction line 19-21 now states the implement instruction "authorizes rendering the resolved decisions using the prototype's presentation," adds "A throwaway prototype is not a durable queue or an integration implementation," and keeps acceptance on the planning resolutions plus per-interface native gates. The v2 waiver risk is gone. Rung 2.
- **N6 (strict-resume vs headless-transport prohibition): resolved.** Line 174 now states "HCN strict-resume validation checks the native ID and folder only; it does not open or continue an interactive interface through headless transport," reconciling with Design 1 line 62. Rung 2.
- **N7 (oracle / update loop): resolved.** Line 212 names the runtime arbiter ("the host's writeConnection and managed preparation transactions serialize reconnect intent against attempt creation") and line 220 names the refresh schedule ("initial load, after each control mutation, and every two seconds while the conversation is visible, cancelling an obsolete request when the conversation changes"). The word "oracle" survives but now labels a named transaction pair rather than an unnamed mechanism. Rung 2.

F1-F10 (v1) remain resolved as recorded in the v2 review; v3 changes none of those dispositions. No cleared question is reopened: every new remark below cites v3-new text.

## New findings from the v3 whole-document sweep

### R1 (minor, residual of N4): `closed` projection state has no Design 8 row and no definition

- Section: Design 9 line 216 (`state` enum) crossed with Design 8 lines 138-152 (evidence/label/action table).
- What is wrong: the enum lists thirteen states including `closed`; twelve map to table rows, but no row covers `closed`, and no section defines what `closed` means (record closed? conversation ended? distinct from "All native owners confirmed gone"?). N4's other two states were fixed; this one was not.
- Consequence: the UI label, message, and action set for `closed` are left to implementer choice, at the exact table whose purpose is to prevent independent browser/CLI inference (line 137).
- Proposed correction: add the `closed` row, or state explicitly that it reuses a neighboring row, with status-only actions.
- Evidence rung: rung 2, whole-document read (enum-to-table comparison). No execution possible in this read-only session.

### R2 (spec gap, minor): subagent exclusion mandates rejection without naming the distinguishing signal

- Section: Design 9 line 174 ("Subagent callbacks cannot register the parent session: adapters MUST reject subagent provenance even where a callback carries the parent's session ID").
- What is wrong: the per-interface table (lines 166-172) names the callback and owner evidence for each interface but no subagent marker or provenance field per interface. When a callback carries the parent's session ID, the RFC gives the adapter nothing to distinguish a subagent callback from the parent's own, so the MUST is untestable as written. The required adapter-test list (line 190: response-before-receipt, cross-offer, stale lifecycle, wrong owner) does not include a subagent case either.
- Consequence: implementers will either skip the rejection (admitting a subagent as the parent session, an unsafe-admission hole) or invent per-interface heuristics that diverge.
- Proposed correction: add the distinguishing subagent signal per interface to the table (or state that the signal is itself an Open-Question acceptance item per lane), and add subagent-provenance rejection to the line-190 adapter-test list.
- Evidence rung: rung 2 for the textual absence (whole-document read plus the five-row table); severity judgment is rung 1.

### R3 (observation, not a blocker): transcript notice vs launch-intent atomicity is unstated

- Section: Design 6 line 114-116 (append the "No interactive session detected..." notice "before native process creation, after the final admission check") crossed with Design 9 line 204 ("Lucid records launch intent before invoking HCN") and State Machine line 52 (notice "bound to a stable launch attempt so replay does not duplicate it").
- What is wrong: the notice and the launch-intended fact are two durable writes with no stated atomicity between them. A crash between the two leaves a notice without intent; recovery retrying "with a new attempt ID" (line 118) would then emit a second notice. This is arguably correct (it is a new attempt), but the RFC never says so.
- Consequence: minor; transcript readers may see two attempt notices for one input across a crash, with no sentence licensing or forbidding it.
- Proposed correction: one sentence stating whether notice and intent share one append transaction or are separate, and that a post-crash retry with a new attempt ID emits a new notice.
- Evidence rung: rung 1 (reading of the assembled ordering); rung 2 for the cited lines.

## Cleared (checked, found sound, not repeated next pass)

- Lock order now explicit (registration before append, reverse release), with generation-stability refusal; consistent with ADR-0003's single-flock discipline (no second lock). Rung 2.
- Offer settlement authority after listener release (line 188): receipt/response commands are narrowly authorized control writers that settle only their recorded offer, acquire no executor lease, and cannot attach sources or renew readiness; repeats are readbacks, not renewed authority (line 192). Consistent with the existing executor-gated `reduceExecution` shape (`src/protocol/execution.ts:319-320`) as an extension, not a contradiction. Rung 2.
- All-entry-point admission (line 214) enumerates managed workers, manual headless run/resume, interactive listeners, and reconnect; unresolved offers admit only their verified settlement commands. Rung 2.
- Complete native hook context: line 190 checks transport limits before offer-started and refuses head/tail preview or output spill as complete delivery; consistent with `docs/drivers.md:86-91` hook-limit rules. Rung 2.
- Five-interface scope with explicit unavailable lanes, finish-current-turn plus cleanup-before-admission, Claude/Pi reconnect requirement with bypass-conflict hold, saved/receipt/outcome separation, unknown-owner hold with no Assume-closed action, no fresh-session fallback, no global coordinator, publication-survives-failed-binding: all still present, unchanged from v2 cleared list. Rung 2.
- Pre-start evidence taxonomy (lines 202-204) still binds to the closed `spawn-not-attempted` / `dispatch-not-called` set against `src/harness/runner.ts:105-110` and `docs/drivers.md:383-388`; HCN operation remains explicitly prerequisite (line 202). Remaining work is the HCN build plus per-interface native acceptance (Open Questions 1-2), which the RFC does not waive. Rung 2.
- Version-2 execution envelope and no-downgrade policy (line 222) unchanged from the v2-corroborated text. Rung 2.

## What was not reviewed

- Validator execution: read-only session; the supplied `{"passed":true,"errors":[],"warnings":[]}` is quoted without re-execution.
- Source structural graph for this worktree: the index covers `main`, not this worktree; all source behavior claims rest on direct file reads cited per finding, and reach beyond the read functions is qualified as untraced.
- Prototype interaction behavior beyond code read (no browser run); native transcript JSON/NDJSON fixtures beyond the two research reports; environment/config credentials and unrelated native transcripts (not read).
- Full test-suite or deterministic-oracle runs; line-level audit of files outside the named sources except where cited.
- Whether the HCN interactive operation or any `lucid connection` command is implemented: the worktree `src` contains no `reconnect`, `resume-listen`, or `offer-started` code paths, which is expected for an RFC preceding implementation and is not itself a finding.

## Verdict for the decision reader

N1, N2, N3, N5, N6, N7 are resolved in text; N4 is resolved except the undefined `closed` row (R1). F1-F10 stand. Two new items attach to v3-new text only: the subagent-rejection signal gap (R2) and the notice/intent atomicity sentence (R3, observation). Nothing in v3 widens scope, drops an interface, promises automatic native conflict handling, or treats the HCN operation or any native lane as shipped; the remaining work is implementation plus the explicitly gated native acceptance lanes.

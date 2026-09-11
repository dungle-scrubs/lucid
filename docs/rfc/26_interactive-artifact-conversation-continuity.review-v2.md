# Review: RFC-26 Interactive artifact conversation continuity, v2

## What was reviewed

- Path: `docs/rfc/26_interactive-artifact-conversation-continuity.rfc.md`
- Version: `v2` (frontmatter `version: v2`), status `Review`, type `feature`, dated 2026-09-11.
- Companion: `docs/rfc/26_interactive-artifact-conversation-continuity.review-v1.md` (the v1 review), read in full. F1-F10 verdicts below.
- Scope note, per instruction: this review preserves the accepted five-interface scope (Codex CLI, Codex desktop, Claude CLI, Pi CLI, Muse CLI), the finish-current-headless-turn policy, and the required Claude/Pi Lucid reconnect path. It proposes no global coordinator and no product redesign.

Assumption proceeded under: the supplied validator result is quoted verbatim below because this session is read-only and cannot execute the validator.

## Structural results

Supplied validation (author ran `validate-structure.ts` on this exact v2):

```json
{"passed":true,"errors":[],"warnings":[]}
```

Not independently re-executed in this session (read-only tool scope). No structural objection re-derived by hand.

## F1-F10 resolution status

- **F1 (receipt path): resolved in text, acceptance-gated.** Design 9 lines 178-188 name `lucid connection receipt` / `respond` with `--offer`, per-interface transport (Stop continuations carry the offer instruction; Pi uses its current-session extension API), explicit no-implicit-receipt rule, and adapter tests that must reject response-before-receipt, cross-offer, stale lifecycle, and wrong owner. Line 188 keeps each adapter unavailable until its lane passes. Remaining work is explicit native acceptance (Open Q2), not specification.
- **F2 (proof of no child): resolved in text, implementation-gated.** Lines 194-198 give the closed pre-start set (`spawn-not-attempted` parsed HCN evidence or Lucid's own pre-invocation `dispatch-not-called`), `launch-uncertain` for everything else, and retention of existing headless `harness-refusal` / `dispatch-not-called` at its seam (consistent with `src/harness/runner.ts:105-110` and `docs/drivers.md:383-388`, rung 2).
- **F3 (registration provenance): resolved in text.** Lines 160-174 give UUID entropy, per-interface ownership table, 0700/0600 filesystem rules, no-HTTP-registration rule, ambiguous-binding refusal, and lock ordering. Two new sub-issues found in this text: N1 and N2 below.
- **F4 (HCN operation): textually resolved, implementation explicitly prerequisite.** Lines 192-196 specify the operation name, argv shape, separated terminal/control channels, `ready`/`refused`/`started`/`closed` records, refusal taxonomy, and the statement that HCN implementation and fixtures precede Lucid use. No reviewer can mistake this for shipped behavior. Remaining work is the HCN build itself.
- **F5 (reconnect fence seam): textually resolved, with one uncovered acquisition path.** Line 206 names the shared seams (`managedCandidates`, server launch reconciler, managed-worker initial check, preparation recheck, per-turn dispatch check) and the deterministic oracle. New sub-issue N3 below covers the presence-acquisition gap.
- **F6 (identity table): resolved in text.** Lines 162-170 table interface, harness, callback, folder, and owner evidence, plus realpath-supplementary and strict-resume rules. N1 qualifies the native-ID bound.
- **F7 (projection schema): resolved in text.** Lines 208-212 give the projection fields, action-ID vocabulary, reason-to-action mapping, HTTP results (200/400/404/409), and uncached read-only probe rules. N4 notes three enum states missing table rows.
- **F8 (migration/downgrade): resolved in text and corroborated.** Line 214 names the `execution` source with `payloadVersion: 2`, the baseline refusal string, unknown-version reporting, retained unknown-source handling, and explicit no-downgrade policy. The baseline claim checks out against current code: `src/store/log.ts:567-570` refuses `payloadVersion !== 1` as `corrupt-log "Unsupported execution payload"`, and the `walk` comment at `log.ts:644-650` confirms unknown sources are carried/skipped (rung 2).
- **F9 (command naming): resolved.** The in-session operation is now `lucid connection resume-listen` (line 178) against the terminal `lucid reconnect` (line 58).
- **F10 (managed envelope term): resolved.** Line 89 uses the existing `managed-input-v1` / `managed: true` vocabulary (matching `docs/skill-chat-substrate.md:198-212`, rung 2).

## New findings from the Design 9 whole-document sweep

### N1 (near-blocker): native-ID bound contradicts the wire-ID validator it invokes

- Section: Design 9, lines 160-161, crossed with Terminology/Design 2 and `src/protocol/frames.ts:126,304-305`.
- What is wrong: "Native IDs are harness-minted, nonempty wire IDs of at most 512 UTF-8 bytes." The existing wire-ID validator caps length at `ID_MAX = 128` and rejects control characters. A 200-byte harness-minted session ID cannot simultaneously be a wire ID and use the 512-byte allowance. UUID registration/action/offer IDs (36 chars) pass; the contradiction bites only native IDs, which are the load-bearing identity in every admission check (Design 6 line 111, Design 7 line 121).
- Consequence: implementers validating a long native ID through `isWireId` will refuse legitimate sessions; implementers honoring 512 will bypass the cited shared validator. Admission behavior diverges per implementer.
- Proposed correction: either cap native IDs at the existing 128-byte wire limit or define a separate native-ID validator with the 512-byte bound and name which validator applies to each ID class in line 160.
- Evidence rung: rung 2, RFC text plus cited source lines. No execution was possible in this read-only session.

### N2 (spec gap): two-lock rule vs the fresh check under the append lock

- Section: Design 9, lines 172-174.
- What is wrong: "No code holds the registration lock and record append lock together" sits beside "records the binding under the record append lock with a fresh owner/lifecycle check." The fresh check needs current registration state. If it re-acquires the registration lock while holding the append lock, both locks are held together (append-to-registration order). If it reuses the released snapshot, it is not fresh against a concurrent lifecycle change, which is exactly the race the sentence claims to close.
- Consequence: the publication/binding crash and concurrent-lifecycle races (Design 2 lines 71-74) get one of two behaviors depending on the reader, and lock-ordering review cannot verify the stated invariant.
- Proposed correction: state whether the fresh check re-reads under the registration lock (and if so, give the acquisition order) or validates from the released snapshot plus a generation comparison, and name the refusal when the generation moved.
- Evidence rung: rung 2 for the textual ambiguity; severity judgment is rung 1.

### N3 (near-blocker): the reservation fence does not cover presence acquisition

- Section: Design 9 lines 200-206 crossed with Design 7 lines 123-129, ADR-0003, `src/cli/runtime.ts:258-273`, `src/store/managed-readiness.ts:28-68`, `src/server/managed-launch.ts:26-48`.
- What is wrong: line 200 releases the presence lock after `started` provenance while the reservation stays held, and line 206 fences workers at candidate selection, preparation, and dispatch. But presence acquisition itself (`acquirePresenceFn` in `runtime.ts`, plus any non-managed `lucid run` entry) does not consult `managedCandidates`, and per ADR-0003 the presence lock elects the executor. During the released interval, and in the gap between headless executor release and waiter re-acquire (lines 123-125), any entrant that acquires presence becomes the executor while the reservation claims the transition is fenced. The fence guards managed dispatch seams, not lease acquisition.
- Consequence: a second executor can hold the lease inside the supposedly fenced window. The "prevents a managed worker from winning the transition gap" claim (line 125) holds only for entrants that pass through the fenced seams.
- Proposed correction: enumerate every presence-acquisition path and state which ones must observe the reservation (refuse or await while a reconnect request, uncertain offer/launch, or conflict exists), or hold presence continuously from intent through attach instead of releasing at `started` provenance. Do not add a second lock (line 83 already forbids it); gate the existing one.
- Evidence rung: rung 2, RFC text plus cited source lines showing acquisition without a reservation check and readiness without a reconnect concept.

### N4 (minor): three projection states have no Design 8 row

- Section: Design 8 lines 137-148 crossed with Design 9 line 208.
- What is wrong: the `state` enum lists `headless-running`, `cleanup`, and `closed`, but the evidence/label/action table has no row for any of them. A reader cannot tell which label, message, or actions the UI shows while a headless turn runs, during cleanup before reconnect admission, or after close.
- Proposed correction: add the three rows or state explicitly that they reuse a neighboring row's label with status-only actions.
- Evidence rung: rung 2, whole-document read.

### N5 (minor): prototype instruction treated as acceptance of prototype semantics

- Section: Introduction line 19.
- What is wrong: "The user's repeated instruction to implement after receiving the prototype is treated as acceptance of its connection states and recovery actions." The prototype is explicitly simulated (prototype line 29) and the v1 review cleared it as corroboration only. Acceptance properly rests on resolutions 257-259 plus the Open Q1/Q2 native gates, which the RFC retains.
- Consequence: a future reader can cite line 19 to waive per-interface native acceptance. That reading contradicts Open Questions lines 277-279 and Implementation Plan line 269.
- Proposed correction: restate line 19 so the prototype instruction authorizes rendering the decisions, while acceptance of connection behavior comes from the planning resolutions and the still-required native lanes.
- Evidence rung: rung 2.

### N6 (observation): strict-resume validation vs the headless-transport prohibition

- Section: Design 9 line 170 crossed with Design 1 line 61.
- What is wrong: line 170 validates interactive native ID and folder "by HCN's strict-resume operation" while line 61 forbids treating "HCN's headless session transport as a native terminal interface." Validation of identity via strict-resume is not the same as transporting the terminal over it, but the RFC never says that, and the existing strict-resume check (`runtime.ts:497-525`) runs `inspect` with a headless profile.
- Proposed correction: one sentence stating line 170 uses strict-resume for ID/folder validation only and never opens or continues the interactive session through the headless path.
- Evidence rung: rung 2. Offered as a clarification, not a blocker.

### N7 (minor): two vague mechanism phrases

- Sections: Design 9 line 206 ("deterministic oracle at this shared seam") and line 212 ("the server's normal update loop refreshes it").
- What is wrong: "oracle" here reads as test vocabulary placed inside a runtime-fence sentence, and the update loop is unnamed, so neither is implementable or testable as written.
- Proposed correction: name the runtime arbiter (function/transaction) for the reconnect-vs-selection race and the server loop (module/interval source) that refreshes status projections.
- Evidence rung: rung 2, textual absence confirmed by whole-document read.

## Source-claim checks requested for this pass

- **Baseline replay:** corroborated. The write path parses via `parseExecutionFact` and reduces via `reduceExecution` (`src/store/conversation-host.ts:692-697`); replay folds through `reduceExecution` (`src/store/log.ts:567-570`). Line 79's "same parser and transition function" matches current discipline, and line 204's single `writeConnection` plus read projection mirrors it. Rung 2.
- **Lock handoff:** no current-code contradiction. `runtime.ts:258-307` holds presence for the source lifetime and releases exactly once; there is no reservation concept in `managed-readiness.ts:28-68`, so lines 123-125 and 200 specify new behavior rather than contradicting old. Coverability of that new behavior is N3. Rung 2.
- **Control action authority:** consistent. Current `writeExecution` funnels raw facts through parser plus executor-gated reducer (`conversation-host.ts:415-435,692-697`); line 204's "command adapters cannot append raw control records" extends the same shape. No second credential or queue is introduced, consistent with ADR-0003 and the resolutions. Rung 2.
- **Hook-delivery drift alleged in F10:** not a contradiction. `readQueuedInputs` excluding inputs with execution entries (`src/modes/interactive-host.ts:115-124`) belongs to the current hook path, which the Motivation (line 41) explicitly says is replaced for registered interactive delivery. Line 89 governs the new listener path. Rung 2.

## Cleared

Checked and found sound, so the next reviewer need not repeat:

- Same-parser replay discipline and the `writeConnection`/projection split (line 79, 204) against the execution write/replay paths cited above. Rung 2.
- Baseline refusal wording for `payloadVersion: 2` and retained unknown-source handling (line 214) against `log.ts:567-570` and the `walk` carried/skipped comment. Rung 2.
- Pre-start evidence taxonomy (line 196) against `SendResult` (`runner.ts:105-110`) and `docs/drivers.md:383-388`. Rung 2.
- Per-interface transport and no-implicit-receipt rules (lines 180-184) against the listener evidence limits and resolution-258 receipt boundaries. Rung 2.
- Five-interface scope retention with explicit unavailable lanes, finish-current-turn plus cleanup-before-admission ordering, Claude/Pi reconnect requirement with bypass-conflict hold, saved/receipt/outcome separation, unknown-owner hold with no Assume-closed action, no fresh-session fallback, and no global coordinator, per the v1 cleared list, all still present in v2 text. Rung 2.

## What was not reviewed

- Validator execution: read-only session; the supplied `{"passed":true,"errors":[],"warnings":[]}` is quoted without re-execution.
- Source structural graph for this worktree: the index covers `main`, not this worktree; all source behavior claims rest on direct file reads cited per finding, and reach beyond the read functions is qualified as untraced.
- Prototype interaction behavior beyond code read (no browser run); native transcript JSON/NDJSON fixtures beyond the two research reports; environment/config credentials and unrelated native transcripts (not read).
- Full test-suite or deterministic-oracle runs; line-level audit of files outside the named sources except where cited.
- Whether the HCN interactive operation or any `lucid connection` command is implemented: the worktree `src` contains no `reconnect`, `resume-listen`, `launch-intended`, or `offer-started` code paths (searched, result reported), which is expected for an RFC preceding implementation and is not itself a finding.

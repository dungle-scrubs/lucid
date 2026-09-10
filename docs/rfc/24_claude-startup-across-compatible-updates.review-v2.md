# Review of RFC 24 v2: Claude startup across compatible updates

Save as `docs/rfc/24_claude-startup-across-compatible-updates.review-v2.md`.

## What was reviewed

- **RFC:** `docs/rfc/24_claude-startup-across-compatible-updates.rfc.md` (untracked) in worktree `artifacts/worktrees/claude-startup-plan`. Branch `docs/claude-startup-contract-20260910`, base `61733ba`.
- **Version:** v2. **Status:** Draft. **Type:** protocol. **Author:** Codex. **Date:** 2026-09-10.
- **Reviewer:** Claude Opus 5 (`claude-opus-5`) in the Claude Code harness, run headless through hcn. One pass, read-only. No subagents, delegation or model tasks. Codex wrote the RFC, so the review is cross-family.
- **Scope:** only what changed from v1. For each of F1-F12 in `...review-v1.md`: does the v2 revision resolve it, and do the revisions conflict with each other or with the rest of the document? v1 source evidence is used as reported.
- **Read in full:** the RFC and the v1 review.
- **Source read for this pass, only for claims still open:**
  - `src/store/managed-readiness.ts`
  - `src/modes/context-preparation.ts`
  - `src/modes/managed-preparation.ts:84-132`
  - E-HUB-06 matches in `src`
  - `docs/drivers.md` matches for E-HUB codes and "fresh"
  - `docs/rfc/README.md` index lines
- **Evidence levels:** from `~/.agents/skills/blast-radius/references/EVIDENCE-LADDER.md`. Nothing was run.

## Structural results

The driving session ran the validator after the v2 edits. This is its execution and its output, not a run by this reviewer:

```json
{
  "passed": true,
  "errors": [],
  "warnings": []
}
```

## Findings

Severity follows v1:
- **High:** the central claim fails in a common flow.
- **Medium:** statements conflict, or a gap lets a wrong implementation pass.
- **Low:** a gap in precision or completeness.

### R1 (Medium): the RFC names no exit from a capacity hold on a same-session tail

**Lands in:**
- Lucid preparation selection (lines 72, 80)
- State Machine (line 119)
- Error Handling (line 139)
- Regression evidence required: Continuation and Existing holds rows (lines 172, 175)

**Problem.** Line 72 now sends three same-session cases to bounded preparation, and says they "can retain the full-session hold":
- output from a turn that had input queued during it
- partial output from a failed attempt
- an earlier held input

In current Lucid, that hold has only one action, and that action repeats the hold:
- **How the hold arises:** bounded preparation that cannot fit throws `ContextPreparationError` (`context-preparation.ts:289-291`). That becomes E-HUB-06 (`managed-preparation.ts:376-379`; `docs/drivers.md:341-342`).
- **Its only action is `retry`.** An E-HUB-06 hold gets `["retry"]` by default (`managed-preparation.ts:114-120`).
- **It never wakes.** Only E-HUB-03 and E-HUB-04 holds wake (`managed-readiness.ts:62-66`).
- **Fresh continuation is not offered.** It is available only for "a native identity or resume hold" (`docs/drivers.md:367`).
- **Retry repeats it.** Retry takes a new capture. The unconfirmed history is still there, and no native turn has run to lower occupancy.
- **Later inputs repeat it too.** A later input captures the held input as history (v1 F1 evidence), so it takes the same route.

Two sentences describe this remaining limitation as narrower than line 72:
- Line 139: "A full-session transfer can hold again".
- Line 80: "A transfer into a full native session".

Line 139 then mentions fresh continuation only for failed or uncertain attempts.

**Consequence.** Lines 100 and 133 predict a native failure near capacity, such as failed or disabled compaction. After that failure, the product offers a Retry that can hold again for the same reason. Neither the RFC nor any regression row says which existing action leaves this state, or that none does. An implementer cannot tell whether a stuck session is intended. The implementer might add a fresh or replacement action, which line 25 puts out of scope.

**What is needed.** State the recovery that exists for this hold. If none exists in that native session, say so, and add a matching test. This finding does not ask for inferred native coverage or discarded history. Adding a recovery action would be a scope decision for the user.

**Evidence level:** 3 for the combined outcome (traced, not run). Level 2 for each step.

### R2 (Low): the RFC does not state what a frame outside the table does to the bounded route

**Lands in:**
- HCN Claude operation authority (line 62)
- Error Handling (line 131)
- Versioning (line 151)

**Problem.** Line 62 says ordinary native startup does not depend on accounting. That is true only for turns with no imported history. Every other turn needs an available count. An unavailable count with any reason except `unsupported-adapter`, `unverified-adapter` or `model-divergence` becomes E-HUB-06 (`context-preparation.ts:34-48`), and that hold has only `retry` (see R1).

Suppose a compatible Claude release emits an unclassified top-level frame or `system` subtype during inspection. Then every imported-history turn holds with E-HUB-06 until an HCN adapter release and an explicit Retry. Line 72 widened that set of turns in v2.

Line 151 says Claude updates need "no further HCN release merely because the version changed". That is accurate, but no sentence states the case above, where an update fails for a reason other than the version.

**Consequence.** Users see a hold that reads like a capacity failure, and the RFC gives no expected diagnostic or recovery for it. The fail-closed policy itself is the approved scope. The consequence is not written down.

**Evidence level:** 2 for the mechanism. Level 1 for whether any Claude release emits such a frame; this was not checked.

### R3 (Low): the guard-order sentence conflicts with selecting the native route without a count

**Lands in:**
- State Machine (line 104, row at line 109)
- Lucid preparation selection (lines 70, 76)
- Regression evidence required: Ordinary startup row (line 171)

**Problem.** Line 104 says the preparation guards run before either route-selection row. Row 109 lists "unavailable bounded preparation" as one of those guards. That condition only exists after row 111 has chosen the bounded route. Read literally, the order runs accounting before choosing the native route. That conflicts with:
- line 76: no occupancy count before native dispatch
- line 70: never infer eligibility from a failed accounting operation

**Consequence.** An implementation that follows the order literally repeats the observed startup hold (line 21) whenever accounting is unavailable. The line 171 test would catch it.

**Evidence level:** 2 (document text).

### R4 (Low): the inspection-frame table is imprecise, and positive tests are missing

**Lands in:**
- HCN Claude operation authority, table rows at lines 55 and 60
- Regression evidence required: Accounting row (line 170)

**Problem.**
- **`command_lifecycle` has an unclear place.** It follows a semicolon after the `system` subtypes. It could be a top-level frame type or a `system` subtype. Line 60 rejects whichever reading an implementation does not adopt.
- **"Existing explicit startup failure signals" has no frame-level referent.** The RFC does not list them. v1 reported that the current interpreter ignores frames that do not match (`interpretation/context-inspection.ts:137-167`). Line 131 covers failures only at the operation level.
- **Line 170 lists only negative shapes.** It has no positive control that permitted lifecycle frames pass, both before and after usage. Line 143 keeps real accounting settings, so a user's configured hooks run in the real exchange. It also has no separate cases for:
  - a missing or non-numeric `num_turns`
  - an unknown `system` subtype, as distinct from an unknown top-level frame

**Consequence.** A guard that rejects hook frames passes every listed test. That guard holds every imported-history turn for users who have hooks configured.

**Evidence level:** 2.

### R5 (Low): "fail" and "retain bounded preparation" describe the same decoder case differently

**Lands in:** Message Formats (lines 92, 100); Versioning (line 151).

**Problem.** The two lines describe the same case differently:
- **Line 92:** an unrecognized declaration gives "No native authorization; retain bounded preparation and its operation-specific failure".
- **Line 100:** a decoder that cannot recognize the new kind "MUST fail through its existing inspection/preparation path".

v1 recorded that the old decoder turns an unknown kind into no native flag, then bounded preparation. "Fail" can be read as a hold for older Lucid. That reading contradicts line 151 ("safe refusal/preparation behavior") and the rationale at line 153. Line 92's "and its operation-specific failure" can also be read as the declaration itself causing a failure.

**Evidence level:** 2 (document text).

### R6 (Low): the Abstract is harness-wide, and the scoping rule has no HCN test

**Lands in:**
- Abstract (line 15)
- HCN Claude operation authority (line 43)
- Versioning (line 149)
- Regression evidence required: Compatibility row (line 176)

**Problem.**
- **The Abstract is wider than the body.** It says "HCN will judge each operation by its contract and result" without the Claude scope. Lines 43 and 149 apply that scope.
- **Line 43's rule has no test.** Line 43 requires shared-helper changes to keep other harnesses' admission policy. v1 reported the version-equality verdict as one shared function (`runtime-compatibility.ts:40`). Line 176 tests only Lucid's Codex and persistent-session paths. No HCN deterministic requirement shows that Codex, pi and Muse resume admission is unchanged after the helper changes.

**Evidence level:** 2.

## Dispositions of F1-F12

| Finding | Disposition in v2 |
| --- | --- |
| F1 | Resolved as a disclosure within the approved scope (lines 33, 72, 172). The exit from the resulting hold is still open: R1. |
| F2 | Resolved (lines 43, 45, 91, 149). A remaining wording issue and a missing test: R6. |
| F3 | Resolved on all four v1 items: frame classification (lines 51-60), provisional usage until settlement (line 49), zero-turn success regardless of usage (line 56), negative tests (line 170). Precision and positive tests remain: R4. Bounded-route consequence remains: R2. |
| F4 | Resolved (lines 119, 139, 175). Checked against source: E-HUB-03 has `change-settings` and `retry` for `unverified-adapter` (`context-preparation.ts:45`). E-HUB-03 wakes on settings, folder or native session, and E-HUB-04 wakes on folder (`managed-readiness.ts:20-23`, `62-66`). E-HUB-06 needs an explicit Retry. |
| F5, F6, F7, F9, F11 | Resolved (lines 151 and 161; 98; 100; 76 and 172; 137). F6 wording remains: R5. |
| F8 | Resolved as a disclosure (lines 100, 133). Its combination with F1 feeds R1. |
| F10 | Resolved: missing outcome at line 114, wake rules at line 119. The new ordering sentence introduces R3. |
| F12 | Resolved. The term is used (lines 31, 43). `docs/rfc/README.md:3,5,36` records RFC 24 and names 25 as next. It also says RFC 23 is allocated on a separate branch. The Git-history check for RFC 23 is supplied by the driving session; this reviewer did not run it. |

## Cleared

- **Two meanings of `resume.status`.** For Claude it means invocation support. For other harnesses it keeps version equality (lines 43, 45, 93). v1 reported that Lucid reads `supported` only as permission to try a resume (`managed-preparation.ts:265-271`). Both meanings allow that, so the two do not conflict for the consumer. Level 2.
- **Mode rules for the two kinds.** The exact-mode rule for the new kind (line 98) and the unchanged superset rule for the existing kind do not conflict with "only known kind/mode combinations" (line 100).
- **Zero-turn success with nonzero usage.** Lines 49, 56 and 170 and the F3 disposition agree.
- **Model agreement.** Lines 64, 76 and 78 agree: checks apply on the bounded route and are not measured on the native route.
- **Hold versus `pre-start-failed`.** Line 37 and row 114 agree.
- **Bounded-route failure codes.** Using E-HUB-06 for failures other than adapter support matches `docs/drivers.md:341-342`.
- **Single integration.** Handoff step 2 (no Lucid release) agrees with step 3 and with line 151.
- **No version fields.** No version field returns to Lucid (line 100). This is consistent with AGENTS.md: Lucid does not probe, compare or gate on HCN or harness versions.
- **Disposition-section preface.** Line 182 describes v1's method and the validator run correctly.

## Not reviewed

- **Structural validator:** not run by this reviewer. The output above was supplied by the driving session.
- **Sections without v2 changes:** read only to check consistency. The earlier research was not repeated.
- **HCN source:** not reopened. HCN claims rest on the evidence reported in v1.
- **External material:** research documents, immutable links, issue #149 and official Claude documentation were not fetched.
- **Claude inspection frames:** whether any current or future Claude build emits frames outside the table was not checked.
- **codebase-memory coverage:** no `check_index_coverage` calls were made. No conclusion relies on graph results or on something being absent. Grep results are cited only as literal matches.
- **Excluded by instruction:** account settings, private configuration, native transcripts and raw probe stderr.
- **Execution:** no tests, builds or live runs.

This review gives no verdict on implementation or acceptance.

Reviewed v2 SHA-256: `000aa5043c3416acc05a6094cdf3da62d522ba5f8bfb2279c3cebc68df84f2ba`.

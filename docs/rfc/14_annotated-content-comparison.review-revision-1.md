# Review: RFC 14, revision 1

## What was reviewed

- RFC: [Annotated content comparison](14_annotated-content-comparison.rfc.md), **Draft, revision 1**, dated 2026-09-07, authored by Codex.
- SHA-256: `4ac9a3ba6f9d7576407c214c0ec0458f952e01a49b1c709bb77071a882bc8f5b`.
- Previous report: [unversioned-draft review](14_annotated-content-comparison.review-unversioned.md). The entire revised RFC was read, including its response to that review.
- Independent reviewer: **opus-5@claude**, selected with the author's OpenAI family excluded. The hcn/delegate run completed with `status: ok`, `actual: opus-5@claude`, session `4a04f87d-81f6-457b-ac23-7bb45c077e16`.
- Codex checked the returned findings against the specification and source, and added the recovery and presentation findings below. The disposition of every independent finding is recorded after the findings. The RFC and implementation tickets were not edited.

This is a specification review, not a production implementation review. Each retained finding is **rung 2: source/specification evidence**, not an executable reproduction. The existing test suite passing does not prove the proposed behavior.

## Structural results

Command:

```sh
bun /Users/kevin/.agents/skills/draft-rfc/scripts/validate-structure.ts docs/rfc/14_annotated-content-comparison.rfc.md
```

Output, verbatim:

```json
{
  "passed": true,
  "errors": [],
  "warnings": []
}
```

The primary reviewer also ran `bun run check`: lint and typechecks passed; **1,035 tests passed, 0 failed, 5,129 assertions**. This checks the current working tree, which includes unrelated changes. It is not implementation evidence for RFC 14.

## Findings

### F1. Restart reconciliation does not cover the required authentication reload

**Severity: major. Evidence: rung 2, not reproduced against an implementation.** Added during primary verification.

**Location:** RFC lines 99 and 134-136, Inline note entry and Repeat-safe browser submission; Security Considerations line 214. Supporting contract: `docs/artifacts.md:133-137`; source: `src/server/server.ts:204-207`, `src/server/client/app.tsx:2207-2210` and `:3902-3910`.

The RFC requires the browser to retain the exact request ID and payload until its outcome is known, and says reconciliation works after server restart. The existing browser boundary invalidates the page token on restart and requires a reload. The RFC discusses reconstructing accepted notes after reload and excludes general draft persistence, but does not define how an uncertain submitted request survives that required reload.

Consider an accepted send whose response is lost, followed by a server restart. Resubmission from the existing page receives 401. Reload restores authentication but needs the original ID and payload to reconcile the uncertain operation. Reading accepted notes from the log does not define how the browser identifies its request, especially when similar notes exist. The same reload path must also preserve a request that never reached acceptance.

**Required clarification:** distinguish an unsent draft from a submitted request awaiting a result. Specify how the latter's conversation, ID, and exact payload survive the authentication reload, and when they are cleared. Alternatively, explicitly change the authentication recovery contract to allow recovery without losing that state. Add this combined failure sequence to slice 1's verification. General draft persistence need not be added.

### F2. The held-input state has no disposition or queue-order contract

**Severity: major. Evidence: rung 2, not an observed delivery failure.** Retains independent finding R3, with its runtime claims narrowed.

**Location:** RFC lines 148-150 and the Accepted input / Held input rows in State Machine. Supporting contract: `docs/skill-chat-substrate.md`, Receiving input and Input replay; source: `src/modes/host.ts:969-970` and `:1171-1172`.

Revision 1 defines a useful recovery rule: stop retrying within the current participation until newer readable content or explicit reattachment after recovery. It does not bind that state to the existing `applied`, `queued`, and `rejected` disposition vocabulary. It forbids application and immediate redelivery but does not say whether preparation failure emits `queued` or leaves the last disposition unchanged.

That choice affects the durable transcript and delivery state. The RFC also leaves unspecified whether a held comparison input blocks later ordinary queue inputs or can be bypassed. A later ordinary turn could create the newer version that releases the hold, so this affects observable recovery behavior, not only internal naming. The present headless-turn path records `queued` before preparation and later records `applied` when its turn starts; the new contract needs to state how a hold fits that progression.

**Required clarification:** name the disposition, or its deliberate absence, on entering a hold; define the treatment of later queued inputs; and name the transition on successful recovery. Distinguish replay delivery from permission to try preparation again within the same participation. Keep the existing prohibition on timer retries and automatic takeover. Verify the transcript and input identity across failure, a later input, recovery, and reattachment.

### F3. Refresh can remove the unsent draft's source from both displayed sides

**Severity: minor. Evidence: rung 2, a specification state gap, not a reproduced lost draft.** Added during primary verification.

**Location:** RFC lines 89, 118, and 142-144; Stale comparison / Review newer version in State Machine.

The inline editor must sit beneath its selected source. Refresh must preserve that source even when it is no longer in the displayed pair. The submitted-note rule explains that the transcript keeps the historical quote when no source marker can be displayed. An unsent draft has no transcript entry yet.

For example, write a note on the current v17 side of a v12/v17 comparison, then review v18, where that passage was removed. The comparison now shows v12/v18 while the draft still quotes v17. The data rule preserves the quote, but no rule says where the editor stays, how it remains reachable, or what happens to focus. Moving it beneath a guessed v18 match would violate the source-preservation rule.

**Required clarification:** define a visible place for a draft whose source has left the pair, with its original version label and quote. A retained source excerpt with the same small editor is one option. Specify focus and Send/Cancel behavior for this state and verify it in both layouts. This does not require a transcript inside the diff.

### F4. “Conflicting ordinary queue” does not identify which queue blocks a send

**Severity: minor. Evidence: rung 2, not a reproduced queue collision.** Retains independent finding R5.

**Location:** RFC lines 60 and 95. Supporting source: `src/protocol/annotations.ts:60-68`.

The entry guard covers pending ordinary notes “in this view.” Ordinary note queues belong to an artifact and a version, and survive moving between versions. The send rule requires a “conflicting ordinary queue” to be resolved, but does not define whether that means a queue on the selected source version, either displayed version, or any version of the artifact.

A pending ordinary v12 queue can exist while a person enters comparison from v17 and selects v12 content. One implementation can block that comparison send; another can keep the ordinary queue intact and submit a separate v12 input. The no-flush/no-mixing requirements already prevent silent merging, but do not choose between those behaviors.

**Required clarification:** define the exact queue key or keys that conflict and whether the check occurs on entry, source selection, or Send. State that unrelated queues remain intact. This is a guard definition, not a reason to combine note batches.

### F5. Unexamined source changes are disclosed only when all supported text is equal

**Severity: minor. Evidence: rung 2, a coverage-rule gap, not a demonstrated renderer omission.** Added during primary verification.

**Location:** RFC line 73, Readable changes; line 85, proposed non-text behavior; Open Question 1 at line 241.

The retained-source comparison closes the earlier equal-text gap. Its explicit disclosure is conditional on supported text being equal. It does not define the corresponding result when text and unexamined source both change.

For example, a saved revision changes a paragraph and a stylesheet rule. The paragraph appears in the content diff, so the equal-text condition is false. Styles are not compared by the supported text model, and the proposed whole-section list does not specify stylesheet treatment. Open Question 1 requires a fallback that does not hide unexamined changes, but this mixed case has no stated disclosure rule.

**Required clarification:** define how the comparison reports unexamined source when supported text also changes. A general text-comparison coverage notice with saved-version inspection can satisfy this without adding detailed style or non-text diffing. Include one mixed-change fixture. The user's non-text scope decision remains pending.

## Disposition of the independent review

The independent reviewer returned six findings. Its original response and run metadata are retained as ignored execution evidence at `artifacts/evidence/rfc14-review/report-r1.json`. They are not current product instructions.

| Independent finding | Verification result |
|---|---|
| R1: comparison spot ID is undefined, blocking | **Not retained as a blocker.** The RFC requires an address in the immutable source and forbids diff-wrapper IDs. Existing instrumentation assigns `e1`, `e2`, etc. in source-document order (`src/server/client/instrument.ts:473-479`) and removes them on save (`:603-605`). Reconstructing that source address before filtering is a possible implementation consistent with the stated contract. The review's claim that the encoding cannot be built as written is too strong. Source-address reconstruction and reload tests remain required. |
| R2: interactive hooks can never produce the required revision | **Not retained as stated.** `docs/artifacts.md:10-12` does describe the current lack of emission teaching, but the RFC expressly adds adapter context and preamble obligations at lines 128 and 146-148 and requires changed contracts to be updated in slice 3. Absence of the new teaching today does not prove that the proposed path can never revise an artifact. Implementation review must verify that hooks receive the required emission teaching as well as source and current-content context, or hold delivery under the stated capability rule. |
| R3: held input has no disposition binding | **Retained as F2.** Added the related observable queue-order question. No claim of an inevitable retry loop is made: the RFC already forbids one within a participation. |
| R4: the existing snippet helper destroys preformatted evidence | **Not retained as an RFC contradiction.** `clampSnippet` does collapse whitespace (`src/protocol/annotations.ts:136-138`), but line 124 preserves the limit, not mandatory reuse of that helper. Lines 77 and 79 explicitly require preservation of source text and significant preformatted whitespace. Implementation must meet those requirements; unchanged helper reuse would fail them. |
| R5: conflicting ordinary queue is undefined | **Retained as F4.** The requirement prevents mixing but leaves the blocking condition open. |
| R6: following documentation is not scheduled for amendment | **Not retained.** Slice 2's requirement to update the current comparison contract covers the comparison-open following rule as well as the visual presentation. It need not enumerate every affected sentence to require an accurate contract update. |

## Cleared

- **Version authority:** source, reviewed, and dispatch versions have distinct meanings. Batch `version` retains historical source association. Dispatch supplies the sole `replaces` target and cannot precede the reviewed version. This resolves prior F2, F8, and F10 at the specification level.
- **Repeat-safe acceptance:** stable browser IDs, exact-payload comparison, accepted-receipt precedence over freshness/capacity, and accepted-history lookup resolve prior F1's server-side ordering gap. F1 above concerns the additional browser authentication-reload sequence.
- **Full current context:** line 146 explicitly overrides the current conditional byte inclusion at `src/modes/host.ts:116`. Missing-context failure has a code and recovery trigger. The remaining lifecycle issue is F2 above.
- **Pending edits and source provenance:** entry guards distinguish saved comparison evidence from ordinary current-edited-text capture. Comparison inputs carry one note, one source version, and a defined discriminator. Admission validation is separated from tolerant stored rendering. Prior F4, the encoding portion of F5, and F9 are resolved.
- **Frozen pair and historical references:** new versions mark the comparison stale even without a draft. Cancel and Send from stale have specified outcomes. Historical spots are excluded from inappropriate current-document re-anchoring. Prior F6 and F12 are resolved; the unsent draft's placement after refresh remains F3 above.
- **Unsupported and coarse states:** the state table covers both error codes and the equal-supported-text/unequal-source case. The named 4,000,000-cell budget exists at `src/server/client/line-diff.ts:31`. Prior F7 is resolved for the cases it identified; mixed coverage is F5 above.
- **Input mode and rollout:** sends use `queue`, and changed contracts are updated with their implementation slices. Prior F11 and F13 are resolved.
- **Product boundaries:** inline note entry stays local to the source; the transcript stays separate; no selective reverse patch, extra artifact, automatic new tab, or simulated production delivery is introduced.
- **Security and history:** the RFC requires inert comparison rendering, existing authenticated sandbox inspection, source validation, bounded work, and immutable revisions. These agree with the artifact contract and ADR 0007. The hash definition agrees with `src/store/log.ts:216-217`.
- **Open decisions:** the text-focused non-text fallback is still a recommendation awaiting the user. Extraction reuse is subject to the specified fixtures. Neither is recorded as approved or as implemented.

## Not reviewed

- **Production comparison behavior:** it is not implemented in the reviewed proposal. No browser reproduction, live-harness confirmation, new-feature recovery test, or visual acceptance was performed. No finding reaches rung 4 or 5.
- **Complete structural coverage:** codebase-memory `list_projects` and `check_index_coverage` could not run because its CLI reported a pre-coordination or unverified generation already active. Direct source reads were used. There is no exhaustive caller, adapter, or index-coverage claim.
- **All interactive hook and lifecycle internals:** the review checks their current documented contracts and the relevant headless context/disposition source, not every hook implementation. The independent review's stronger claim of inevitable interactive failure is not adopted.
- **Algorithm selection and performance:** the existing extraction and budget definitions were inspected, but repeated-text, move, source-identity, and large-document behavior were not independently exercised for the proposed model. Passing existing tests does not settle Open Question 2.
- **Prototype and design verification:** the prototype commit and approval are treated as the settled interaction input. Breakpoints, both themes, keyboard behavior, focus transitions, and accessibility need production verification.
- **Whether to build or expand scope:** this report does not decide that. It records the remaining specification gaps and the evidence behind them.

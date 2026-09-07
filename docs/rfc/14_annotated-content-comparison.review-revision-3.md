# Review: RFC 14, revision 3

## What was reviewed

- RFC: [Annotated content comparison](14_annotated-content-comparison.rfc.md), **Review, revision 3**, dated 2026-09-07, authored by Codex.
- SHA-256: `828a5cdc222c2ac57bd3a001c8350824d62a16d591384040185617a8f8cd14a4`.
- Independent reviewer: **opus-5@claude**, selected with the author's OpenAI family excluded. The delegate/hcn run completed with `status: ok`, `actual: opus-5@claude`, session `7184ae88-a876-4e2f-966f-4878e5ea5688`.
- The independent reviewer read the entire RFC, the [revision-1 review](14_annotated-content-comparison.review-revision-1.md), and these contracts in full: `CONTEXT.md`, `docs/artifacts.md`, `docs/drivers.md`, `docs/skill-chat-substrate.md`, and `docs/adr/0007-document-edits-preserve-evidence.md`.
- Codex verified the returned findings against the RFC and inspected the input-capacity source and existing test. All four independent findings have a disposition below.

The user's text-focused first-release approval was recorded before review. Revision 3 was then frozen. This report does not revise it or reopen that scope decision.

This is a specification review. **One minor finding remains; no blocking finding was retained after verification.** It is not a verdict on whether to build or evidence that the proposed behavior works.

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

`bun run check` passed: lint and typechecks passed; **1,035 tests passed, 0 failed, 5,129 assertions**, across 73 test files. This validates the current working tree, which includes unrelated changes. It does not validate the unimplemented comparison feature.

The primary reviewer also ran the existing capacity test to check independent finding R1:

```sh
bun test test/protocol/reducer.test.ts -t 'rises on the applied disposition'
```

Result: **1 passed, 0 failed, 9 assertions**. The test proves that enqueue and `queued` do not increase the current in-flight gauge; `applied` does. This is execution evidence for the existing gauge, not the proposed held-input implementation.

## Findings

### F1. The fixed queued-status text does not describe every hold cause

**Severity: minor. Evidence: rung 2, specification text. Not an observed UI failure.** Retains independent finding R2 with its claim narrowed.

**Location:** RFC lines 166-168, Current content and restoration; `E-COMP-07` in Error Codes at line 245. Recovery is specified at line 172.

The RFC allows an accepted comparison note to wait because current content is unavailable, the delivery adapter cannot supply the required context, or the document exceeds that adapter's transport limit. It prescribes the same queued label, "Waiting for current content", for the hold. That label is misleading when the current document is already readable and the failure is delivery capability or size.

For example, an observe-only attachment can have readable current content and still be unable to deliver the comparison note. Waiting for more content does not explain the limitation. The RFC already requires reporting the limitation and a bounded nonterminal error, so the defect is the fixed status label, not a complete absence of error information or recovery.

**Required correction:** make the queued explanation reflect the failed condition: unavailable current content, unsupported comparison delivery, or a document that exceeds the delivery limit. Keep the accepted input pending and identify an applicable recovery action. The existing explicit-attachment recovery attempt remains available; no new resume button, automatic takeover, cancellation, or timer retry is required. Verify these distinct explanations in slice 3.

## Disposition of the independent findings

The independent reviewer supplied four specification-level findings. Their identifiers here are R1-R4 to distinguish them from the retained finding above.

| Independent finding | Disposition | Verification and reason |
| --- | --- | --- |
| R1, major: eight held notes consume the in-flight bound and prevent ordinary recovery input | **Not retained: incorrect premise.** | RFC line 168 forbids `applied` during a preparation hold. `src/protocol/reducer.ts:936-940` gates admission on `inFlightInputs`, not the number of queued notes. `src/protocol/ledgers/input.ts`, `atCapacity` and `inputDelivered`, confirms that distinction. The executed test at `test/protocol/reducer.test.ts:1146-1182` proves enqueue and `queued` leave the gauge at zero and delivery raises it. The proposed eight-hold counterexample therefore does not establish saturation of this bound. Rung 4 evidence applies to this existing gauge behavior only. No new hold quota or abandonment feature follows from this finding. |
| R2, minor: "Waiting for current content" misdescribes capability and size failures | **Retained as F1, narrowed.** | The fixed label can contradict the cause. The RFC already requires an error and limitation report, and line 172 already permits recovery on explicit attachment. The report does not retain the claim that this label is the only explanation or that recovery is absent. |
| R3, minor: a well-formed uncertain send has no discard action after repeated transport failure | **Not retained as a defect demonstrated by this example.** | Lines 148-152 intentionally preserve the original identity until its outcome is known and provide explicit Retry and authentication Reload. The counterexample stops the server and moves the record directory; discarding browser state would not make a new send to that unavailable conversation work. Prohibiting a replacement identity while acceptance is uncertain is the specified repeat-safety rule. A broader abandonment policy would be another product choice, not a correction established by this counterexample. |
| R4, minor: different byte hashes contradict "No saved-content changes" after normalization | **Not retained: version identity and compared content are different claims.** | Line 41 defines the full hash for version identity. Line 77 explicitly defines comparison after removing Lucid instrumentation and normalizing line endings. Different saved versions can have equal content under that comparison. The notice does not claim equal hashes or identical stored bytes. A CRLF-only example does not establish a contradiction requiring a byte-diff feature or implementation details in the notice. |

## Cleared

The five retained findings in the revision-1 review are resolved at the specification level:

- **Prior F1, restart and authentication recovery:** lines 148-152 require storage and readback before sending, retention across 401 and same-origin reload, explicit Retry with the same ID and payload, and cleanup after a known result. Reload alone cannot resend. The state table covers the recovery branches.
- **Prior F2, held-input disposition and queue order:** lines 168-174 name durable `queued`, forbid `applied` on preparation failure, allow eligible inputs past a hold, preserve original acceptance order and input identity, and define bounded recovery attempts without timer retries.
- **Prior F3, draft source leaves both displayed versions:** line 160 retains the source excerpt and note editor above the passage rows with its original version label. Explicit review preserves focus and selection; automatic arrival does not move focus.
- **Prior F4, ordinary annotation-queue conflict:** line 103 defines the exact page-local `(conversationId, artifactId, sourceVersion)` key, checks each fresh Send, preserves unrelated queues, and exempts reconciliation of an existing request.
- **Prior F5, mixed text and unexamined source changes:** line 79 requires a coverage notice whenever supported text differs, including mixed changes, while preserving saved-version inspection. Slice 2 requires the mixed fixture.

The structural validator found no errors or warnings. The independent whole-document pass found the terminology, state machine, error table, references, and slice plan present and cross-referenced, with error-code use matching the table.

## Not reviewed

- **Production comparison behavior:** the feature is proposed. Extraction, matching, performance, responsive presentation, keyboard behavior, focus restoration, themes, accessibility, and live-harness delivery require implementation verification.
- **Exhaustive code structure:** codebase-memory coverage checks were unavailable because another incompatible or unverified graph generation was active. Direct source and test reads support only the bounded capacity conclusion above; no exhaustive caller or dependency coverage is claimed.
- **All other existing source behavior:** the independent reviewer read no source and ran no tests. The primary source/test verification does not establish every adapter's future held-input behavior.
- **The original unversioned review:** its dispositions were read through the RFC and revision-1 report, rather than rereviewing that historical report in full.
- **Other documentation and implementation-ticket consistency:** the independent review covered only the named contracts. Ticket alignment with the current RFC remains work before implementation.
- **Whether to build:** this report identifies specification defects. It does not mark the RFC Accepted or authorize implementation.

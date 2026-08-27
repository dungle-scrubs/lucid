# Review of RFC-09, draft of 2026-08-27

Reviewer: `gpt-5.6-sol@codex`, routed by `choose-model` with
`excludeFamilies: ["claude"]` because the RFC's author is Claude.

Two things about the routing belong in the record.

The registry's first choice was `muse-spark-1.2-contributor@muse`. It could
not read any file: its `read_file`, `search` and `bash` tools all failed on a
type mismatch, and it asked a question rather than reviewing. That is not one
of hcn's typed failures, so the walk did not advance on its own and the
fallback was taken by hand.

The registry also warned that no candidate meets the high-stakes minimums for
`code-review` once Claude is excluded (intelligence >= 9, taste >= 8), and
returned the most capable survivor. So this review was below the bar it was
asked to clear, and its findings were verified rather than taken.

Three were checked directly before any of them was acted on: F-01 (E-ART-04
is `queue-full`, not a retirement error), F-03 (RFC-06 permits an unknown id
with a non-null `replaces`), and F-09 (`quoteForRefusal` bounds UTF-16 code
units, not bytes: 128 characters of a 3-byte code point quote to 386 bytes).
All three hold.

---

# What was reviewed

- Subject: [RFC-09](/Users/kevin/dev/lucid-v2/docs/rfc/09_one-artifact-per-conversation.rfc.md:1)
- Version: No explicit version field
- Snapshot date: 2026-08-27
- Status: Draft

## Structural results

```json
{
  "passed": true,
  "errors": [],
  "warnings": []
}
```

## Findings

### F-01: RFC-09 withdraws `E-ART-04`, but `E-ART-04` does not belong to retirement

**Lands in:** R4 and Error Handling.

[RFC-09](/Users/kevin/dev/lucid-v2/docs/rfc/09_one-artifact-per-conversation.rfc.md:246) says `E-ART-04` is withdrawn with R12. [RFC-07](/Users/kevin/dev/lucid-v2/docs/rfc/07_many-artifacts-in-one-record-and-the-history-you-can-move-through.rfc.md:693) defines `E-ART-04` as the annotation queue-full error. R10 defines that limit independently at line 391.

The implementation still enforces `NOTE_QUEUE_MAX` in [annotations.ts](/Users/kevin/dev/lucid-v2/src/protocol/annotations.ts:57) and [app.tsx](/Users/kevin/dev/lucid-v2/src/server/client/app.tsx:1301).

**Why it matters:** The RFC removes an error identifier for behavior that remains required. It must retain `E-ART-04`, or explicitly withdraw R10 and justify that additional narrowing.

**Evidence grade:** 4. The specification and implementation demonstrate the conflict. The two relevant pure test files passed, with 29 tests total.

### F-02: R5 preserves a state that the state machine cannot represent

**Lands in:** R5 and State Machine.

[RFC-09 R5](/Users/kevin/dev/lucid-v2/docs/rfc/09_one-artifact-per-conversation.rfc.md:182) requires an existing two-artifact log to remain readable. The [state machine](/Users/kevin/dev/lucid-v2/docs/rfc/09_one-artifact-per-conversation.rfc.md:217) only represents no artifact, the same artifact ID, or a different artifact ID. It has no state for multiple existing artifact IDs.

This creates unresolved cases:

- There is no single held artifact ID against which `E-ART-09` can compare a new emission.
- An emission naming either existing ID could be treated as a valid revision or as a contract violation.
- `replaces: 1` is ambiguous when both artifacts have version 1.

The fold avoids this ambiguity because it indexes versions by `(artifactId, version)` in [log.ts](/Users/kevin/dev/lucid-v2/src/store/log.ts:203). The emission path selects the current artifact and patch base by `header.id` in [host.ts](/Users/kevin/dev/lucid-v2/src/modes/host.ts:241) and [host.ts](/Users/kevin/dev/lucid-v2/src/modes/host.ts:320).

**Why it matters:** The compatibility state that R5 requires has undefined write behavior. RFC-09 needs a policy. Examples include selecting one canonical artifact, accepting either existing ID while refusing new IDs, or making legacy multi-artifact records read-only.

**Evidence grade:** 4. A direct `foldLog` probe indexed both `alpha@1` and `beta@1`.

### F-03: The first-emission rule silently reverses RFC-06

**Lands in:** R1 and State Machine.

[RFC-09](/Users/kevin/dev/lucid-v2/docs/rfc/09_one-artifact-per-conversation.rfc.md:118) says the first emission must use `replaces: null`, and says this is unchanged from RFC-06.

That is not RFC-06's rule. [RFC-06](/Users/kevin/dev/lucid-v2/docs/rfc/06_an-artifact-you-can-address.rfc.md:458) permits an unknown artifact ID with a non-null `replaces` value to begin at version 1. The implementation follows that rule in [host.ts](/Users/kevin/dev/lucid-v2/src/modes/host.ts:272), and the behavior is fixed by [artifacts-emission.test.ts](/Users/kevin/dev/lucid-v2/test/protocol/artifacts-emission.test.ts:229).

RFC-09's state machine sends any first parsed emission to `FIRST -> APPENDED`. It does not specify a refusal for non-null `replaces`.

**Why it matters:** RFC-09 introduces another reversal without identifying it. It also leaves implementations free to accept or reject the same emission.

**Evidence grade:** 3. The current path was traced from artifact detection through `current = 0` to `writeArtifact`. The temporary test suite could not run.

### F-04: Refusal precedence is incomplete

**Lands in:** R3, State Machine, and Error Handling.

Several conditions can apply to one emission:

- A patch with a second artifact ID and `replaces: null` matches both `E-ART-09` and `E-PATCH-01`.
- An oversized whole emission with a second artifact ID matches both `E-ART-09` and the size refusal.
- A malformed patch body with a second artifact ID matches both `E-ART-09` and `E-PATCH-04`.

RFC-09 says every different ID must produce `E-ART-09`, but its state machine parses the artifact form first and does not define error precedence.

The current path checks whole-emission size before loading durable artifact state in [host.ts](/Users/kevin/dev/lucid-v2/src/modes/host.ts:214). It checks `E-PATCH-01` before patch parsing and application at line 257. Patch application starts at line 307.

The state table also has `FIRST -> APPENDED` within the size limit, but no `FIRST -> REFUSED` transition for an oversized first emission. Error Handling still retains that refusal.

**Why it matters:** A guard can run before patch application and still return the wrong specified error. The RFC must define precedence and add the missing oversized `FIRST` state.

**Evidence grade:** 3. The complete emission path was traced in source.

### F-05: `E-ART-01` survives with a withdrawn recovery path

**Lands in:** Error Handling and Migration Plan.

[RFC-09](/Users/kevin/dev/lucid-v2/docs/rfc/09_one-artifact-per-conversation.rfc.md:246) says `E-ART-01` survives unchanged. [RFC-07](/Users/kevin/dev/lucid-v2/docs/rfc/07_many-artifacts-in-one-record-and-the-history-you-can-move-through.rfc.md:670) defines its recovery offer as the artifact list from R2.

RFC-09 withdraws R2 and plans to remove `AlsoHere`. The current unknown-artifact page still uses `AlsoHere` in [app.tsx](/Users/kevin/dev/lucid-v2/src/server/client/app.tsx:1824).

**Why it matters:** The RFC keeps an error contract whose recovery UI is deleted. It should redefine recovery as the conversation's sole artifact or `/c/:conversationId`.

**Evidence grade:** 3. The error definition, withdrawn requirement, component, and migration plan were traced.

### F-06: Retiring an artifact is not equivalent to finishing a conversation

**Lands in:** Decision and Alternatives.

[RFC-09](/Users/kevin/dev/lucid-v2/docs/rfc/09_one-artifact-per-conversation.rfc.md:174) says "do not revise this artifact again" means the conversation is finished. It repeats that claim at line 346.

The shipped behavior does not close the conversation:

- Retirement is stored as artifact metadata in [server.ts](/Users/kevin/dev/lucid-v2/src/server/server.ts:444).
- The agent instruction says not to revise unless asked in [artifacts.ts](/Users/kevin/dev/lucid-v2/src/protocol/artifacts.ts:375).
- The conversation input endpoint remains active in [server.ts](/Users/kevin/dev/lucid-v2/src/server/server.ts:579).
- The retired artifact remains readable and can be restored in [app.tsx](/Users/kevin/dev/lucid-v2/src/server/client/app.tsx:2089).

**Why it matters:** Retirement represents "this artifact is obsolete, but the conversation continues." That differs from ending the conversation. Whether retirement belongs in the narrower product is a product decision, but RFC-09 cannot dismiss it as an already-covered finished-conversation state.

**Evidence grade:** 3 for the semantic distinction, based on storage, prompt, server, and UI behavior. The claim that users need this continuing-conversation state has grade 1 because no production record was inspected.

### F-07: The RFC gives conflicting accounts of the second pane

**Lands in:** Abstract, R4, and Cost of Reversal.

The [Abstract](/Users/kevin/dev/lucid-v2/docs/rfc/09_one-artifact-per-conversation.rfc.md:17) says RFC-07 built a second artifact pane. [R4](/Users/kevin/dev/lucid-v2/docs/rfc/09_one-artifact-per-conversation.rfc.md:168) also describes both panes as existing.

The [cost section](/Users/kevin/dev/lucid-v2/docs/rfc/09_one-artifact-per-conversation.rfc.md:372) says issue `#123`, which covers the second pane, was not built.

The client currently has one document pane and one `DocumentFrame` path in [app.tsx](/Users/kevin/dev/lucid-v2/src/server/client/app.tsx:1820) and [app.tsx](/Users/kevin/dev/lucid-v2/src/server/client/app.tsx:1972).

**Why it matters:** The RFC overstates how much shipped behavior it reverses and contains incompatible implementation histories. Withdrawing an unimplemented requirement is different from deleting working code.

**Evidence grade:** 3. The RFC statements and client structure directly conflict.

### F-08: `artifactId` still has address and integrity duties

**Lands in:** Why the Previous Design Was Wrong and Open Question.

[RFC-09](/Users/kevin/dev/lucid-v2/docs/rfc/09_one-artifact-per-conversation.rfc.md:145) says `artifactId` no longer addresses an artifact and mostly remains as a display fallback.

The source gives it several active duties:

- Durable composite key in [log.ts](/Users/kevin/dev/lucid-v2/src/store/log.ts:203).
- Revision and patch-base selection in [host.ts](/Users/kevin/dev/lucid-v2/src/modes/host.ts:241) and [host.ts](/Users/kevin/dev/lucid-v2/src/modes/host.ts:320).
- Annotation binding in [annotations.ts](/Users/kevin/dev/lucid-v2/src/protocol/annotations.ts:109).
- URL and API addressing in [route.ts](/Users/kevin/dev/lucid-v2/src/server/client/route.ts:12) and [server.ts](/Users/kevin/dev/lucid-v2/src/server/server.ts:329).
- Correlation of untrusted iframe messages in [app.tsx](/Users/kevin/dev/lucid-v2/src/server/client/app.tsx:587).

The RFC's open question also recommends retaining artifact routes.

**Why it matters:** The four-job analysis is incomplete. Removing validation or identity checks on the assumption that the ID is only a label could break R5 compatibility, annotations, direct links, or iframe message checks.

**Evidence grade:** 3. Every requested source file was searched for `artifactId` and `replaces`, and each material path was traced.

### F-09: The refusal quote does not enforce its stated byte limit

**Lands in:** Error Handling.

[RFC-09](/Users/kevin/dev/lucid-v2/docs/rfc/09_one-artifact-per-conversation.rfc.md:255) cites RFC-08 R7 and `REFUSAL_QUOTE_MAX` as a byte limit.

`quoteForRefusal` compares JavaScript string length and slices UTF-16 code units in [artifacts.ts](/Users/kevin/dev/lucid-v2/src/protocol/artifacts.ts:101).

A valid 128-code-unit artifact ID made from `界` produces a quoted value of 386 UTF-8 bytes, despite the configured limit of 200.

**Why it matters:** `E-ART-09` can quote the untrusted artifact ID. The current helper does not meet the RFC's 200-byte guarantee. The header limit still prevents unlimited input.

**Evidence grade:** 4. The actual helper and `Buffer.byteLength` demonstrate the failure.

### F-10: The usage evidence supports a user decision, not a general no-use claim

**Lands in:** Decision Evidence and Why the Previous Design Was Wrong.

[RFC-09](/Users/kevin/dev/lucid-v2/docs/rfc/09_one-artifact-per-conversation.rfc.md:49) reports 15 records from one machine. That supports the claim that this user had no retained non-test two-artifact record in that sample.

It does not establish that sibling artifacts have no valid use. It covers one user, one machine, and 15 records.

RFC-07 also records a concrete motivation that RFC-09 does not resolve. [RFC-07](/Users/kevin/dev/lucid-v2/docs/rfc/07_many-artifacts-in-one-record-and-the-history-you-can-move-through.rfc.md:105) says a second document exposed the defect. Line 649 describes comparing one artifact while reading another as the reason for two panes.

**Why it matters:** The narrowing can still be correct because the user chose it. The empirical argument is weaker than RFC-09 states, and it does not answer RFC-07's prior use case.

**Evidence grade:** 2 for the unresolved conflict between the RFCs. The claim that future users need sibling artifacts has grade 1.

## Cleared

- The fit check passes as a deliberate narrowing. [CONTEXT.md](/Users/kevin/dev/lucid-v2/CONTEXT.md:18) describes one person on one machine. Line 22 defines the purpose as reading and marking up an artifact. The user explicitly chose the narrower contract.
- Refusing a different ID is safer than silently folding it into the existing artifact for clean zero-artifact and one-artifact records. Silent substitution would change the agent's instruction.
- RFC-09 places its ID guard before patch application at [line 225](/Users/kevin/dev/lucid-v2/docs/rfc/09_one-artifact-per-conversation.rfc.md:225). That ordering is sound after the RFC defines overlapping-error precedence.
- The current fold remains total over a two-artifact log. A direct probe opened and indexed both artifacts.
- The `artifact-meta` entry source still serves title changes. Its type and fold behavior remain in [log.ts](/Users/kevin/dev/lucid-v2/src/store/log.ts:90) and [log.ts](/Users/kevin/dev/lucid-v2/src/store/log.ts:443). A direct probe preserved both title and retired state.
- RFC-07 R11 title changes still work with one artifact.
- The version picker, read-only older versions, restoration, and version comparison also work with one artifact.
- With R12 removed, withdrawing `E-ART-02` is coherent.
- Repository search found no literal `E-ART-02` or `E-ART-04` in `src`. The `E-ART-04` problem in F-01 is a specification and behavior conflict.
- No repository files changed. Git status remained clean.

## Not reviewed

- The reported 15-record usage sample and the claim that no current multi-artifact records exist were not checked. Those records were outside the repository scope.
- No live browser walkthrough ran. The React flow and component structure were read directly.
- Temporary-directory tests could not run because `mkdtemp` returned `EPERM`. This was not a product failure. Pure tests and direct probes ran.
- The exact `npx tsx` validator command could not run because IPC pipe creation was blocked. The same validator ran through Node's TypeScript stripping and returned the structural result shown above.
- The code graph CLI could not connect to its secure endpoint. Direct full-file reads and repository searches replaced it.
- CSS and visual design were not reviewed because RFC-09's contract claims do not depend on them.

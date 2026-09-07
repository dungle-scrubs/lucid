Reviewer: `opus-5@claude`, via hcn. The complete review message below was captured before the harness timed out; the run did not exit cleanly. Findings are the reviewer's document-level assessment, not runtime proof.

# Review: RFC-14 Annotated content comparison

## What was reviewed

- **RFC path:** `docs/rfc/14_annotated-content-comparison.rfc.md` (commit `cf514f2`)
- **Version:** none. The frontmatter carries `number`, `title`, `type`, `status`, `author`, `date` and **no version field**. This review names no draft version because the document names none; a later review cannot tell whether it read the same text except by commit.
- **Status:** Draft.
- **Supporting inputs read in full:** `artifacts/evidence/rfc14-review/inputs/review-skill.md`, `artifacts/evidence/rfc14-review/inputs/evidence-ladder.md`, `artifacts/evidence/rfc14-review/structure.json`, `artifacts/evidence/rfc14-review/author-checks.md`, `CONTEXT.md`, `docs/artifacts.md`, `docs/skill-chat-substrate.md`.
- **Method:** one careful whole-document pass, bounded to the documents above. **Code tracing and runtime tests are outside this bounded review.** No source file was opened, no graph query run, no test executed. Every finding below is graded rung 2 at best: pointed at document text. Nothing here reaches rung 3 or rung 4.
- **Author's checks:** `author-checks.md` reports four source pointers (`src/server/server.ts:774-775`, `src/store/conversation-host.ts:379-392`, `src/protocol/reducer.ts:901-905`, `src/modes/host.ts:94-120`, `docs/skill-chat-substrate.md:113-116`). Those are **the author's verified pointers, not this review's independent conclusions**. Where a finding leans on one, it is labelled as such and the code was not re-read here.
- **Product decisions taken as settled** (not re-litigated): inline note editor beneath the selected historical or current content; submission into the separate normal transcript; no direct selective rollback. Open Question 1 (non-text first-release boundary) is **pending a user answer**; no approval is assumed or invented anywhere below.

## Structural results

Output of the structure validator, verbatim from `artifacts/evidence/rfc14-review/structure.json`:

```json
{
  "passed": true,
  "errors": [],
  "warnings": []
}
```

No frontmatter, required-section, placeholder, empty-Security, invalid-type/status, or lowercase-RFC-2119 problem was reported. None of it is re-derived by hand here.

## Findings

### F1. Retry precedence between a previously accepted input and a stale reviewed base is undefined, and no client-stable input identity is specified
**Severity: blocking. Evidence rung 2** (RFC text; the code pointer is the author's check, not independently verified here).

**Section:** Inline note entry and transcript placement (line 93); Current content and restoration (line 121); State Machine (lines 150 to 153); Error Handling (line 173).

The RFC states two preconditions that can both fire on the same event and gives no ordering. Line 93: "An ambiguous network result MUST be reconciled with the same idempotent input ID; retry MUST NOT create another note." Line 121: "Before accepting a comparison input, the server MUST atomically verify that the artifact's latest version and hash still equal the reviewed version and hash. A mismatch returns a stale-comparison result without appending an input." The State Machine repeats the collision as two sibling rows on the same `Sending` state, "Stale base or refusal before acceptance" and "Transport outcome unknown", with no discriminator.

**Why it matters.** The likeliest cause of a new version arriving is the agent acting on the very note whose transport outcome is unknown. The retry then carries a reviewed version that is genuinely stale, so a naive implementation returns `E-COMP-02` and instructs the person to review the newer comparison and re-send, for a note that was already accepted and already answered. The user is told their work was not submitted when it was, and re-sending duplicates it under a fresh identity. Line 173's "Transport recovery uses the existing idempotent send behavior" is the only guidance, and per author's check 1 (`src/server/server.ts:774-775`, their check) browser submission mints a new server-generated ID per request, so there may be no client-retained identity to reconcile with. Line 91 compounds this: the source marker "MUST resolve by durable input identity", but nothing in the RFC requires the acceptance response to return that identity to the client.

**Repair.** Add a normative precedence rule: on any comparison send carrying a client-supplied idempotent input ID, the server MUST first look up durable acceptance of that ID and, if found, return the accepted result (durable input identity and note index) as success without evaluating the reviewed-base precondition; the stale-base check applies only to an ID with no durable acceptance. Add the client-supplied identity to the field table as a required additive request field, specify payload-conflict handling for a reused ID with different content, and require the acceptance response to carry the durable input identity that line 91's marker resolves against. Add a State Machine row making the precedence explicit, and a sentence in Error Handling stating that `E-COMP-02` MUST NOT be returned for an already-accepted identity.

### F2. Two normative statements disagree about which version is the revision target
**Severity: blocking. Evidence rung 2** (RFC text plus `docs/artifacts.md`; author's check 3 points the same way, not independently verified here).

**Section:** Version provenance and annotation encoding (lines 99, 117); Current content and restoration (line 127).

Line 99: "For comparison notes, batch `version` MUST identify the reviewed revision target, not the earlier version quoted by a spot." Line 127: "At turn dispatch the driver MUST provide the latest full artifact ... It MUST explicitly identify the dispatch version as the revision target and the reviewed version as historical context." When a newer version arrives after acceptance, the batch says v17 is the revision target and the dispatch says v18 is. Line 117 tries to bridge this with "comparison-aware delivery additionally accounts for a newer current version", which is not a normative resolution: "additionally accounts for" does not say which statement loses.

**Why it matters.** `docs/artifacts.md:17` requires a revision to name the current version in `replaces`, and a stale base is refused (`docs/artifacts.md:52-56`). The agent is handed a batch whose own field asserts v17 is the target and a dispatch preamble asserting v18 is. If it follows the batch it emits `replaces: v17` and is refused for a stale base, on a request the system itself constructed. The failure lands on the user as a refused revision with no defect in their note. `reviewedHash` (line 107) is pinned to the batch version and so carries the same wrong claim forward.

**Repair.** State the override explicitly: for comparison notes, batch `version` and `reviewedHash` record the version reviewed when the note was authored, and the dispatch-time target version supersedes them as the emission base whenever it is newer. Reword line 99 so batch `version` is not called "the revision target", and add a normative sentence that the dispatch preamble's named target is the sole authority for `replaces`. Say what the agent must do if dispatch context is older than the batch version, which the current text leaves possible but never addresses.

### F3. The driver dispatch requirement asserts an unconditional guarantee, and its failure path has no disposition, no code, and no state
**Severity: major. Evidence rung 2** (RFC text and `docs/skill-chat-substrate.md:115-118`; the `src/modes/host.ts:94-120` conditionality is author's check 3, not independently verified here).

**Section:** Current content and restoration (line 127); Error Handling (line 173).

Line 127 requires the driver to "provide the latest full artifact through the existing artifact-context mechanism". Author's check 3 reports that the existing mechanism includes document bytes only for human-authored or owed artifacts. The RFC states the requirement as a property already held by an existing mechanism rather than as a new condition-independent obligation, so an implementer reading only this document would reasonably wire it up and get no bytes in the common case.

The failure path is worse specified. Line 173: "Missing context at driver dispatch MUST be surfaced to the user; do not substitute the earlier version as the revision base." That is the whole contract. `docs/skill-chat-substrate.md:115-118` gives only three dispositions, and `rejected` "returns to lucid's queue and is redelivered, **never dropped**". An input whose current document is unreadable at dispatch therefore either loops on redelivery forever or is silently marked `applied` with no context. Neither is "surfaced to the user". There is no `E-COMP-` code for dispatch-time missing context, and no State Machine row between "Accepted input | Queued or working" and "Agent revision".

**Why it matters.** This is the one failure in the design that occurs after the person has been told their note was accepted, so there is no draft to preserve and no editor still open. Left unspecified, it becomes either a hot redelivery loop against the record or a note that quietly reaches the agent with no document to revise.

**Repair.** Restate line 127 as a new obligation on the driver rather than a property of the existing mechanism, naming the condition under which the current text omits bytes and requiring it be overridden for comparison dispatch. Add an error code for dispatch-time missing or unreadable current content, specify that the input is held pending with a bounded surfaced failure rather than dispositioned `rejected` into the redelivery loop, and add the matching State Machine row.

### F4. Comparison spots on the reviewed side conflict with the existing snippet-capture rule when unsaved edits exist
**Severity: major. Evidence rung 2** (RFC text and `docs/artifacts.md:92`).

**Section:** Ownership and entry (line 54); Content extraction and matching (line 71); Version provenance and annotation encoding (line 111).

`docs/artifacts.md:92`, which this RFC lists as a normative reference, requires a spot to "Capture the current human-edited text, not a stale pre-edit snippet." Line 54 requires that entering comparison with unsaved edits MUST preserve that work and MUST NOT silently save it, so the reviewed side of the comparison is the latest **saved** version while the person's editor holds newer unsaved text. Line 71 derives the comparison from stored version content, and line 111 requires source selectors be built against source content. A note taken on the reviewed side therefore captures exactly the stale pre-edit snippet the existing contract forbids.

**Why it matters.** The person sees text on screen that differs from what their editor holds, quotes it, and sends a note whose snippet contradicts the document state they believe they are discussing. Out of scope at line 24 excludes "comparison of unsaved drafts", which correctly keeps drafts out of the diff but does not resolve what a note taken in that state means.

**Repair.** Add a normative rule for this state. Either forbid comparison note entry on the reviewed side while unsaved edits exist, or require the UI to label the reviewed side as a saved version that does not include the person's unsaved edits and record that condition in the batch. Say explicitly that `docs/artifacts.md:92` continues to govern ordinary artifact-view notes and is scoped away only for comparison spots, so the two contracts do not read as contradictory.

### F5. The `comparison` object is batch-scoped but notes are queued per batch, and "comparison spot" is never defined
**Severity: major. Evidence rung 2** (RFC text and `docs/artifacts.md:94-98`).

**Section:** Version provenance and annotation encoding (lines 101 to 111); Inline note entry and transcript placement (line 89).

The field table places `comparison`, `earlierVersion`, and `reviewedHash` on the batch, one occurrence each. Line 89 says "Existing multi-note annotation queues remain supported outside this one-note interaction", and `docs/artifacts.md:97` bounds the local queue at 20 notes carried in one batch. A batch can therefore contain notes taken against different comparisons, or a mix of comparison notes and ordinary notes, and a single batch-level `earlierVersion` cannot express that.

Compounding it, `sourceVersion` and `sourceHash` are "required for comparison spots" while `comparison` is "optional for existing notes", and **"comparison spot" is defined nowhere**. It is unresolvable whether a spot is a comparison spot because it carries `sourceVersion`, or because its batch carries `comparison`. Validation of a mixed batch is undefined in both readings.

**Why it matters.** This is the encoding a server must validate (line 179) and an older reader must degrade over (line 135). An underdetermined discriminator produces either false refusals of valid legacy-plus-comparison batches or silent acceptance of a batch whose earlier-version claim applies to only some of its notes.

**Repair.** Define "comparison spot" in Terminology as a spot carrying `sourceVersion` and `sourceHash`. Move `earlierVersion` to the spot alongside them, or state normatively that a batch containing any comparison spot carries exactly one comparison and that comparison notes are never batched with notes from a different comparison. Specify what happens when Send note fires with a nonempty ordinary note queue pending: whether the queue is flushed into the same input, held, or refused, and whether the line 121 precondition applies to the whole mixed batch.

### F6. No transition for a new version arriving at a ready comparison with no draft, and stale comparison has only one exit
**Severity: major. Evidence rung 2** (RFC text; State Machine, lines 141 to 157).

**Section:** State Machine; Ownership and entry (line 54).

The table covers "Inline draft | New version arrives". It does not cover **"Ready comparison, no draft | New version arrives"**. Line 54 says only that "If a newer version has arrived, normal following rules apply only after pending work is resolved", so with nothing pending, normal following applies. `docs/artifacts.md:74-76` makes following move the view to the newest version. Whether the comparison's current side silently retargets from v17 to v18, changing the meaning of every version label on screen and of any note begun a second later, is not stated anywhere.

The `Stale comparison` state has exactly one outgoing transition, "Review newer version". There is no row for cancelling the draft from stale comparison (which target does the comparison return to?) and none for sending without reviewing, whose outcome only appears indirectly as `E-COMP-02` in the error table.

**Why it matters.** Silent retargeting of the reviewed side is precisely the failure the rest of the document works to prevent: the person would quote content believing it is v17 and produce a note recorded against v18. The gap sits in the one state where no draft protects them.

**Repair.** Add a row for a new version arriving at a ready comparison with no draft, and state normatively whether the reviewed side holds until the person acts. Add rows for Cancel from stale comparison and for Send from stale comparison, the latter pointing at `E-COMP-02`.

### F7. Two error codes have no state, and "identical supported text, different bytes" has no defined outcome
**Severity: major. Evidence rung 2** (RFC text; State Machine and Error Handling).

**Section:** State Machine (lines 141 to 159); Error Handling (lines 165 to 171); Readable changes (line 67).

`E-COMP-04` (content cannot be compared safely or meaningfully) and `E-COMP-05` (bounded computation falls back to coarse output) appear in the error table and in no State Machine row. The `Loading comparison` state has exactly two outcomes, "Both sides readable" and "Either side unreadable"; unsupported content and coarse fallback are a third and fourth outcome with no place in the machine. Line 159 gestures at this ("The UI MUST show a bounded failure or coarse result") without adding transitions.

Separately, line 67 states a prohibition with no positive counterpart: "It MUST NOT label two versions identical merely because the supported text extraction is identical while unsupported content or source bytes differ." The RFC never says what the UI **must** show in that state, provides no code for it, no State Machine row, and no field or operation by which the difference is detected. Detection is not free: line 71 removes Lucid instrumentation before extraction, so a raw byte or hash comparison of stored versions will report differences the person cannot see and would satisfy line 67 trivially and uselessly.

**Why it matters.** This is the state Open Question 1 makes most likely on a real document, and OQ1's own acceptance criterion at line 207 is "a defined fallback that never hides unexamined changes". Without a defined outcome and a detection operation, that criterion cannot be evaluated whichever way the pending scope answer goes.

**Repair.** Add `Loading comparison` rows for the unsupported and coarse outcomes mapping to `E-COMP-04` and `E-COMP-05`, and a row for the identical-supported-text case. Specify the detection operation (which representation is compared, and after which normalization steps) and the required presentation, so line 67's prohibition has a satisfiable positive form.

### F8. Reusing batch `version` as the revision target contradicts its documented meaning and mislabels comparison notes in existing projections
**Severity: major. Evidence rung 2** (RFC text and `docs/artifacts.md:94, 100`).

**Section:** Version provenance and annotation encoding (line 99); Compatibility (line 135).

`docs/artifacts.md:94` defines the batch's version as "the artifact and version being discussed", and `docs/artifacts.md:100` states "annotations on an old version remain associated with that version". Line 99 redefines the same field for comparison notes as the revision target. For a note quoting v12 while comparing against v17, the version being discussed is v12 and the field will carry v17.

**Why it matters.** Line 135 promises that "Older readers can show the human-readable input" and only disclaims source-aware diff navigation. But an existing projection that groups annotations by batch version will file a v12 quote under v17 and, per `docs/artifacts.md:100`, will not associate it with v12 at all. That is not a missing navigation affordance, it is a wrong association produced by the compatibility path the RFC declares safe. The human-readable statement required at line 115 mitigates it for a human reader and not for a projection.

**Repair.** Either state that `docs/artifacts.md:94` and `:100` are amended for comparison batches and describe exactly how existing version-grouped projections must treat them, or keep batch `version` at its documented meaning and add an explicit `targetVersion` field to the `comparison` object for the revision target. Update line 135's compatibility claim to name the association change rather than only the navigation gap.

### F9. Explicit reporting of malformed comparison fields conflicts with the ignore-unknown decoder contract, and admission-time is not distinguished from read-time
**Severity: minor. Evidence rung 2** (RFC text and `docs/artifacts.md:32, 127-129`).

**Section:** Version provenance and annotation encoding (line 113).

Line 113: "Malformed comparison fields MUST be reported explicitly rather than silently treated as a legacy note." `docs/artifacts.md:127-129` states that "Stored annotation decoders ignore unknown fields so older readers can still read newer batches. This differs from executable patch edits, whose unknown fields are refused." `docs/artifacts.md:32` adds that malformed metadata does not make the record unreadable. Line 113 does not say whether it governs admission (a server refusal on send) or read-time (rendering a stored batch), and read-time is where it collides.

**Why it matters.** Applied at read-time, it turns a batch written by a newer Lucid into an error in an older transcript, which is the outcome the ignore-unknown rule exists to prevent. Applied at admission only, it is compatible and correct.

**Repair.** Scope line 113 to admission and map it to `E-COMP-03`. Add a separate sentence for read-time: a stored batch with unusable comparison metadata renders as a legacy note with its text, quote, and version intact and its source-aware affordances withheld, never as a read error.

### F10. Version-role vocabulary is used normatively and defined nowhere
**Severity: minor. Evidence rung 2** (RFC text; Terminology, lines 32 to 36).

**Section:** Terminology; Current content and restoration (lines 121 to 129); State Machine (lines 150 to 156).

Terminology carefully separates "Earlier version", "Reviewed version", and "Current version", then the body introduces **"revision target", "dispatch version", "current base", "expected reviewed base", "stale-comparison result", "comparison spot", and "the existing version-hash representation"** without defining any of them or relating them to the three defined terms. Line 34 warns that Current version "is not an alias for the earlier or reviewed version", which shows the document knows this vocabulary is load-bearing.

**Why it matters.** F2 is a direct consequence: two sections each name a "revision target" and mean different versions. Terms that carry the whole correctness argument of this RFC should be in the section built for them.

**Repair.** Add "dispatch version", "revision target", and "comparison spot" to Terminology, define each against the three existing terms, and either define or cite the version-hash representation. Replace "current base" and "expected reviewed base" with the defined terms at each use.

### F11. The input mode for Send note is unspecified
**Severity: minor. Evidence rung 2** (RFC text, `CONTEXT.md:56, 88`, and `docs/skill-chat-substrate.md:113-129`).

**Section:** Inline note entry and transcript placement (line 89).

Line 89 requires Send note to "submit one annotation as one ordinary input through the existing input path, using the selected harness, model, and effort under the current driver rules", and never names the input's `mode`. `CONTEXT.md:56` makes `mode` part of what an input carries. The choice is not cosmetic: `docs/skill-chat-substrate.md:122-124` gives `queue` a turn-boundary wait that `steer` and `answer` bypass, `:126-129` refuses `steer` outright at a `headless-turn` attachment, and `CONTEXT.md:88` honours driver preference only "at the next queue-input boundary".

**Why it matters.** A comparison note sent as `steer` mid-turn reaches the agent before the dispatch context of line 127 is assembled at a boundary, and is refused `steer-unsupported` in `headless-turn`. Leaving the mode open leaves the line 127 dispatch guarantee open too.

**Repair.** State that a comparison note is submitted in `queue` mode, and say what happens if the person sends while a turn is running.

### F12. Orphan semantics for earlier-version comparison spots in the ordinary artifact view are unspecified
**Severity: minor. Evidence rung 2** (RFC text and `docs/artifacts.md:84, 89-105`).

**Section:** Version provenance and annotation encoding (line 111); Current content and restoration (line 125).

Line 125 specifies the source marker inside the comparison: visible when its exact source version is displayed, otherwise the transcript retains the quote and an inspect action. It says nothing about the ordinary, non-comparison artifact view. A spot addressed to v12 content that no longer exists in v18 will not resolve through quote, position, or path (`docs/artifacts.md:102-103`) and becomes an orphan (`docs/artifacts.md:104-105`, `CONTEXT.md:84`: shown with its note and snippet, never re-pointed).

**Why it matters.** Orphan presentation is a documented affordance that means "this note's target is gone", which is a materially different statement from "this note quotes an earlier version on purpose". Every comparison note on removed content will acquire the first meaning by default, in the view the person spends most of their time in.

**Repair.** State normatively whether comparison spots on an earlier version participate in current-document anchoring at all. If they do not, say they are excluded from anchoring and rendered from their source version in the transcript. If they do, say they render as orphans and how that is distinguished from an ordinary orphan.

### F13. The compatibility section leaves an existing documented contract false between step 1 and step 4
**Severity: minor. Evidence rung 2** (RFC text and `docs/artifacts.md:85-87`).

**Section:** Compatibility and removal of the old comparison presentation (line 137); Implementation Plan (steps 1 and 4, lines 198 and 201).

`docs/artifacts.md:85-87` states as a current contract: "Comparison reads two stored versions and shows a line-oriented diff of their source, not a transformed DOM." Line 137 demotes that to "an internal verification utility during the migration", and line 71 replaces it with an extracted content model, which is a transformed representation. The doc update is scheduled in step 4, three steps after step 1 switches the UI.

**Why it matters.** `AGENTS.md` treats `docs/` as the routing layer for current contracts, so a reader between step 1 and step 4 gets an authoritative sentence describing behaviour that no longer exists.

**Repair.** Move the `docs/artifacts.md:85-87` amendment into step 1's exit criteria, alongside the UI switch it invalidates.

## Cleared

Checked and found sound, so the next reviewer does not repeat it.

- **Structural validation.** Passed with zero errors and zero warnings. Not re-derived by hand.
- **Product decisions are carried consistently.** Inline note beneath the selected content (line 83), transcript kept out of the note box (line 85) and out of the diff (line 95), submission into the ordinary transcript (line 91), and no direct selective rollback (lines 24, 129, 191). No section quietly reintroduces an inline transcript, a second composer, or a Restore-this-passage control. The Alternatives section's account of the three prototypes matches the Design it produced.
- **Open Question 1 is not treated as answered.** Lines 22, 79, and 207 consistently mark the non-text boundary as pending and label the text-focused scope a recommendation. The Design's non-text paragraph is written as "Proposed non-text behavior", not as settled requirement. No approval is asserted. (F7 concerns the machinery OQ1's acceptance criterion needs regardless of the answer, not the scope question itself.)
- **No new protocol surface.** Line 99 keeps the `lucid-annotations` batch and adds no conversation event kind, consistent with the six-up/seven-down frame set in `docs/skill-chat-substrate.md:154-167`. Nothing in the RFC requires a new frame, refusal issue, or disposition value.
- **Security Considerations.** Inert rendering with no artifact HTML in the privileged DOM (line 177) matches `docs/artifacts.md:139-141`; reuse of the opaque-origin sandbox and authenticated frame-message boundary (line 177) matches `docs/artifacts.md:139-142`; session-token and origin checks with no cookie or query token (line 179) matches `docs/artifacts.md:133-136`; artifact IDs validated as identifiers and never paths (line 179) matches `docs/artifacts.md:69-70`. Line 181's refusal to claim that delimiting prevents prompt injection is appropriately hedged. Line 183 correctly claims no new host permission, service, or shared storage.
- **Terminology hygiene for the five defined terms.** Earlier version, Reviewed version, Current version, Comparison, and Passage are each defined and each used later in the body. No defined term is orphaned. The RFC 2119 boilerplate is present and correct. (F10 concerns undefined terms, not unused ones.)
- **Bounded computation is specified as bounded.** Line 77 requires the budget be checked before allocating a matrix, requires the fallback to retain both source texts and preserve note entry, and forbids silent omission and freezing; line 159 requires cancellability and a bounded failure rather than an indefinite working indicator. The obligations are stated even where F7 leaves them without a state.
- **Immutability and evidence discipline.** No section proposes rewriting a version or a log entry (lines 117, 129, 159). Whole-version Restore is explicitly retained with its confirmation and ancestry (line 24), matching `docs/artifacts.md:83-85`.
- **Legacy batch validity.** Line 113's "Legacy batches without comparison metadata remain valid" and line 135's no-migration claim are consistent with each other and with the additive field table. (F8 and F9 concern specific compatibility claims, not this baseline.)

## Not reviewed

Each of these is a gap in the review, not evidence of an absence of problems in the RFC.

- **Code tracing and runtime tests.** Explicitly outside this bounded review. No source file was read, no execution followed, no test or script run. **No finding above exceeds rung 2.** In particular, F1, F2, and F3 would each move to rung 3 or 4 only by tracing the send path, the append transaction, and the dispatch context in code.
- **The four author's checks were not independently verified.** `src/server/server.ts:774-775`, `src/store/conversation-host.ts:379-392`, `src/protocol/reducer.ts:379-392` and `:901-905`, and `src/modes/host.ts:94-120` are reported by the RFC's author in `author-checks.md` and are relied on only where labelled. `author-checks.md` itself states that graph queries were unavailable and no exhaustive reach claim is made.
- **`docs/drivers.md`.** Listed as a normative reference by the RFC (line 220) and not in this review's input set. F3's driver-boundary finding rests on `docs/skill-chat-substrate.md` and the author's check; the drivers contract may confirm, qualify, or contradict it.
- **`docs/adr/0007-document-edits-preserve-evidence.md`.** Normative reference (line 218), not read. Immutability and unresolved-source-evidence claims were checked against `docs/artifacts.md` and `CONTEXT.md` only.
- **The informative source references.** `src/protocol/annotations.ts`, `src/server/client/version-diff.ts`, and `src/server/client/line-diff.ts` (lines 225 to 227) were not read. Whether the existing encoding accommodates the proposed fields, and whether the "existing comparison work budget of 4,000,000 alignment cells" (line 77) exists at that value, are unverified.
- **The prototype.** Branch `prototype/hub-workflow`, commit `059ced3` (line 224) was not inspected. The claim that the user approved the interaction on 2026-09-07 is taken as given, per the settled product decisions.
- **Visual, layout, and typography claims.** The 820 CSS-pixel artifact-area threshold (line 65) and the 390, 768, and 1440 verification targets (line 201) were not evaluated. Both color themes, pointer and keyboard selection behaviour, and the shadcn control claim at line 83 are outside a document review.
- **Performance and accessibility beyond the document's own statements.** Whether the bounded alignment budget is adequate for real artifacts, and whether the marker navigation at line 95 meets any accessibility standard, were not assessed.
- **Whether to build this.** Per the review contract, this document tells the reader what they are deciding with; it does not render a verdict on the feature.

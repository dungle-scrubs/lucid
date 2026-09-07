---
number: 14
title: "Annotated content comparison"
type: feature
status: Draft
revision: 1
author: Codex
date: 2026-09-07
---

# RFC-14: Annotated content comparison

## Abstract

Lucid's comparison view does not make content changes clear enough to review or discuss. This proposal replaces its primary comparison presentation with a readable content diff inside the artifact view. A person writes a small note beneath selected earlier or current content; submitting it adds the note to the existing conversation transcript. The agent receives the historical quote and current document separately, so a request to restore an explanation produces a new revision without rolling back unrelated changes.

## Introduction

The user approved the inline-note design after trying three prototypes. The approval is for the interaction: a local note box beside the content, with the conversation kept in its own panel. This draft specifies the production behavior. It does not treat the prototype's authored paragraph pairs or simulated sends as an implementation.

The user is one person reviewing and marking up agent-produced artifacts. That serves Lucid's purpose in `CONTEXT.md`: a place to read what an agent produced and mark it up. The scope holds the existing artifact, annotation, and conversation model. It adds historical source context to an annotation, not a second conversation or a new document type.

In scope: content comparison against an earlier saved version, responsive presentation, inline note entry, transcript delivery, and restoration requests that account for current content. Proposed first-release coverage is described in Design; the non-text boundary remains an explicit scope question until answered.

Out of scope: automatic selective restore buttons, automatic merging, editing the diff, comparison of unsaved drafts, cross-artifact comparison, and a separate conversation embedded beneath every change. These do not serve the chosen annotation workflow. Whole-version Restore remains a separate existing operation with its confirmation and immutable ancestry; this RFC does not remove it. Hub registration, managed folders, and service management remain separate work.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as described in RFC 2119.

Use artifact, version, note, spot, note box, input, and transcript as defined in `CONTEXT.md`.

- **Earlier version**: the immutable version chosen as the comparison's source.
- **Reviewed version**: the saved version on the current side most recently reviewed explicitly for this send. It can be updated by an explicit pre-send refresh; after acceptance it remains historical evidence if another version arrives.
- **Current version**: the latest accepted version at the operation being described. It is not an alias for the earlier or reviewed version.
- **Dispatch version**: the current version captured when a queued input is actually delivered to a turn.
- **Revision target**: the dispatch version named for the next emission's `replaces` field. For comparison input it is the sole revision authority.
- **Comparison spot**: a spot inside a batch carrying a valid `comparison` object. Its source evidence is immutable.
- **Version hash**: lowercase SHA-256 hex over the stored document's UTF-8 bytes, as defined by `hashArtifactBytes` in the record store. It excludes no content when validating identity.
- **Stale comparison**: the reviewed version/hash no longer equals the current version/hash.
- **Comparison**: a derived reading view of two immutable versions of the same artifact. It is not a stored artifact version.
- **Passage**: a supported content block in that view, with a source address in its own version.

## Motivation

A person comparing v12 with v17 may want to bring back one explanation from v12 while keeping instructions introduced in v17. Opening a separate old document makes the relationship hard to read. Restoring all of v12 discards the desired newer material. A note on the old passage expresses the intended change while keeping the current document as the revision target.

The prototype established that note entry belongs beneath the selected passage. The transcript, agent answers, and continued discussion belong in the conversation panel. A source marker connects those two places after submission.

## Design

### Ownership and entry

The application MUST own comparison, version labels, change highlighting, and note entry. Artifacts MUST NOT need to supply a diff script, a special template, or restoration controls.

Compare with MUST replace the artifact's reading area with a comparison in the same application view. It MUST NOT automatically open a second tab, a second independent artifact, or a standalone history page. The existing shared header, logo navigation, and conversation panel remain available.

The primary operation compares a chosen earlier version against the latest saved version captured on entry. Labels MUST name both version numbers. Opening comparison, changing the earlier version, selecting text, and closing comparison MUST NOT create an input or version. A single-version artifact has no comparison action.

If the person has unsaved edits or pending ordinary notes in this view, entering comparison MUST wait until the person explicitly saves, sends, or discards that work through the existing guard. Cancelling the guard keeps the current view and all pending work. Comparison MUST NOT silently save, discard, flush, or retarget it. Changing comparison with a pending comparison draft uses the same preservation rule. Close comparison returns to the reviewed document and retains the prior reading position where possible. While comparison is open, its displayed pair MUST stay fixed even when no draft exists. A new version marks the comparison stale and offers Review latest. Automatic following can resume only after comparison closes and pending work is resolved.

### Readable changes

The comparison SHOULD preserve the reading hierarchy of headings, paragraphs, and lists. It MUST show additions and removals with explicit signs or labels as well as color. Earlier content appears before current content in reading order. Changed words within paired text passages SHOULD receive stronger emphasis than the surrounding passage, so a small edit does not appear as an unexplained replacement of an entire paragraph.

The same comparison model MUST drive both layouts:

- With sufficient width in the artifact area, earlier and current passages appear in aligned columns.
- With less width, each earlier passage is followed by its current counterpart in one column.

The conversation panel's width MUST be excluded when deciding whether two comparison columns fit. The prototype's 820 CSS-pixel artifact-area threshold is the initial reference, subject to visual verification with the production typography. Switching layout MUST preserve draft text, source selection, and submitted note references. Unchanged context appears once in the narrow layout. An absent counterpart MUST be labeled absent, not rendered as an empty added or removed passage.

The comparison MUST retain enough surrounding text to interpret a change. After stripping Lucid instrumentation and normalizing line endings, compare the complete retained source strings as well as the supported content model. If supported text is equal but those source strings differ, show "No text changes. Other source changes have not been compared" and offer inspection of both saved versions. This includes formatting, style, and unsupported-section changes. That notice is a conservative disclosure, not a claim of a visible change. If both retained source strings are equal, show "No saved-content changes." External resource changes are outside that claim. Malformed or unextractable content takes the explicit unsupported outcome instead of either equality result.

### Content extraction and matching

The comparison is derived from stored version content with Lucid instrumentation removed. Extraction MUST be inert: it MUST NOT execute artifact scripts or fetch resources. It MUST identify source passages independently in each version and MUST preserve the source text needed to explain a selection. Normalization for matching MUST NOT replace the original selected quote in a note.

The initial text coverage proposal includes headings, paragraphs, list items, quotations, captions, and preformatted text. Extract each piece once; nested blocks MUST NOT duplicate the same words. Ordinary prose whitespace reflow is ignored for matching. Preformatted whitespace remains significant.

Matching MUST be deterministic and bounded. Existing block comparison is a starting point, not an authority for historical anchors. Equal content and unambiguous source identifiers can establish correspondence. Similarity can suggest a changed passage for presentation, but MUST NOT establish a note's destination or overwrite its source address. Ambiguous matches MUST remain separate removed and added passages. Position alone MUST NOT imply that unrelated text is the same passage. Moves MUST remain visible, at least as a removal and addition.

Word alignment MUST remain bounded independently of block alignment. The implementation SHOULD reuse the existing comparison work budget of 4,000,000 alignment cells, checked before allocating a matrix. Above a budget, show labeled coarse passage replacements. This fallback MUST retain both source texts and preserve note entry. It MUST NOT silently omit a changed region or freeze the page. Algorithm details and their fixtures are part of implementation review.

Proposed non-text behavior: tables, images, embedded controls, and script-dependent sections are shown as whole-section changes or as explicitly unsupported comparisons, with an action to inspect either saved version in the existing sandboxed reader. No automatic new tab is required. Inspecting MUST preserve the active comparison and draft. External resource bytes are not versioned by storing an unchanged URL; the UI MUST NOT claim to compare those remote bytes. This boundary is pending Open Question 1.

### Inline note entry and transcript placement

Selecting words or choosing + Note on either side MUST open one small note box beneath the selected content. In the wide layout it stays on that content's side. It contains the source version, selected quote, note text, Cancel, and Send note. The normal shadcn-based controls and keyboard focus behavior apply.

The note box MUST NOT contain the conversation transcript, agent responses, a second chat composer, or a request-inspection interface. The request preview used to inspect the prototype is development evidence, not a required product control.

A person can annotate content absent from the current version. That note means "consider this earlier content," not "this text still exists in the current document." Selecting another passage with a nonempty draft MUST require resolving the draft first. Cancel removes only that draft. The user can read other content without losing it.

Send note MUST submit exactly one comparison annotation as one `queue` input through the existing input path, using the selected harness, model, and effort under the current driver rules. It MUST NOT require a Resume button or a second send in the chat composer. While a turn is running, this input waits for its next turn boundary. Existing multi-note annotation queues remain supported outside this one-note interaction and MUST NOT be flushed or mixed into a comparison send. A comparison input contains one note and one comparison context; its spots all come from the same selected source side/version. A conflicting ordinary queue must be resolved explicitly before sending.

After durable input acceptance, the inline box closes. The transcript MUST show the user's note, source quote, and source version in the normal conversation panel. The source passage retains a small marker linking to that transcript entry. The marker MUST resolve by durable input identity and note index, not array position in the current render or a wall-clock-generated client note ID. Several notes on one source can share a count marker; each remains separately readable in the transcript.

Accepted input is not proof of delivery or a completed revision. The transcript MUST use existing queued, working, rejected, and failed behavior. A send failure before acceptance MUST keep the draft. An ambiguous network result MUST be reconciled with the same idempotent input ID; retry MUST NOT create another note. A reload MUST reconstruct accepted notes and their source references from the record. Draft persistence across a full browser restart is not added by this RFC; existing navigation guards still apply.

At narrow sizes, the conversation can use the application's existing responsive placement. It MUST remain a distinct transcript region. A marker MUST take keyboard and pointer users to the corresponding entry, including when that region is off-screen. It MUST NOT insert the entire transcript between diff passages.

### Version provenance and annotation encoding

The existing `lucid-annotations` batch remains the input encoding. No new conversation event kind is required. Batch `version` MUST retain its existing meaning: the source version being discussed. A note quoting v12 while the person reviews v17 therefore has batch `version: 12`, not 17. The comparison object separately records the reviewed version; dispatch supplies the revision target.

The additive fields have the following contract:

| Field | Placement | Meaning and validation |
|---|---|---|
| `comparison` | Batch, absent for ordinary notes | Object identifying the comparison that produced this one-note input |
| `earlierVersion` | In `comparison` | Positive integer identifying the earlier side, less than `reviewedVersion` |
| `reviewedVersion` | In `comparison` | Positive integer identifying the saved document explicitly reviewed for this send |
| `reviewedHash` | In `comparison` | Version hash of `reviewedVersion` |
| `sourceVersion` | Every comparison spot | Positive integer equal to batch `version`, at or before `reviewedVersion` |
| `sourceHash` | Every comparison spot | Version hash of `sourceVersion` |

A valid comparison object is the discriminator for comparison admission. Every spot in that batch is a comparison spot and requires both source fields. A fresh comparison send with source fields but no comparison object, incomplete known comparison fields, multiple notes, or spots from different source versions MUST be refused as `E-COMP-03`. Initial capture comes from one of the displayed sides; explicit refresh can retain a source version no longer in the displayed pair. Stored legacy batches without these fields remain valid.

Existing spot ID, snippet, author, selectors, and note attachments retain their meanings. A comparison spot MUST address its own immutable source version, including when selected in an application-rendered diff. Diff wrapper IDs and indexes MUST NOT be passed off as artifact element IDs. Source selectors MUST be built against source content, excluding inserted highlighting and controls. A missing or ambiguous source address is a refusal to send that selection, not permission to attach it somewhere else.

The ordinary annotation rule to capture current human-edited text remains unchanged. Comparison notes explicitly capture labeled saved source content. Because entry is guarded against unsaved edits, they cannot silently substitute saved bytes for an active edited document. On implementation, the artifact contract MUST state this distinction in the same commit as comparison note entry.

The current snippet limit and input-size limits still apply. A truncated selection MUST be visibly marked before sending; the payload MUST NOT imply that the retained snippet contains the entire selection. Known comparison metadata is strictly validated at admission. At read time, an unusable comparison extension MUST NOT make the record unreadable: retain the valid legacy note text, source-version association, and quote, display that comparison details are unavailable, and withhold source-aware comparison controls. Ignore unknown fields under the existing stored-decoder rule. A batch with invalid legacy fields retains the existing malformed-batch presentation.

The serialized user input MUST include a concise human-readable statement naming the source version and reviewed version. Preserve the person's note text separately from application-generated context. Older version-grouped projections continue associating this batch with its source version, though they lack the new comparison navigation.

For comparison input, the annotation preamble MUST say that batch `version`, `sourceVersion`, and `reviewedVersion` are evidence, not instructions to emit against those versions. The explicit dispatch revision target is the sole authority for `replaces`. The existing batch-version instruction remains unchanged for ordinary legacy notes. No old log entry or artifact version is rewritten.

### Repeat-safe browser submission

The browser input endpoint MUST accept an optional client-generated `id` alongside its existing `text` field. The ID follows the existing wire-ID constraints. Comparison sends MUST provide it; requests without it retain the current server-generated-ID behavior. The server fixes the browser request mode to `queue`. A comparison is identified by its validated annotation metadata, not by trusting a separate client mode switch.

The client MUST create the ID once before its first submission and retain the exact serialized payload until the outcome is known. A retry with that ID and the same accepted payload returns the original accepted receipt, including durable `inputId` and the comparison note index `0`, without appending or delivering another input. Reusing an accepted ID with different text returns `E-COMP-06`. Receipt lookup MUST use the accepted input history, not merely the presence of an attempted input in the raw log. The original input text remains the durable payload evidence; no second receipt database is introduced. The existing source-protocol `input-id-reused` refusal remains unchanged.

Inside one serialized acceptance operation, the server MUST resolve previously accepted IDs before checking a fresh request's current-version precondition or queue capacity. This prevents a lost response followed by a newer artifact version from turning a successful send into a stale refusal. For a new ID, validate provenance and the reviewed base, then apply normal input admission. Concurrent duplicates MUST produce one accepted input. A known refusal before acceptance retains the draft; explicit review/edit/resubmission can use a fresh ID. An uncertain result MUST NOT use a fresh ID. Reconciliation uses resubmission of the same ID and payload, and works after server restart or input application.

### Current content and restoration

For a fresh input identity, the shared conversation input-acceptance boundary MUST atomically verify that the artifact's latest version and hash still equal `comparison.reviewedVersion` and `comparison.reviewedHash`. This guard MUST run inside the record's append transaction against its refreshed state, for every path that admits comparison metadata. An earlier HTTP-only read is insufficient. A mismatch returns a stale-comparison result without appending an input. The client retains the draft, shows that a newer version arrived, and offers to review the updated comparison.

Reviewing the newer version MUST preserve the original source quote and its version. The user then confirms Send note against the newly reviewed version. Only `comparison.reviewedVersion` and `reviewedHash` change; batch `version` and every source field retain the selected source. If that source came from the previously reviewed side, it remains addressed to the version actually selected; the refreshed comparison metadata MUST allow that historical source. On initial capture, `sourceVersion` comes from the selected side. After explicit refresh it continues to identify that preserved source version at or before the newly reviewed version. The UI MUST label that original version and MUST NOT pretend its words came from the refreshed side.

The source marker remains visible when its exact source version is one of the displayed sides. Otherwise the transcript retains the quote and an action to inspect that source. Comparison spots MUST be excluded from ordinary current-document re-anchoring when their source version is not the displayed version. Render them in the transcript as intentional historical references, with source inspection available, rather than labeling them as ordinary orphaned notes. If the exact source version is displayed, its source marker can resolve normally. Ordinary orphan semantics remain unchanged.

A newer version can also arrive after input acceptance or while the input is queued. At actual turn dispatch the driver MUST take a fresh artifact snapshot and provide its full document through the existing artifact-context mechanism, together with the original comparison note. The full document MUST be included for comparison input even when authored by the agent and even when no document-byte debt is recorded. The dispatch version MUST be at least `comparison.reviewedVersion`. An older or unverifiable dispatch snapshot is a context failure, not a substitute target. The dispatch preamble MUST explicitly name the dispatch version as the sole revision target and the reviewed version as historical context. User-authored saves and unrelated newer content MUST be included. Do not copy the complete document into every note or into a new durable comparison store.

This context preparation is a new obligation for each delivery adapter: headless-session at its queue boundary, headless-turn before spawn, and interactive hooks at their delivery boundary. Observe-only delivery and the disabled cooperative rung gain no capability from this RFC. A delivery adapter unable to provide the comparison contract MUST hold the accepted note pending and report the limitation; it MUST NOT deliver a historical batch through a legacy preamble. Existing preference rules do not convert an interactive session into a managed driver.

If required current context is busy, unreadable, missing, older than the reviewed version, or too large for the adapter's supported context transport, preparation MUST return `E-COMP-07` before dispatch or an applied disposition. Keep the accepted input pending and publish a bounded visible failure tied to its input identity. Do not use a rejected disposition as terminal cancellation or immediately redeliver the same input. After the adapter's existing bounded read attempt fails, this participation MUST stop retrying that input until a newer readable version is observed or the source is explicitly reattached after recovery. There is no timer-driven retry loop and no automatic harness takeover. The transcript retains the accepted note and states that delivery is waiting for current content. Each adapter's implementation tests MUST demonstrate this held state and its recovery trigger.

The agent decides how to satisfy the request in current content. A successful revision MUST use the existing emission path and append a new immutable version. The browser MUST NOT implement Send note by copying old bytes or applying a positional reverse patch. If the artifact changes again before emission, existing stale-base refusal applies. The agent receives current content for recovery; the UI MUST NOT silently rebase an old patch or claim restoration succeeded on refusal.

Example: a note quotes v12 while comparing with v17: "Bring this explanation back, but keep the new hub instructions." If v18 arrives before Send, the person reviews v18 first. If v18 arrives after acceptance, the driver includes v18 at dispatch. The resulting revision targets the actual current base and retains the original v12 quote as evidence. This mechanism preserves the input and base discipline; it cannot guarantee that a model follows every editorial instruction. The user reviews the resulting artifact normally.

### Compatibility and removal of the old comparison presentation

Saved artifacts and ordinary annotation batches require no migration. New metadata is additive. Older readers can show the human-readable input but cannot offer source-aware diff navigation; they MUST NOT be claimed to support that navigation.

The new content comparison replaces the primary Compare with presentation. The existing source-line diff remains an internal verification utility during the migration; this RFC does not add a second user-facing comparison mode. Read-only version URLs and whole-version Restore retain their contracts. Production implementation MUST use the actual artifact and conversation components, not promote the prototype's sample data or simulated transcript into the application.

## State Machine

| State | Action or event | Result |
|---|---|---|
| Reading saved content | Compare with an earlier version, no pending-work conflict | Load two immutable versions; no input |
| Loading comparison | Both sides readable | Ready comparison |
| Loading comparison | Either side unreadable | Named-side failure; retain reading state |
| Loading comparison | Unsupported or unsafe extraction | Unsupported result, `E-COMP-04`; saved-version inspection remains available |
| Loading comparison | Alignment budget exceeded | Coarse ready comparison, `E-COMP-05`; retain source text and valid note entry |
| Loading comparison | Supported text equal, retained source differs | Ready comparison with other-source-changes notice and inspection |
| Ready comparison, no draft | New version arrives | Keep displayed pair fixed; mark stale; offer Review latest |
| Ready comparison | Select source text or + Note | Inline draft with immutable source evidence |
| Inline draft | Select another passage with nonempty text | Keep draft; require Send or Cancel |
| Inline draft | New version arrives | Keep draft and displayed pair; mark comparison stale |
| Stale comparison | Review newer version | Refresh reviewed version and matching; retain original source evidence; await Send |
| Stale comparison | Cancel draft | Remove only draft; retain stale displayed pair and latest-version notice |
| Stale comparison | Send without review | Disable Send in UI; fresh server request returns `E-COMP-02` without an accepted input |
| Inline draft | Send note | Disable duplicate submission; submit stable input ID and expected reviewed base |
| Sending | Stale base or refusal before acceptance | Retain draft and show actionable reason |
| Sending | Transport outcome unknown | Reconcile same input ID and exact payload; no second append |
| Sending | Same identity/payload already accepted | Return original receipt before freshness/capacity checks; no second append |
| Sending | Accepted identity, different payload | Conflict `E-COMP-06`; original input unchanged |
| Sending | Input durably accepted | Close editor; show transcript entry and source marker |
| Accepted input | Queued or working | Existing input lifecycle; no simulated success |
| Accepted input | Current context unavailable at dispatch | Hold pending, surface `E-COMP-07`; no applied disposition, dispatch, or immediate redelivery |
| Held input | Newer readable context or explicit source reattachment | Retry preparation once under the adapter's bounded read policy; retain original input ID |
| Agent revision | Current-base emission accepted | New immutable artifact version; existing following guards |
| Agent revision | Stale-base emission refused | Existing recovery; original note remains in transcript |
| Comparison | Close, change version, or navigate with pending work | Existing guard; no silent loss |

An accepted note cannot be removed from the log by cancelling a later draft or changing comparison. Comparison loading and extraction MUST be cancellable when the target view changes. The UI MUST show a bounded failure or coarse result rather than an indefinite working indicator when comparison computation cannot finish.

## Error Handling

These are proposed comparison-specific codes; ordinary authorization, input-disposition, and artifact-emission errors retain their existing codes.

| Code | Meaning | Required recovery |
|---|---|---|
| `E-COMP-01` | Earlier or reviewed version unreadable | Name the failed side; preserve prior reading state; do not treat it as empty |
| `E-COMP-02` | Expected reviewed version/hash is stale | No input appended; preserve draft; offer review of latest content |
| `E-COMP-03` | Comparison provenance malformed or source selection invalid | No input appended; preserve note text; ask for a valid selection |
| `E-COMP-04` | Content cannot be compared safely or meaningfully | Explicit unsupported result; retain access to saved versions |
| `E-COMP-05` | Bounded computation falls back to coarse output | Label coarse output; retain source selection where valid |
| `E-COMP-06` | Accepted input identity reused with a different payload | Preserve the original accepted input; refuse the conflicting request |
| `E-COMP-07` | Required dispatch context or adapter capability unavailable | Hold accepted input pending; show bounded failure; await defined recovery trigger |

Errors MUST carry an operation and readable reason. They MUST NOT include record secrets or unbounded artifact excerpts. A computation fallback is informational, not an input refusal. No comparison action auto-retries a rejected input. Transport recovery follows Repeat-safe browser submission and distinguishes acceptance from delivery. `E-COMP-02` MUST NOT be returned for an already accepted identity and identical payload. Missing context at driver dispatch MUST be surfaced to the user; do not substitute the earlier version as the revision base.

## Security Considerations

Artifact content is untrusted. The comparison renderer MUST output inert text or an explicit allowlist of static structure. It MUST NOT insert artifact HTML into the privileged application DOM. Scripts, event handlers, remote resources, and active controls are excluded from this renderer. Inspecting an original continues to use the existing opaque-origin sandbox and authenticated frame-message boundary.

Comparison reads and input writes retain the loopback server's session-token and origin checks. Artifact IDs remain validated identifiers, never paths. The server MUST verify version ownership, hashes, source metadata, and input bounds against the selected record. Client-supplied current-version claims are not authoritative.

The selected quote is evidence, not an instruction from the application. Prompt construction MUST delimit historical content from the person's request and latest artifact context. Content that resembles fences, HTML, or instructions MUST remain data throughout rendering and encoding. These boundaries reduce injection opportunities; they do not establish that a model will ignore malicious text.

The operation needs no new host permissions, external service, or shared storage. Its write effect is limited to ordinary inputs and accepted artifact revisions in one record. Full versions remain immutable and independently readable. Sensitive content MUST NOT be placed in URLs or new debug logs. Comparison computation and excerpts remain bounded by existing artifact and input limits plus the alignment budgets above.

## Alternatives Considered

- **Notes in a separate review rail:** prototype A kept all notes beside the diff. The user preferred writing directly next to the content. The normal conversation panel remains useful after submission.
- **The whole conversation inline:** this was the first version of prototype B. The user rejected placing the transcript under the change; only the note box belongs there.
- **One change at a time:** prototype C provided Previous and Next controls. The user chose inline notes in the full comparison instead.
- **Independent old-version view:** keeps the original rendering but makes the relationship between versions hard to inspect. It remains an explicit inspection path for unsupported content, not the comparison's primary layout.
- **Selective reverse patch or Restore this passage:** appears quick but assumes old content still has a safe destination. The chosen workflow asks the agent to revise current content and preserves stale-base validation.
- **Artifact-owned diff UI:** can preserve custom rendering, but would require each artifact to implement application history and annotation behavior. Ownership remains in Lucid.

## Implementation Plan

After RFC review and acceptance, draft vertical implementation tickets in this order. Each step depends on the prior contract being settled, and each requires `bun run check` without waived gates.

1. **Repeat-safe browser sends.** Deliver stable optional browser request identities, replay of accepted receipts before fresh-request preconditions, payload conflicts, and restart/concurrency verification. Existing source-protocol duplicate semantics remain unchanged. Update the browser input contract in the same commit. This slice is independently verifiable and supplies the transport needed by comparison notes.
2. **Readable real-version comparison.** Connect immutable saved versions to a bounded inert model and responsive comparison in the existing artifact view. Verify small word changes, repeated text, moves, malformed input, unsupported content, source addresses, and coarse fallback. This slice is independent of repeat-safe sends. Keep ordinary reading/editing/annotations working, with comparison note actions disabled until slice 3. Update the current comparison contract when switching the UI. Roll back that switch if coverage or isolation fails; no stored-data migration is required.
3. **Historical notes that revise current content.** Depends on both earlier slices. Connect source provenance, guarded acceptance, the inline editor, replayable transcript markers, and comparison-aware dispatch across supported adapters as one complete path. Test newer versions before send, during queueing, and during generation, plus missing-context hold/recovery, legacy batches, retries, attachments, and driver changes. Verify pointer/keyboard interaction and 390, 768, and 1440 layouts in both themes. Update each changed current artifact, source, driver, and design contract in this implementation commit. Keep prototype assets on their throwaway branch; retire the active RFC only after delivery under the documentation lifecycle.

Deterministic fake-harness tests are the gate for delivery and revision behavior. A live-harness confirmation can follow on demand; it cannot replace those tests. The prototype's successful layout checks establish the chosen interaction only, not the production algorithm, protocol, or persistence.

## Open Questions

1. **First-release coverage:** detailed text, heading, and list diffs with whole-section or unsupported treatment for tables, images, and interactive content, or detailed non-text comparison now? The recommendation is the text-focused scope so the feature makes precise claims about what it compares. The user decides this scope boundary; confirmation is pending. Acceptance requires a defined fallback that never hides unexamined changes.
2. **Extraction and matching acceptance:** retain and adapt existing block extraction and matching, or replace their internals behind the same boundary? This is an engineering review decision. The criterion is passing the repeated-text, arbitrary-rewrite, malformed-document, source-address, and bounded-computation fixtures without claiming false correspondence. The draft recommends reuse where those checks pass and conservative unmatched output where they do not. It does not require a new dependency.

The interaction decision is settled. These questions do not reopen inline entry or move the transcript into the diff. Status remains Draft until scope and technical review are resolved.

## Response to the unversioned review

Revision 1 answers [the independent review](14_annotated-content-comparison.review-unversioned.md), produced by `opus-5@claude`. Its complete message was captured although the harness later timed out. The review is document-level evidence; the revised behavior still needs implementation tests.

| Finding | Disposition in revision 1 |
|---|---|
| F1 | Added stable request IDs, accepted-payload conflict handling, receipt fields, and accepted-identity precedence over freshness/capacity. |
| F2 | Batch version remains the quoted source version; reviewed version is separate; dispatch version is the sole emission authority and cannot be older than the reviewed version. |
| F3 | Made full-byte context mandatory for comparison dispatch, specified adapter obligations, and added a held-input failure state, error code, and bounded recovery triggers. |
| F4 | Blocked comparison entry until unsaved edits are explicitly resolved; scoped saved-source capture apart from ordinary edited-content annotations. |
| F5 | Defined the batch discriminator, one comparison note per input, one source version per note, and no automatic mixing or flushing of ordinary queues. |
| F6 | Froze the displayed pair even without a draft; added stale Cancel, Send, and Review transitions. |
| F7 | Added unsupported/coarse/equal-text states and a concrete retained-source comparison with explicit other-source-changes presentation. |
| F8 | Preserved batch version as source provenance for older projections; added reviewedVersion instead of reinterpreting the existing field. |
| F9 | Separated strict admission validation from tolerant stored-note rendering with unavailable comparison controls. |
| F10 | Defined dispatch version, revision target, comparison spot, stale comparison, and version hash. |
| F11 | Fixed comparison input mode to queue, including sends during a running turn. |
| F12 | Excluded intentional historical spots from current-document re-anchoring and ordinary orphan presentation. |
| F13 | Required the existing comparison contract to change with the first UI switch, and all later contracts with their implementation slices. |

The non-text product boundary remains pending the user's answer. No finding is treated as approval of that boundary or as proof that production code already meets these requirements.

## References

### Normative

- [Product vocabulary](../../CONTEXT.md) - artifacts, notes, spots, inputs, and transcript ownership.
- [Artifact contracts](../artifacts.md) - immutable versions, saves, restoration, anchoring, input encoding, and browser isolation.
- [Document edits preserve evidence](../adr/0007-document-edits-preserve-evidence.md) - immutable history and unresolved source evidence.
- [Source protocol](../skill-chat-substrate.md) - input identity, disposition, and delivery behavior.
- [Drivers](../drivers.md) - harness preferences and current artifact context.

### Informative

- Prototype branch `prototype/hub-workflow`, commit `059ced3` - inline editor beside source content, separate conversation panel, simulated delivery. The user approved this interaction on 2026-09-07.
- [Annotation encoding](../../src/protocol/annotations.ts) - existing batch-level version and per-spot evidence; these need distinct source provenance for comparison notes.
- [Block comparison](../../src/server/client/version-diff.ts) - existing extraction and correspondence candidates; reuse requires the stricter provenance and ambiguity checks in this RFC.
- [Source-line comparison](../../src/server/client/line-diff.ts) - existing bounded alignment and coarse fallback, retained for verification.

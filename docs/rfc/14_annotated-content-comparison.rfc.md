---
number: 14
title: "Annotated content comparison"
type: feature
status: Accepted
revision: 4
author: Codex
date: 2026-09-07
---

# RFC-14: Annotated content comparison

## Abstract

Lucid's comparison view does not make content changes clear enough to review or discuss. This proposal replaces its primary comparison presentation with a readable content diff inside the artifact view. A person writes a small note beneath selected earlier or current content; submitting it adds the note to the existing conversation transcript. The agent receives the historical quote and current document separately, so a request to restore an explanation produces a new revision without rolling back unrelated changes.

## Introduction

The user approved the inline-note design after trying three prototypes. The approval is for the interaction: a local note box beside the content, with the conversation kept in its own panel. This draft specifies the production behavior. It does not treat the prototype's authored paragraph pairs or simulated sends as an implementation.

The user is one person reviewing and marking up agent-produced artifacts. That serves Lucid's purpose in `CONTEXT.md`: a place to read what an agent produced and mark it up. The scope holds the existing artifact, annotation, and conversation model. It adds historical source context to an annotation, not a second conversation or a new document type.

Revision 2 answers the revision-1 review. Reload recovery for submitted notes, defined delivery holds, preserved draft placement, exact queue guards, and comparison coverage notices serve that same person completing the same annotation. These choices hold scope. General draft synchronization, configurable queue priorities, and detailed style comparison are excluded because they are not needed to finish this workflow.

Revision 4 answers the revision-3 review by distinguishing why an accepted note is waiting and what can release it. This helps the same person continue the existing annotation workflow and holds scope. It adds no delivery capability or recovery action.

In scope: content comparison against an earlier saved version, responsive presentation, inline note entry, transcript delivery, and restoration requests that account for current content. The user approved the text-focused first release on 2026-09-07. Revision 3 records that decision: detailed supported-text changes, with explicit non-text coverage limits and inspection of either saved version. Detailed table, image, and interactive-content comparison is outside this release.

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
- **Unresolved send**: a submitted request whose acceptance or refusal the browser has not confirmed. It is distinct from an unsent draft and from an accepted input awaiting delivery.
- **Held input**: an accepted comparison input with a queued disposition whose required dispatch context could not be prepared. It remains pending while other eligible inputs can run.

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

When supported text differs, the comparison MUST also show a compact coverage notice beside its version labels: "Text comparison. Other source changes may not be shown." Inspection of both saved versions remains available from that notice. The notice does not depend on detecting a particular unsupported change: it also appears for a text-only revision, because text alignment does not prove that all source changes were examined. A paragraph edit combined with a style, attribute, image, or control change therefore cannot suppress the coverage notice. This disclosure implements the approved text-focused scope without requiring a second source-diff mode.

### Content extraction and matching

The comparison is derived from stored version content with Lucid instrumentation removed. Extraction MUST be inert: it MUST NOT execute artifact scripts or fetch resources. It MUST identify source passages independently in each version and MUST preserve the source text needed to explain a selection. Normalization for matching MUST NOT replace the original selected quote in a note.

The first release MUST support headings, paragraphs, list items, quotations, captions, and preformatted text. Extract each piece once; nested blocks MUST NOT duplicate the same words. Ordinary prose whitespace reflow is ignored for matching. Preformatted whitespace remains significant.

Matching MUST be deterministic and bounded. Existing block comparison is a starting point, not an authority for historical anchors. Equal content and unambiguous source identifiers can establish correspondence. Similarity can suggest a changed passage for presentation, but MUST NOT establish a note's destination or overwrite its source address. Ambiguous matches MUST remain separate removed and added passages. Position alone MUST NOT imply that unrelated text is the same passage. Moves MUST remain visible, at least as a removal and addition.

Word alignment MUST remain bounded independently of block alignment. The implementation SHOULD reuse the existing comparison work budget of 4,000,000 alignment cells, checked before allocating a matrix. Above a budget, show labeled coarse passage replacements. This fallback MUST retain both source texts and preserve note entry. It MUST NOT silently omit a changed region or freeze the page. Algorithm details and their fixtures are part of implementation review.

Tables, images, embedded controls, and script-dependent sections MUST be shown as whole-section changes where comparison is supported, or explicitly labeled as not compared, with an action to inspect either saved version in the existing sandboxed reader. This release does not require detailed cell, image, or interactive-state diffs. No automatic new tab is required. Inspecting MUST preserve the active comparison and draft. External resource bytes are not versioned by storing an unchanged URL; the UI MUST NOT claim to compare those remote bytes.

### Inline note entry and transcript placement

Selecting words or choosing + Note on either side MUST open one small note box beneath the selected content. In the wide layout it stays on that content's side while that source version is displayed. The retained-source placement below applies if an explicit refresh removes that version from the pair. The box contains the source version, selected quote, note text, Cancel, and Send note. The normal shadcn-based controls and keyboard focus behavior apply.

The note box MUST NOT contain the conversation transcript, agent responses, a second chat composer, or a request-inspection interface. The request preview used to inspect the prototype is development evidence, not a required product control.

A person can annotate content absent from the current version. That note means "consider this earlier content," not "this text still exists in the current document." Selecting another passage with a nonempty draft MUST require resolving the draft first. Cancel removes only that draft. The user can read other content without losing it.

Send note MUST submit exactly one comparison annotation as one `queue` input through the existing input path, using the selected harness, model, and effort under the current driver rules. It MUST NOT require a Resume button or a second send in the chat composer. While a turn is running, this input waits for its next turn boundary. Existing multi-note annotation queues remain supported outside this one-note interaction and MUST NOT be flushed or mixed into a comparison send. A comparison input contains one note and one comparison context; its spots all come from the same selected source side/version.

A conflicting ordinary queue is a nonempty local queue in this browser page with the same `(conversationId, artifactId, version)` as the comparison note's `(conversationId, artifactId, sourceVersion)`. Check it on each fresh Send note, before creating a request ID. If it exists, preserve the comparison draft and require explicit resolution of that queue through the ordinary-note guard, at its original version. Cancelling the guard sends neither queue. Queues for other source versions, records, or browser pages do not block this send and MUST remain unchanged. The entry guard still covers pending work in the view being left; it does not flush every version's queue. This local guard MUST NOT delay reconciliation of an unresolved send, whose exact payload has already been fixed.

After durable input acceptance, the inline box closes. The transcript MUST show the user's note, source quote, and source version in the normal conversation panel. The source passage retains a small marker linking to that transcript entry. The marker MUST resolve by durable input identity and note index, not array position in the current render or a wall-clock-generated client note ID. Several notes on one source can share a count marker; each remains separately readable in the transcript.

Accepted input is not proof of delivery or a completed revision. The transcript MUST use existing queued, working, rejected, and failed behavior, with the held-input explanation specified below. A send failure before acceptance MUST keep the draft. An ambiguous network result MUST be reconciled with the same idempotent input ID; retry MUST NOT create another note. A reload MUST reconstruct accepted notes and their source references from the record. Unresolved sends survive a same-tab reload under Repeat-safe browser submission. Unsent drafts and recovery after closing the tab or clearing browser storage gain no persistence guarantee; existing navigation guards still apply.

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

Reconstruct the existing Lucid element ID from the source document's inert DOM using the reader's document-order assignment before filtering comparison passages or inserting controls. Scope that ID to its source version and hash. The comparison and saved-source reader MUST agree on this address; neither a filtered passage index nor an authored HTML ID substitutes for it. Verify this agreement on reload and on source inspection.

The ordinary annotation rule to capture current human-edited text remains unchanged. Comparison notes explicitly capture labeled saved source content. Because entry is guarded against unsaved edits, they cannot silently substitute saved bytes for an active edited document. On implementation, the artifact contract MUST state this distinction in the same commit as comparison note entry.

The current snippet limit and input-size limits still apply. Preserving the limit does not require reuse of whitespace-collapsing capture: comparison snippets MUST preserve the selected source text, including significant preformatted whitespace, up to the cap. A truncated selection MUST be visibly marked before sending; the payload MUST NOT imply that the retained snippet contains the entire selection. Known comparison metadata is strictly validated at admission. At read time, an unusable comparison extension MUST NOT make the record unreadable: retain the valid legacy note text, source-version association, and quote, display that comparison details are unavailable, and withhold source-aware comparison controls. Ignore unknown fields under the existing stored-decoder rule. A batch with invalid legacy fields retains the existing malformed-batch presentation.

The serialized user input MUST include a concise human-readable statement naming the source version and reviewed version. Preserve the person's note text separately from application-generated context. Older version-grouped projections continue associating this batch with its source version, though they lack the new comparison navigation.

For comparison input, the annotation preamble MUST say that batch `version`, `sourceVersion`, and `reviewedVersion` are evidence, not instructions to emit against those versions. The explicit dispatch revision target is the sole authority for `replaces`. The existing batch-version instruction remains unchanged for ordinary legacy notes. No old log entry or artifact version is rewritten.

### Repeat-safe browser submission

The browser input endpoint MUST accept an optional client-generated `id` alongside its existing `text` field. The ID follows the existing wire-ID constraints. Comparison sends MUST provide it; requests without it retain the current server-generated-ID behavior. The server fixes the browser request mode to `queue`. A comparison is identified by its validated annotation metadata, not by trusting a separate client mode switch.

The client MUST create the ID once before its first submission and retain the exact serialized payload until the outcome is known. A retry with that ID and the same accepted payload returns the original accepted receipt, including durable `inputId` and the comparison note index `0`, without appending or delivering another input. Reusing an accepted ID with different text returns `E-COMP-06`. Receipt lookup MUST use the accepted input history, not merely the presence of an attempted input in the raw log. The original input text remains the durable payload evidence; no second receipt database is introduced. The existing source-protocol `input-id-reused` refusal remains unchanged.

Inside one serialized acceptance operation, the server MUST resolve previously accepted IDs before checking a fresh request's current-version precondition or queue capacity. This prevents a lost response followed by a newer artifact version from turning a successful send into a stale refusal. For a new ID, validate provenance and the reviewed base, then apply normal input admission. Concurrent duplicates MUST produce one accepted input. A known refusal before acceptance retains the draft; explicit review/edit/resubmission can use a fresh ID. An uncertain result MUST NOT use a fresh ID. Reconciliation uses resubmission of the same ID and payload, and works after server restart or input application.

Before the first network attempt, the browser MUST write the unresolved send to this tab's `sessionStorage`. The entry carries a format version, the conversation ID, artifact ID, input ID, and the exact serialized request body. Store at most one unresolved comparison send per conversation in the tab; disable another comparison submission for that conversation until this one resolves. Read the entry back before sending. A failed write or unequal readback returns local `E-COMP-08`, preserves the unsent draft, and makes no network attempt. The entry contains the already bounded request, not a second document snapshot or attachment blob store. This choice uses the documented same-tab reload lifetime of [sessionStorage](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage).

A transport failure, unreadable response, or 401 response leaves that entry intact. A 401 retains the existing Reload action; the browser MUST NOT silently renew the invalid token. After a same-origin reload obtains a new token, validate the saved entry's shape, bounds, and conversation association, then show the recovered send with Retry. That explicit recovery action reconciles its unchanged ID and body through the existing endpoint. Reconcile only when its conversation is open; do not submit entries for other conversations in the background. Reload alone MUST NOT resend a saved request: its previous result might have been known before a cleanup failure. While unresolved, editing the serialized note, changing its reviewed base, cancelling it as if it were unsent, or minting a replacement ID is prohibited. A failed reconciliation stays visible and permits retry with the same request, without a timer loop.

An accepted receipt naming the submitted ID clears the unresolved entry and restores the normal transcript/source-marker state. An explicit input-admission refusal for that request, including `E-COMP-02` or `E-COMP-06`, restores its note text and source evidence to an editable draft, then clears the entry. Authentication failure is not such an admission refusal: it says nothing about a previous attempt. The stale draft requires Review latest before a fresh Send. A receipt for another ID or an undecodable result remains uncertain. If entry cleanup fails, block a new comparison send in this tab until cleanup succeeds; replay of the retained entry remains repeat-safe. A malformed saved entry MUST NOT be submitted or silently replaced with a new ID; show local `E-COMP-08` and retain any readable note as text. The person can inspect the transcript and explicitly discard unusable local recovery data, with a statement that discarding it does not cancel an accepted input. That action MUST NOT send a replacement note.

### Current content and restoration

For a fresh input identity, the shared conversation input-acceptance boundary MUST atomically verify that the artifact's latest version and hash still equal `comparison.reviewedVersion` and `comparison.reviewedHash`. This guard MUST run inside the record's append transaction against its refreshed state, for every path that admits comparison metadata. An earlier HTTP-only read is insufficient. A mismatch returns a stale-comparison result without appending an input. The client retains the draft, shows that a newer version arrived, and offers to review the updated comparison.

Reviewing the newer version MUST preserve the original source quote and its version. The user then confirms Send note against the newly reviewed version. Only `comparison.reviewedVersion` and `reviewedHash` change; batch `version` and every source field retain the selected source. If that source came from the previously reviewed side, it remains addressed to the version actually selected; the refreshed comparison metadata MUST allow that historical source. On initial capture, `sourceVersion` comes from the selected side. After explicit refresh it continues to identify that preserved source version at or before the newly reviewed version. The UI MUST label that original version and MUST NOT pretend its words came from the refreshed side.

If an unsent draft's source version leaves both displayed sides, retain its captured excerpt and the same note box in one section immediately below the comparison labels and above the passage rows. Label it "Your note on vN" with the actual source version. This section spans the comparison reading area in both layouts; it is not a third comparison column. It contains only the immutable excerpt and the small editor with Send note and Cancel, never a transcript. Do not attach it beneath a guessed match in the new version. On completing an explicit Review latest action, move focus to the preserved editor, restore its text selection, and bring it into view. An automatic version-arrival notice MUST NOT move focus. Send still uses the newly reviewed base and the original source; Cancel removes only this draft and retained excerpt. Accepted notes use the transcript and inspection rule below.

The source marker remains visible when its exact source version is one of the displayed sides. Otherwise the transcript retains the quote and an action to inspect that source. Comparison spots MUST be excluded from ordinary current-document re-anchoring when their source version is not the displayed version. Render them in the transcript as intentional historical references, with source inspection available, rather than labeling them as ordinary orphaned notes. If the exact source version is displayed, its source marker can resolve normally. Ordinary orphan semantics remain unchanged.

A newer version can also arrive after input acceptance or while the input is queued. At actual turn dispatch the driver MUST take a fresh artifact snapshot and provide its full document through the existing artifact-context mechanism, together with the original comparison note. The full document MUST be included for comparison input even when authored by the agent and even when no document-byte debt is recorded. The dispatch version MUST be at least `comparison.reviewedVersion`. An older or unverifiable dispatch snapshot is a context failure, not a substitute target. The dispatch preamble MUST explicitly name the dispatch version as the sole revision target and the reviewed version as historical context. User-authored saves and unrelated newer content MUST be included. Do not copy the complete document into every note or into a new durable comparison store.

This context preparation is a new obligation for each delivery adapter: headless-session at its queue boundary, headless-turn before spawn, and interactive hooks at their delivery boundary. Comparison delivery through hooks MUST include the artifact emission teaching as well as the comparison preamble and current content; the current absence of interactive emission teaching is not a capability claim for this new path. Observe-only delivery and the disabled cooperative rung gain no capability from this RFC. A delivery adapter unable to provide the comparison contract MUST hold the accepted note pending and report the limitation; it MUST NOT deliver a historical batch through a legacy preamble. Existing preference rules do not convert an interactive session into a managed driver.

If required current context is busy, unreadable, missing, older than the reviewed version, or too large for the adapter's supported context transport, preparation MUST return `E-COMP-07` before dispatch or an applied disposition. An adapter unable to provide comparison delivery returns the same error. On entering a hold, ensure the input has a durable `queued` disposition: emit it if not already queued, otherwise leave it unchanged. Do not emit `applied` or `rejected` for a preparation failure. Publish a bounded nonterminal error carrying the input ID, artifact ID, and the latest version number observed at that failed preparation, or the reviewed version if no head is readable. This is an existing error event with comparison context, not a new disposition or event kind. The transcript MUST show the accepted note as queued, with an explanation of the failed condition and the applicable recovery below. It MUST NOT show it as working or terminally failed.

| Failed condition | Queued explanation | Recovery guidance |
|---|---|---|
| Current document is busy, unreadable, missing, or older than the reviewed version | "Current document unavailable" plus the specific readable reason | A newer readable saved version permits another attempt. If the same version is repaired, explicitly reattach the source to permit another attempt. |
| The attachment cannot deliver comparison notes | "This session cannot receive comparison notes" | Explicitly attach a source that supports comparison delivery. A newer document alone does not supply that capability. |
| The document exceeds the supported context transport limit | "Document too large for this session" | Provide a newer saved version that fits, or explicitly attach a source whose delivery path can carry the full document. Never truncate the document to release the hold. |

The explanation MUST describe the condition established by the failed preparation, not guess another cause. The recovery guidance uses the existing newer-version and explicit-attachment triggers below; it does not add a Retry or Resume action for held delivery. A trigger permits verification, not a promise of recovery. If another bounded preparation attempt fails for a different reason, update the queued explanation to that reason while retaining the earlier error as history.

A held input MUST be skipped when choosing the next queue input. Other eligible inputs, including ordinary inputs, run in their original acceptance order. A held input that becomes eligible resumes its place in that order at the next available boundary, without interrupting an active turn. Its later turn and applied disposition MUST remain associated with its original input ID, not its old position in a delivery array. Existing admission and in-flight limits remain unchanged; a hold neither applies the input nor frees capacity by dropping it. If every input is held, the adapter waits and remains idle rather than starting an empty turn.

Within one source participation, the failed preparation suppresses further attempts for that input until a strictly newer artifact head than the one recorded at failure is observed. That observation permits one bounded preparation attempt at the next delivery boundary. If it fails, retain `queued`, update the failed-head version, and return to the hold. Replayed input delivery, heartbeats, and later ordinary inputs without a newer head are not recovery triggers. A new explicit source attachment also permits one bounded recovery attempt for still-pending inputs, including when the same version has become readable after repair. It is an attempt to verify recovery, not proof of it; failure establishes the hold in that participation. A hold alone MUST NOT cause detachment, reopening, or takeover merely to obtain another attempt. There is no timer-driven retry loop.

After successful preparation, actual delivery follows the adapter's existing acknowledgement rule and records `applied` only when the input reaches its turn. The held explanation is then superseded, while the earlier error remains history. A delivery failure after preparation follows the existing delivery protocol, not the context-hold rule. Each adapter's tests MUST cover one held comparison input, a later ordinary input, a version that releases the hold, and reattachment, proving identity, disposition order, and bounded retries throughout.

The agent decides how to satisfy the request in current content. A successful revision MUST use the existing emission path and append a new immutable version. The browser MUST NOT implement Send note by copying old bytes or applying a positional reverse patch. If the artifact changes again before emission, existing stale-base refusal applies. The agent receives current content for recovery; the UI MUST NOT silently rebase an old patch or claim restoration succeeded on refusal.

Example: a note quotes v12 while comparing with v17: "Bring this explanation back, but keep the new hub instructions." If v18 arrives before Send, the person reviews v18 first. If v18 arrives after acceptance, the driver includes v18 at dispatch. The resulting revision targets the actual current base and retains the original v12 quote as evidence. This mechanism preserves the input and base discipline; it cannot guarantee that a model follows every editorial instruction. The user reviews the resulting artifact normally.

### Compatibility and removal of the old comparison presentation

Saved artifacts and ordinary annotation batches require no migration. New metadata is additive. Older readers can show the human-readable input but cannot offer source-aware diff navigation; they MUST NOT be claimed to support that navigation.

The new content comparison replaces the primary Compare with presentation. The existing source-line diff remains an internal verification utility during the migration; this RFC does not add a second user-facing comparison mode. Read-only version URLs and whole-version Restore retain their contracts. Production implementation MUST use the actual artifact and conversation components, not promote the prototype's sample data or simulated transcript into the application.

The browser boundary keeps reload-based token recovery; slice 1 adds preservation of unresolved comparison requests across that reload. The reading contract gains the comparison-open following guard with slice 2. Slice 3 updates the interactive emission-teaching exception and defines the comparison-specific queued hold and scheduling rule in the driver and source contracts. These are proposed contract changes, not claims that the current implementation already supports them.

## State Machine

| State | Action or event | Result |
|---|---|---|
| Reading saved content | Compare with an earlier version, no pending-work conflict | Load two immutable versions; no input |
| Loading comparison | Both sides readable | Ready comparison |
| Loading comparison | Either side unreadable | Named-side failure; retain reading state |
| Loading comparison | Unsupported or unsafe extraction | Unsupported result, `E-COMP-04`; saved-version inspection remains available |
| Loading comparison | Alignment budget exceeded | Coarse ready comparison, `E-COMP-05`; retain source text and valid note entry |
| Loading comparison | Supported text equal, retained source differs | Ready comparison with other-source-changes notice and inspection |
| Loading comparison | Supported text differs | Ready comparison with text changes, coverage notice, and inspection, including mixed source changes |
| Ready comparison, no draft | New version arrives | Keep displayed pair fixed; mark stale; offer Review latest |
| Ready comparison | Select source text or + Note | Inline draft with immutable source evidence |
| Inline draft | Select another passage with nonempty text | Keep draft; require Send or Cancel |
| Inline draft | New version arrives | Keep draft and displayed pair; mark comparison stale |
| Stale comparison | Review newer version | Refresh reviewed version and matching; retain original source evidence; await Send |
| Stale comparison with an unsent draft | Review removes source version from both sides | Keep excerpt and editor above passage rows; label original source; focus preserved editor |
| Stale comparison | Cancel draft | Remove only draft; retain stale displayed pair and latest-version notice |
| Stale comparison | Send without review | Disable Send in UI; fresh server request returns `E-COMP-02` without an accepted input |
| Inline draft | Fresh Send with a same-source ordinary queue | Preserve draft; resolve that page-local queue at its original version; no comparison request |
| Inline draft | Send note after local guards pass | Persist and verify unresolved request before network attempt; disable duplicate submission |
| Inline draft | Recovery storage write/readback fails | Local `E-COMP-08`; retain draft; no network attempt |
| Sending | Stale base or refusal before acceptance | Retain draft and show actionable reason |
| Sending | Transport outcome unknown | Reconcile same input ID and exact payload; no second append |
| Unresolved send | 401 after server restart | Retain stored ID and body; require existing Reload action; no token renewal or replacement ID |
| Reloaded conversation | Valid unresolved entry and fresh token | Show recovered send and Retry; reload alone does not submit |
| Recovered send | Explicit Retry | Reconcile unchanged request; recover accepted receipt or restore refused draft; clear entry after known result |
| Reloaded conversation | Malformed recovery entry | Local `E-COMP-08`; no send; retain readable note; allow explicit discard without cancelling or replacing input |
| Known send outcome | Recovery entry cleanup fails | Keep outcome visible; block another comparison send until cleanup succeeds |
| Sending | Same identity/payload already accepted | Return original receipt before freshness/capacity checks; no second append |
| Sending | Accepted identity, different payload | Conflict `E-COMP-06`; original input unchanged |
| Sending | Input durably accepted | Close editor; show transcript entry and source marker |
| Accepted input | Queued or working | Existing input lifecycle; no simulated success |
| Accepted input | Current context unavailable, comparison delivery unsupported, or document too large at dispatch | Ensure queued disposition; record `E-COMP-07` and failed-head version; show cause-specific explanation and recovery guidance; no application or dispatch |
| Held input | Later eligible queue input | Skip hold; run eligible inputs in acceptance order; keep held note queued |
| Held input | Replay, heartbeat, or boundary without a newer head in the same participation | Remain held; no preparation retry or repeated error |
| Held input | Newer head or new explicit source attachment | One bounded preparation attempt at a delivery boundary; retain original ID |
| Held input | Recovery preparation fails | Retain queued disposition; record failed-head version; update explanation to the observed cause; hold again |
| Held input | Recovery preparation succeeds | Resume acceptance-order scheduling among eligible inputs; apply only on actual delivery; supersede held explanation |
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
| `E-COMP-07` | Required dispatch context unavailable, comparison delivery unsupported, or document exceeds transport limit | Hold accepted input pending; show the observed cause and applicable recovery guidance; await defined recovery trigger |
| `E-COMP-08` | Local send-recovery storage is unavailable, inconsistent, or unusable | Before first attempt, retain draft and do not send; for a saved request, do not invent a replacement ID; recover or explicitly discard unusable local data |

Errors MUST carry an operation and readable reason. They MUST NOT include record secrets or unbounded artifact excerpts. A computation fallback is informational, not an input refusal. No comparison action auto-retries a rejected input. Transport recovery follows Repeat-safe browser submission and distinguishes acceptance from delivery. `E-COMP-02` MUST NOT be returned for an already accepted identity and identical payload. Missing context at driver dispatch MUST be surfaced to the user; do not substitute the earlier version as the revision base.

`E-COMP-07` is a nonterminal delivery hold with a queued disposition, not a rejected or failed turn. Emit its failure explanation once per failed preparation, never per replay or heartbeat. A 401 retains the existing authorization code and reload recovery; it is not evidence that an earlier send was refused. `E-COMP-08` is local to the browser and MUST NOT be appended as an input or trigger a harness turn.

## Security Considerations

Artifact content is untrusted. The comparison renderer MUST output inert text or an explicit allowlist of static structure. It MUST NOT insert artifact HTML into the privileged application DOM. Scripts, event handlers, remote resources, and active controls are excluded from this renderer. Inspecting an original continues to use the existing opaque-origin sandbox and authenticated frame-message boundary.

Comparison reads and input writes retain the loopback server's session-token and origin checks. Artifact IDs remain validated identifiers, never paths. The server MUST verify version ownership, hashes, source metadata, and input bounds against the selected record. Client-supplied current-version claims are not authoritative.

The selected quote is evidence, not an instruction from the application. Prompt construction MUST delimit historical content from the person's request and latest artifact context. Content that resembles fences, HTML, or instructions MUST remain data throughout rendering and encoding. These boundaries reduce injection opportunities; they do not establish that a model will ignore malicious text.

The operation needs no new host permissions, external service, or shared storage. Its record writes remain ordinary inputs, delivery events, and accepted artifact revisions. The additional browser state is the unresolved request in same-origin, per-tab `sessionStorage`; it is not another conversation record. Do not put the session token, attach secret, complete comparison versions, or attachment blobs in that entry. Treat recovered content as untrusted, validate it before use, and render any recovery text inertly. Do not migrate this payload to `localStorage` or URLs. Clear it on a known result under the recovery rules. Closing the tab, clearing storage, or changing server origin is outside the same-tab recovery guarantee. A copied tab entry, if present, MUST retain its original request ID and therefore reconcile through the same repeat-safe endpoint. Full versions remain immutable and independently readable. Sensitive content MUST NOT be placed in URLs or new debug logs. Comparison computation and excerpts remain bounded by existing artifact and input limits plus the alignment budgets above.

## Alternatives Considered

- **Notes in a separate review rail:** prototype A kept all notes beside the diff. The user preferred writing directly next to the content. The normal conversation panel remains useful after submission.
- **The whole conversation inline:** this was the first version of prototype B. The user rejected placing the transcript under the change; only the note box belongs there.
- **One change at a time:** prototype C provided Previous and Next controls. The user chose inline notes in the full comparison instead.
- **Independent old-version view:** keeps the original rendering but makes the relationship between versions hard to inspect. It remains an explicit inspection path for unsupported content, not the comparison's primary layout.
- **Selective reverse patch or Restore this passage:** appears quick but assumes old content still has a safe destination. The chosen workflow asks the agent to revise current content and preserves stale-base validation.
- **Artifact-owned diff UI:** can preserve custom rendering, but would require each artifact to implement application history and annotation behavior. Ownership remains in Lucid.
- **Persist every draft across tabs or browser restarts:** would extend recovery beyond a submitted request. The chosen per-tab request storage covers the authentication reload without adding general draft synchronization.
- **Stop the whole queue behind missing comparison context:** preserves strict ordering but prevents a later ordinary request from producing a document that releases the hold. Skip only held inputs and keep acceptance order among eligible inputs; do not add priority controls.

## Implementation Plan

After RFC review and acceptance, refresh the existing draft implementation tickets against this revision. The dependency order is below; slices 1 and 2 are independent, and slice 3 depends on both. Each requires `bun run check` without waived gates.

1. **Repeat-safe browser sends.** Deliver stable optional browser request identities, replay of accepted receipts before fresh-request preconditions, payload conflicts, and the per-tab unresolved-request recovery mechanism. Verify accepted response loss followed by server restart, 401, reload, and exactly-once receipt recovery; also verify a request that never reached acceptance, storage failure before sending, cleanup failure, copied-tab retries, and concurrent duplicates. Existing source-protocol duplicate semantics remain unchanged. Update the browser input and reload-recovery contract in the same commit. This slice is independently verifiable and supplies the transport needed by comparison notes; it does not enable comparison controls yet.
2. **Readable real-version comparison.** Connect immutable saved versions to a bounded inert model and responsive comparison in the existing artifact view. Verify small word changes, repeated text, moves, malformed input, unsupported content, source addresses, and coarse fallback. Include both text-only and mixed text/style changes, with coverage disclosure and saved-source inspection. This slice is independent of repeat-safe sends. Keep ordinary reading/editing/annotations working, with comparison note actions disabled until slice 3. Update the current comparison contract, including following while comparison is open, when switching the UI. Roll back that switch if coverage or isolation fails; no stored-data migration is required.
3. **Historical notes that revise current content.** Depends on both earlier slices. Connect source provenance, guarded acceptance, the inline editor, replayable transcript markers, and comparison-aware dispatch across supported adapters as one complete path. Test newer versions before send, during queueing, and during generation; same-source ordinary queue conflicts versus unrelated queues; and an unsent v17-source draft retained above a refreshed v12/v18 comparison. Verify reconstruction of source IDs, verbatim preformatted snippets, and interactive emission teaching. For every adapter, prove queued hold, later eligible input delivery, bounded retry triggers, successful recovery, reattachment, and correct input/turn association. Include legacy batches, retries, attachments, and driver changes. Verify pointer/keyboard interaction and 390, 768, and 1440 layouts in both themes. Update each changed current artifact, source, driver, and design contract in this implementation commit. Keep prototype assets on their throwaway branch; retire the active RFC only after delivery under the documentation lifecycle.

Slice 3 MUST verify each held-input explanation with its corresponding preparation failure, including readable current content on an unsupported attachment and a document exceeding the transport limit. Verify that recovery guidance matches the cause, that a changed failure updates the explanation without losing the earlier error, and that no presentation change starts a turn, truncates current content, or adds a recovery trigger.

Deterministic fake-harness tests are the gate for delivery and revision behavior. A live-harness confirmation can follow on demand; it cannot replace those tests. The prototype's successful layout checks establish the chosen interaction only, not the production algorithm, protocol, or persistence.

## Open Questions

No product-scope question remains open for this release. The user approved detailed text comparison with the explicit non-text fallback above on 2026-09-07.

1. **Extraction and matching implementation:** retain and adapt existing internals, or replace them behind the same boundary? The implementer decides against the repeated-text, arbitrary-rewrite, malformed-document, source-address, and bounded-computation fixtures. Reuse where those checks pass and use conservative unmatched output where correspondence is ambiguous. This does not require another product decision or a new dependency. The implementation review verifies the evidence.

Status is Accepted for revision 4 after the user directed continuation of the three-ticket implementation on 2026-09-07. This revision answers the completed revision-3 review. The interaction and release-scope decisions are settled. Delivery progress is tracked in the local tickets; acceptance is not a claim that every slice is implemented.

## Response to the revision-3 review

Revision 4 answers [the revision-3 review](14_annotated-content-comparison.review-revision-3.md). That report retained one minor finding after independent review and source verification. The response below records the drafting changes; it is not a new independent review.

| Finding | Disposition in revision 4 |
|---|---|
| F1 (independent R2) | Replaced the fixed waiting label with explanations for unavailable content, unsupported comparison delivery, and transport size limits. Each names an applicable existing recovery path. Updated the state machine, error table, and slice-3 verification; preserved queued disposition and bounded attempts. |
| Independent R1, not retained by the review | No hold quota or abandonment mechanism added. Queued notes do not consume the existing delivered-but-unfinished input gauge; the review verified that behavior in source and an executed test. |
| Independent R3, not retained by the review | Kept same-ID reconciliation for uncertain accepted sends. Discarding local recovery state does not repair an unavailable server or record, and a replacement ID can duplicate an accepted note. |
| Independent R4, not retained by the review | Kept normalized content equality separate from full-byte version identity. A line-ending-only change does not require a byte-diff feature or a technical normalization notice. |

## Response to the revision-1 review

Revision 2 answers [the revision-1 review](14_annotated-content-comparison.review-revision-1.md), based on the completed `opus-5@claude` review and Codex's source verification. The choices below are drafting decisions made in response to the user's request to revise; they are not an independent approval or implementation result.

| Finding | Disposition in revision 2 |
|---|---|
| F1 | Added per-tab unresolved-request storage before network submission, same-ID reconciliation after 401 and reload, known-result cleanup, local storage failures, and combined restart/reload verification. Unsent drafts retain their existing lifetime. |
| F2 | Bound a hold to queued disposition, skipped held inputs while preserving eligible-input acceptance order, defined one-attempt recovery triggers and turn association, and specified transcript and reattachment checks. |
| F3 | Retained an out-of-pair source excerpt and its editor above comparison rows after explicit refresh, with the original version label, preserved selection, focus, and unchanged Send/Cancel semantics. |
| F4 | Defined conflict by the page-local queue's exact conversation/artifact/source-version key, checked on fresh Send; left unrelated queues intact and exempted unresolved-request reconciliation. |
| F5 | Required a coverage notice whenever supported text differs, including text-only and mixed-source changes, with inspection links and a mixed-change fixture. |

The review's four findings not retained as defects remain non-blocking. Their implementation cautions are now explicit: reconstruct source element IDs before filtering, teach artifact emission on supported interactive comparison delivery, preserve comparison snippet whitespace while retaining the cap, and update the comparison-open following contract with the UI switch. The user subsequently approved the text-focused non-text boundary recorded in revision 3.

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

The non-text product boundary was pending when revision 1 answered this review; the user's later approval is recorded in revision 3. No review finding is treated as that approval or as proof that production code already meets these requirements.

## References

### Normative

- [Product vocabulary](../../CONTEXT.md) - artifacts, notes, spots, inputs, and transcript ownership.
- [Artifact contracts](../artifacts.md) - immutable versions, saves, restoration, anchoring, input encoding, and browser isolation.
- [Document edits preserve evidence](../adr/0007-document-edits-preserve-evidence.md) - immutable history and unresolved source evidence.
- [Source protocol](../skill-chat-substrate.md) - input identity, disposition, and delivery behavior.
- [Drivers](../drivers.md) - harness preferences and current artifact context.

### Informative

- [Browser session storage](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage) - per-origin and per-tab lifetime, reload survival, and access failures; checked 2026-09-07.
- Prototype branch `prototype/hub-workflow`, commit `059ced3` - inline editor beside source content, separate conversation panel, simulated delivery. The user approved this interaction on 2026-09-07.
- [Annotation encoding](../../src/protocol/annotations.ts) - existing batch-level version and per-spot evidence; these need distinct source provenance for comparison notes.
- [Block comparison](../../src/server/client/version-diff.ts) - existing extraction and correspondence candidates; reuse requires the stricter provenance and ambiguity checks in this RFC.
- [Source-line comparison](../../src/server/client/line-diff.ts) - existing bounded alignment and coarse fallback, retained for verification.

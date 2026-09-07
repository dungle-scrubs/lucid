---
number: 14
title: "Annotated content comparison"
type: feature
status: Draft
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
- **Reviewed version**: the immutable version shown as current when a note is written. This remains historical evidence if another version arrives.
- **Current version**: the latest accepted version at the operation being described. It is not an alias for the earlier or reviewed version.
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

If the person has unsaved edits or pending notes, entering or changing comparison MUST preserve that work and use the existing navigation guard. It MUST NOT silently save, discard, or retarget it. Close comparison returns to the reviewed document and retains the prior reading position where possible. If a newer version has arrived, normal following rules apply only after pending work is resolved.

### Readable changes

The comparison SHOULD preserve the reading hierarchy of headings, paragraphs, and lists. It MUST show additions and removals with explicit signs or labels as well as color. Earlier content appears before current content in reading order. Changed words within paired text passages SHOULD receive stronger emphasis than the surrounding passage, so a small edit does not appear as an unexplained replacement of an entire paragraph.

The same comparison model MUST drive both layouts:

- With sufficient width in the artifact area, earlier and current passages appear in aligned columns.
- With less width, each earlier passage is followed by its current counterpart in one column.

The conversation panel's width MUST be excluded when deciding whether two comparison columns fit. The prototype's 820 CSS-pixel artifact-area threshold is the initial reference, subject to visual verification with the production typography. Switching layout MUST preserve draft text, source selection, and submitted note references. Unchanged context appears once in the narrow layout. An absent counterpart MUST be labeled absent, not rendered as an empty added or removed passage.

The comparison MUST retain enough surrounding text to interpret a change. It MUST NOT label two versions identical merely because the supported text extraction is identical while unsupported content or source bytes differ.

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

Send note MUST submit one annotation as one ordinary input through the existing input path, using the selected harness, model, and effort under the current driver rules. It MUST NOT require a Resume button or a second send in the chat composer. Existing multi-note annotation queues remain supported outside this one-note interaction.

After durable input acceptance, the inline box closes. The transcript MUST show the user's note, source quote, and source version in the normal conversation panel. The source passage retains a small marker linking to that transcript entry. The marker MUST resolve by durable input identity and note index, not array position in the current render or a wall-clock-generated client note ID. Several notes on one source can share a count marker; each remains separately readable in the transcript.

Accepted input is not proof of delivery or a completed revision. The transcript MUST use existing queued, working, rejected, and failed behavior. A send failure before acceptance MUST keep the draft. An ambiguous network result MUST be reconciled with the same idempotent input ID; retry MUST NOT create another note. A reload MUST reconstruct accepted notes and their source references from the record. Draft persistence across a full browser restart is not added by this RFC; existing navigation guards still apply.

At narrow sizes, the conversation can use the application's existing responsive placement. It MUST remain a distinct transcript region. A marker MUST take keyboard and pointer users to the corresponding entry, including when that region is off-screen. It MUST NOT insert the entire transcript between diff passages.

### Version provenance and annotation encoding

The existing `lucid-annotations` batch remains the input encoding. No new conversation event kind is required. For comparison notes, batch `version` MUST identify the reviewed revision target, not the earlier version quoted by a spot.

The draft proposes additive fields with the following contract:

| Field | Placement | Meaning and validation |
|---|---|---|
| `comparison` | Batch, optional for existing notes | Object identifying the comparison that produced the note |
| `earlierVersion` | In `comparison` | Positive integer identifying a version of the same artifact, less than batch `version` |
| `reviewedHash` | In `comparison` | The artifact hash of batch `version`, using the existing version-hash representation |
| `sourceVersion` | Spot, required for comparison spots | Positive integer at or before batch `version`; identifies the selected source version |
| `sourceHash` | Spot, required for comparison spots | Hash of the immutable version named by `sourceVersion` |

Existing spot ID, snippet, author, selectors, and note attachments retain their meanings. A comparison spot MUST address its own source version, including when selected in an application-rendered diff. Diff wrapper IDs and indexes MUST NOT be passed off as artifact element IDs. Source selectors MUST be built against source content, excluding inserted highlighting and controls. A missing or ambiguous source address is a refusal to send that selection, not permission to attach it somewhere else.

The current snippet limit and input-size limits still apply. A truncated selection MUST be visibly marked before sending; the payload MUST NOT imply that the retained snippet contains the entire selection. Malformed comparison fields MUST be reported explicitly rather than silently treated as a legacy note. Legacy batches without comparison metadata remain valid.

The serialized user input MUST include a concise human-readable statement that the source is earlier content and the request targets the reviewed document. This lets older transcript readers and external consumers retain the meaning even if they ignore new fields. It MUST preserve the person's note text as authored, separately from application-generated context.

The annotation preamble MUST distinguish source versions from the revision target. The existing instruction to revise the batch's version remains valid for legacy notes; comparison-aware delivery additionally accounts for a newer current version as specified below. No old log entry or version is rewritten.

### Current content and restoration

Before accepting a comparison input, the server MUST atomically verify that the artifact's latest version and hash still equal the reviewed version and hash. Reuse the record's append serialization. A mismatch returns a stale-comparison result without appending an input. The client retains the draft, shows that a newer version arrived, and offers to review the updated comparison.

Reviewing the newer version MUST preserve the original source quote and its version. The user then confirms Send note against the newly reviewed target. If that source came from the old current side, it remains addressed to the version actually selected; the refreshed comparison metadata MUST allow that historical source. On initial capture, `sourceVersion` comes from the selected side. After explicit refresh it continues to identify that preserved source version at or before the newly reviewed target. The UI MUST label that original version and MUST NOT pretend its words came from the refreshed side.

The source marker remains visible when its exact source version is one of the displayed sides. Otherwise the transcript retains the quote and an action to inspect that source. A match into current content MAY be presented as navigation assistance, but MUST NOT replace the historical source address.

A newer version can also arrive after input acceptance or while the input is queued. At turn dispatch the driver MUST provide the latest full artifact through the existing artifact-context mechanism, together with the original comparison note. It MUST explicitly identify the dispatch version as the revision target and the reviewed version as historical context. User-authored saves and unrelated newer content MUST be included. Do not copy the complete document into every note or into a new durable comparison store.

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
| Ready comparison | Select source text or + Note | Inline draft with immutable source evidence |
| Inline draft | Select another passage with nonempty text | Keep draft; require Send or Cancel |
| Inline draft | New version arrives | Keep draft and displayed pair; mark comparison stale |
| Stale comparison | Review newer version | Refresh target and matching; retain original quote; await Send |
| Inline draft | Send note | Disable duplicate submission; submit stable input ID and expected reviewed base |
| Sending | Stale base or refusal before acceptance | Retain draft and show actionable reason |
| Sending | Transport outcome unknown | Reconcile same input ID; no second append |
| Sending | Input durably accepted | Close editor; show transcript entry and source marker |
| Accepted input | Queued or working | Existing input lifecycle; no simulated success |
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

Errors MUST carry an operation and readable reason. They MUST NOT include record secrets or unbounded artifact excerpts. A computation fallback is informational, not an input refusal. No comparison action auto-retries a rejected input. Transport recovery uses the existing idempotent send behavior and distinguishes acceptance from delivery. Missing context at driver dispatch MUST be surfaced to the user; do not substitute the earlier version as the revision base.

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

1. **Readable real-version comparison.** Connect immutable stored versions to a bounded inert content model and responsive diff in the existing artifact view. Verify additions, removals, small word changes, repeated text, moves, malformed input, unsupported content, and coarse fallback. Keep existing reading, edit, annotation, and version navigation functional. Roll back the UI switch if source coverage or isolation fails; do not migrate stored data.
2. **Historical notes in the conversation.** Extend provenance validation, encoding, transcript projection, and source markers. Connect the inline editor to one real idempotent input. Verify old/current/removed selections, draft protection, retry after unknown outcome, queued input, refusal, and replay after reload. Preserve legacy batch rendering and note attachments. Do not expose comparison sends until these checks pass.
3. **Revision against current content.** Add the atomic send precondition and comparison-aware dispatch context. Deterministically test v12-to-v17 requests with v18 arriving before send, during queueing, and during generation. Verify that the source quote remains v12 and stale patches cannot be silently applied. Confirm accepted revisions append complete versions.
4. **Production interaction and documentation.** Verify 390, 768, and 1440 CSS-pixel layouts, both color themes, pointer and keyboard selection, source-marker navigation, and preserved conversation placement. Update `docs/artifacts.md`, the governing design documents, and any lasting ADR rationale. Keep prototype assets on their throwaway branch; remove the active RFC after delivery under the repository's documentation lifecycle.

Deterministic fake-harness tests are the gate for delivery and revision behavior. A live-harness confirmation can follow on demand; it cannot replace those tests. The prototype's successful layout checks establish the chosen interaction only, not the production algorithm, protocol, or persistence.

## Open Questions

1. **First-release coverage:** detailed text, heading, and list diffs with whole-section or unsupported treatment for tables, images, and interactive content, or detailed non-text comparison now? The recommendation is the text-focused scope so the feature makes precise claims about what it compares. The user decides this scope boundary; confirmation is pending. Acceptance requires a defined fallback that never hides unexamined changes.
2. **Extraction and matching acceptance:** retain and adapt existing block extraction and matching, or replace their internals behind the same boundary? This is an engineering review decision. The criterion is passing the repeated-text, arbitrary-rewrite, malformed-document, source-address, and bounded-computation fixtures without claiming false correspondence. The draft recommends reuse where those checks pass and conservative unmatched output where they do not. It does not require a new dependency.

The interaction decision is settled. These questions do not reopen inline entry or move the transcript into the diff. Status remains Draft until scope and technical review are resolved.

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

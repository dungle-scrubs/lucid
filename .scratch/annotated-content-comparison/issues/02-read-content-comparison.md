# Read saved content changes in the artifact view

Status: resolved
Blocked by: none

## What to build

A person compares an earlier saved version with the latest saved version inside the existing artifact view. Earlier and current content are labeled, small edits are readable, and one comparison model supports aligned columns or inline reading according to available artifact width.

This covers RFC 14 revision 4's passive comparison and can ship independently of send recovery. Comparison note actions remain disabled until ticket 03 connects the complete note-to-revision path.

## Acceptance criteria

- [x] Compare with uses real immutable versions in the artifact reading area. Shared header, logo navigation, conversation, and version navigation remain available. It opens no automatic second tab, creates no input or version, and is unavailable for a single-version artifact.
- [x] Entry requires explicit resolution of unsaved edits or pending ordinary notes in the view being left. Cancelling preserves all work. Closing returns to the reviewed document and preserves reading position where possible.
- [x] New-version arrival keeps the displayed pair fixed even without a draft, with a stale notice and Review latest. Following resumes only after comparison closes and pending work is resolved.
- [x] Extract headings, paragraphs, list items, quotations, captions, and preformatted text once, preserving reading hierarchy. Ordinary whitespace reflow is ignored for matching; preformatted whitespace remains significant.
- [x] Version labels, additions, removals, and absent counterparts are explicit beyond color. Changed words are emphasized within paired passages; surrounding context stays readable and unchanged content appears once inline.
- [x] Deterministic matching handles repeated text, moves, arbitrary rewrites, and ambiguity. Similarity may aid presentation but cannot establish a source address. Uncertain correspondence remains separate removals and additions.
- [x] Passage addresses belong to immutable source versions. Reconstructed reader element IDs agree with saved-source inspection before filtering and exclude comparison wrappers, highlighting, and authored HTML IDs as substitutes.
- [x] Extraction and rendering cannot execute artifact scripts, handlers, controls, or remote fetches, or insert artifact HTML into the privileged application document. Original inspection retains the existing sandbox boundary.
- [x] Block and word alignment independently check bounded work before allocation, starting from the RFC's existing alignment budget. Coarse fallback is labeled and preserves both source texts and valid selection for later note entry.
- [x] Equal normalized retained source yields the no-saved-content-changes result. Equal supported text with other source differences yields the no-text-changes disclosure. Every text difference includes the coverage notice, including text-only and mixed text/style, image, or control changes.
- [x] Tables, images, controls, and script-dependent sections receive supported whole-section comparison or an explicit not-compared outcome. Both saved versions remain inspectable without losing comparison state. Detailed non-text diffs and remote-resource byte comparison stay outside scope.
- [x] Unreadable versions name the failed side and preserve prior reading state. Unsafe or unextractable content produces an unsupported result, never an empty side or false equality.
- [x] Wide and inline views use the same model and available artifact width after conversation placement. Verify pointer and keyboard navigation, labels, focus, and inspection at 390, 768, and 1440 pixels in both themes.
- [x] Existing reading, editing, ordinary annotations, read-only version access, and whole-version Restore remain usable. No prototype samples, simulated transcript, or extra source-diff mode enter production.
- [x] Deterministic content, address, coverage, isolation, navigation, and bounded-computation checks pass with all repository checks. Update comparison and following contracts with the UI switch; reverting it requires no stored-data migration if coverage or isolation fails.

## Parent

[RFC 14, revision 4: Annotated content comparison](../spec.md)

## Delivery evidence

Implemented in the working tree. Inert extraction, exact source addressing, ambiguity, word changes, independent alignment bounds, unsupported content, and equality disclosures are covered by `test/server/content-comparison.test.ts`. `test/server/comparison-view.test.tsx` covers source selection, one editor, stale arrival, retained-source placement, focus and selection, inspection, and unreadable sides. Browser checks at 390, 768, and 1440px confirmed inline/two-column switching with no horizontal overflow in both comparison themes. The surrounding app remains light-only. Existing document, restore, annotation, and layout tests remain green.

Current contracts: docs/artifacts.md, docs/drivers.md, docs/skill-chat-substrate.md, docs/design.md, and docs/design-brief.md. Implementation has not been committed or pushed. Retire RFC 14 and its reviews with the implementation landing so the revised proposal remains recoverable from Git.

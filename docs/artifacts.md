# Artifacts, annotations, and attachments

A conversation holds one artifact. Its ID is chosen on the first accepted
emission and stays stable; its title may change. Another document belongs
in another conversation. An artifact list, a second document pane, and
retiring an artifact are outside the product's current scope.

## Emission and immutable versions

The headless session receives the artifact preamble when opened. A headless
turn receives it every turn. Comparison delivery through interactive hooks
includes emission teaching; ordinary interactive inputs retain their existing
hook behavior.

An emission is a fenced block tagged `lucid-artifact`. Its first line is a
JSON header with `id`, `replaces`, and `contentType`; the rest is the document.
`form` is optional and defaults to `whole`. lucid assigns the version,
author, and hash. A revision must name the current version in `replaces`.
Malformed blocks are refused with a reason without dropping the message.
Multiple blocks are evaluated in message order.

For a new record, the first whole emission creates version 1. For compatibility,
an unknown ID with a non-null `replaces` also starts at version 1 when no
artifact is held. A second ID is refused as `E-ART-09`, naming the held ID.
Identity admission precedes size and patch work, after header validation.

Older records containing multiple artifacts remain readable. Revisions to
an ID already held there are accepted; another ID is refused. The browser
shows one artifact, without restoring the removed list or second pane.
IDs are index keys, never filesystem path components. Renaming changes only
the title, not the ID, versions, or annotation addresses. Titles are bounded
at 200 UTF-16 code units, contain no control characters, and render as text.
Malformed metadata does not create artifacts or make the record unreadable.

The hub uses the same artifact title (or artifact ID until renamed) as the
document header. Its rename control updates that document name through the
same metadata endpoint. A conversation without an artifact uses its saved
or generated conversation title and retains conversation renaming. Listing
does not copy artifact names into conversation metadata or generate titles.

Every accepted version is a full immutable document in the log. Human saves
and agent emissions share append ordering. The artifact size policy is
`ARTIFACT_BYTES_MAX = 1_000_000`; it is independent of the protocol's
`TEXT_MAX` even though their current values match. The implementation bounds
artifact strings by string length; attachment storage uses byte lengths.
Do not silently change this wire compatibility by conflating the measures.

## Patch revisions

A patch uses `form: "patch"` and a JSON body containing an `edits` array.
Each edit has only `find` and `replace`. `find` is nonempty, literal text that
must occur exactly once in the version named by `replaces`. `replace` is a
string and may be empty. Unknown edit fields are refused.

Resolve all anchors against the original base before applying any edits.
Overlapping matches are refused; an edit cannot target text another edit
introduces. The result is all-or-nothing and is stored as a full document,
never as a patch. The whole form remains valid for every revision.

A patch cannot create an artifact or revise a stale base. A stale-base refusal
makes the current bytes available to the agent for recovery, including when
the agent authored them. Multiple blocks in one message can revise the
result of an earlier block. An unreadable base is `E-PATCH-09`, never an
empty document to patch.

Bounds are 50 edits, 4,096 characters per find, 65,536 per replacement, and
at most the artifact bound across replacements and in the final result.
Refusal excerpts are bounded so an invalid patch cannot inflate the next
prompt without limit. See [patch policy and parser](../src/protocol/patch.ts)
and [patch tests](../test/protocol/patch.test.ts).

## Reading, saving, and restoring

`/c/:conversationId/:artifactId/:version` addresses a version. Omitting the
version follows the newest version; omitting the artifact selects the
record's default artifact. Artifact IDs are percent-encoded path segments
and validated as artifact fields, not narrowed to conversation-ID syntax.

An older version is read-only. Viewing it does not move pending notes to a
new target or discard queued work. A new version cannot replace a document
with unsaved edits or pending annotations. Following can resume once that
work is resolved.

A save records the document and control values, the human author, and the
version it was based on. A save from version 4 arriving after version 5 is
accepted as a new version, with `basedOn` and `supersededSince` explaining
the order. lucid does not merge the documents. Saving is not an input and
starts no turn; the next input supplies the saved state to the agent.

Restore requires confirmation and appends a new human version containing
the chosen version's bytes and controls. It records its ancestry and never
rewrites or removes history. Comparison reads two stored versions inside the
artifact area. Opening it creates no input or version.

## Content comparison

Compare with captures an earlier version and the latest reviewed version.
The pair stays fixed until explicit Review latest or Close. New versions
show a stale notice. Entry and navigation preserve unsaved edits, ordinary
notes, comparison drafts, and unresolved sends. Closing returns to the
reviewed document; following resumes once pending work is resolved.

The application extracts saved HTML as inert data with parse5. Headings,
paragraphs, list items, quotations, captions, and preformatted text appear
once in source reading order. Prose matching ignores whitespace reflow;
preformatted text and captured quotes preserve whitespace. Element IDs come
from the reader's body order before filtering, scoped to version and hash.
Presentation similarity never changes a note's source address. Ambiguous
matches remain separate removals and additions.

Block and word alignment each check the four-million-cell limit before
allocating. Coarse comparison preserves both texts and labels the limit.
Tables, images, controls, scripts, and other unsupported content receive
explicit coverage notices. Equal supported text alone does not establish
equal saved content. Equal retained source, after instrumentation removal
and line-ending normalization, yields no saved-content changes. Unextractable
content produces an unsupported result. External resource bytes are outside
comparison. Either original stays inspectable in the existing sandbox.

Selecting a passage or words opens one note box below that source. Send
creates one input and one transcript note; source markers link to that note.
The conversation stays separate. A source that leaves the pair after Review
latest keeps its original excerpt and editor above the passage rows. Explicit
review restores editor focus and selection; automatic arrival does not.

Comparison captures saved source text. Ordinary annotations still capture
the current human-edited text. Each fresh comparison send checks this page's
ordinary queue for the same conversation, artifact, and source version.
Resolve that queue at its original version; neither queue is flushed or
retargeted. Other queues remain unchanged. Reconciliation of an unresolved
request retains its original identity and bypasses this fresh-send check.

### Historical source and current revision

The existing annotation batch carries one note. Batch `version` is the
immutable source version. Its additive `comparison` object carries
`earlierVersion`, `reviewedVersion`, and `reviewedHash`. Every spot carries
`sourceVersion` and `sourceHash` plus its original ID, selectors, quote,
snippet, and author. All spots belong to the same saved source. Attachments
retain their ordinary meanings. A source retained after explicit review may
sit outside the displayed pair.

The shared append transaction validates source bytes, hashes, exact addresses,
and metadata. Invalid known fields return `E-COMP-03`. A fresh input whose
reviewed version/hash is no longer current returns `E-COMP-02` without an
append. Accepted identity reconciliation precedes that check. Source-frame
admission uses the same guard. Stored unusable extensions retain valid legacy
text and quotes while disabling comparison navigation; unknown fields remain
tolerated.

After acceptance, historical references stay in the transcript across reload.
They do not become ordinary orphans or acquire guessed current anchors. A
marker resolves only at its exact saved source; absent sources retain an
inspection link. At dispatch the [driver](drivers.md#comparison-delivery)
supplies the complete current document and names it as the sole revision
base. A restoration request produces a new immutable revision through the
ordinary emission guard. It does not reverse a patch or roll back unrelated
current content.

## Annotations and anchoring

Links with an `href` navigate in both document modes. They show a pointer cursor
and no annotation hover outline, including over child labels and icons. A direct
click does not select the link for a note. Text selection across a link remains
available; ending that drag does not also follow the link. Other controls retain
their existing mode behavior. This does not change the artifact's sandbox or
grant navigation capabilities that the browser would otherwise refuse.

A note carries one or more spots, the text the person saw, and authorship.
A spot may be a whole element or only the words selected. Capture the current
human-edited text, not a stale pre-edit snippet. One batch carries notes in a
`lucid-annotations` fence in one input. It identifies the artifact and version
being discussed. The agent decides where its revision belongs.

The local note queue is bounded at 20 notes. Refusing another note must keep
the existing queue and the person's draft. Browser navigation must not silently
discard pending edits or notes. Notes render at their place in the conversation;
annotations on an old version remain associated with that version.

Anchoring tries quote, position, then path. Quote matching uses
`dom-anchor-text-quote`. A spot that cannot be resolved remains an orphan
with its note, original version, and snippet intact. Do not attach it to an
unrelated replacement merely because a path still exists.

## Attachments as context

Attachments are input context, not artifacts. Store their bytes inside the
record at `files/<lowercase sha256>` and append metadata, not bytes, to the
log. Deduplicate by content hash. The durable blob travels with its record.
A file can be at most 25,000,000 bytes. There is no per-record total quota or
automatic blob garbage collection contract.

Text detection uses the entire byte stream: valid UTF-8, no forbidden control
bytes or DEL, with tab, newline, and carriage return allowed. Do not trust the
claimed media type or filename extension to decide whether to inline content.
Inline only when the whole resulting input fits `TEXT_MAX`; otherwise name
a temporary context copy outside the record. Binary files use that copy too.
Copies are private to the user, never paths into any record, and are cleaned
up by the conversation lifecycle. A missing blob is described in the input;
it does not silently disappear or prevent the rest of the turn from running.

An annotation's files belong on the note they support, inside the same
annotation fence. Attachment metadata includes hash, byte count, content type,
and name; an offered path is present only when named rather than inlined.
Stored annotation decoders ignore unknown fields so older readers can still
read newer batches. This differs from executable patch edits, whose unknown
fields are refused.

## Browser boundary

The server binds to `127.0.0.1:17454`. API requests require its in-memory
session token in `x-lucid-token`. Reject unexpected origins; do not use a
cookie or query token. The attach secret never reaches the browser. A server
restart invalidates old pages' tokens; the page reports refusal and requires
a reload instead of retrying indefinitely.

### Repeat-safe browser input

The browser input endpoint accepts an optional client-generated `id` with
`text`, and fixes delivery mode to `queue`. A request without an ID still
receives a server-generated identity. Under the append lock, an identical
accepted identity and payload returns the original receipt before fresh
admission checks; it does not append or deliver another input. An accepted
identity with different text returns `E-COMP-06`. Receipt lookup uses the
accepted transcript, including applied inputs, rather than raw attempted
entries. Source-protocol `input-id-reused` semantics remain unchanged.
One-note annotation receipts include `noteIndex: 0` alongside `inputId`.

Comparison note entry uses the recovery controller below. Ordinary send
controls retain their existing submission behavior.

Before sending a comparison note, the controller writes and reads back its
versioned request identity and exact body in per-tab session storage. It
keeps one unresolved request per conversation. Storage failure reports local
`E-COMP-08` and makes no first network attempt. Uncertain results and 401
retain the request unchanged; reload obtains the new page token and shows
explicit Retry. Mounting or reloading never sends. Retry applies only to
the open conversation and keeps the same identity and body.

Known acceptance clears the entry. Explicit admission refusal returns the
original note and source payload for editing before another send. Cleanup
failure keeps the known outcome visible and blocks a new comparison send.
Malformed entries remain inert, readable where possible, and explicitly
discardable; discarding local recovery data does not cancel accepted input
or submit a replacement. Tokens, secrets, full document snapshots, and
attachment blob stores are excluded from this storage. Tab closure, cleared
storage, and changed origin are outside this recovery guarantee.

### Artifact isolation

Agent documents run in a sandboxed iframe without `allow-same-origin`.
The parent does not read its DOM. Messages must come from that exact frame
window and pass shape, render-ID, and control validation. The frame has an
opaque origin, so an origin check alone does not authenticate its messages.
Strip lucid's instrumentation from saved documents and from agent context.
Artifact serving reads stored bytes per request rather than caching documents.

## Document width

An HTML artifact can declare `<meta name="lucid-width" content="72rem">` in
its head. The first matching element supplies the displayed version's preferred
maximum frame width. Accepted values are `full`, or a positive finite decimal
with lowercase `px`, `rem`, or `%`. Limits are 10000px, 625rem, and 100%.
Surrounding whitespace is ignored. Missing or invalid metadata uses full width.
Percentages refer to the available document pane after gutters; rem refers to
the viewer root font size. Parsing creates no browser nodes or resource requests.

The Document width header control overrides the author with a reader percentage.
Use artifact width removes that override. The effective frame width is clamped
between the smaller of 320px and available space, and all available space. The
slider reflects actual rendered width with a dynamic minimum and a pixel readout;
the requested preference is shown separately. Pane resizing does not overwrite it.
The browser remembers overrides per conversationId and artifactId across versions.
Unavailable or full local storage leaves the current view usable in memory.

Width adjustments remain available during unsaved edits and read-only viewing.
They create no version or agent turn and do not remount the artifact. Text-range
marks and note anchors follow reflow. Comparison columns ignore these width
preferences. Authored internal layout constraints remain the artifact's own.

## Verification

[Artifact emission](../test/protocol/artifacts-emission.test.ts),
[artifact form](../test/protocol/artifact-form.test.ts), and
[store artifacts](../test/store/artifacts.test.ts) cover admission and versioning.
[Version state](../test/server/version-state.test.ts),
[restore](../test/server/restore.test.ts),
[route](../test/server/route.test.ts), and
[line diff](../test/server/line-diff.test.ts) cover history.
[Anchoring](../test/server/anchor.test.ts),
[frame source](../test/server/frame-source.test.ts),
[attachments](../test/server/attachments.test.ts), and
[annotation compatibility](../test/protocol/annotation-files.test.ts) cover
the browser and input boundaries.
[Input recovery](../test/server/input-recovery.test.ts) covers real HTTP
receipts, browser session storage, restart and reload reconciliation, and
the recovery controls.
[Content comparison](../test/server/content-comparison.test.ts),
[comparison entry](../test/server/comparison-view.test.tsx),
[transcript replay](../test/server/transcript-runtime.test.tsx), and
[comparison delivery](../test/modes/comparison-delivery.test.ts) cover source
identity, retained drafts, admission, bounded holds, and current revisions.
[Artifact width](../test/server/artifact-width.test.ts) covers metadata parsing,
validation, precedence, layout bounds, and preference isolation and failure.
Rendered checks cover reader controls, frame continuity, range marks and note
anchors after resize, and contrast during selection and edit focus in both themes.

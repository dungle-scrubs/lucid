# Artifacts, annotations, and attachments

A conversation holds one artifact. Its ID is chosen on the first accepted
emission and stays stable; its title may change. Another document belongs
in another conversation. An artifact list, a second document pane, and
retiring an artifact are outside the product's current scope.

## Emission and immutable versions

The headless session receives the artifact preamble when opened. A headless
turn receives it every turn. Interactive sessions have no emission-preamble
injection surface and are not expected to emit through this protocol.

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
at 128 characters, contain no control characters, and render as text.
Malformed metadata does not create artifacts or make the record unreadable.

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
rewrites or removes history. Comparison reads two stored versions and shows
a line-oriented diff of their source, not a transformed DOM. It is read-only,
creates no input or version, and reports unreadable sides explicitly.

## Annotations and anchoring

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

Agent documents run in a sandboxed iframe without `allow-same-origin`.
The parent does not read its DOM. Messages must come from that exact frame
window and pass shape, render-ID, and control validation. The frame has an
opaque origin, so an origin check alone does not authenticate its messages.
Strip lucid's instrumentation from saved documents and from agent context.
Artifact serving reads stored bytes per request rather than caching documents.

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

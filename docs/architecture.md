# Record, protocol, and lifecycle

lucid owns a durable conversation. A driver owns its participation in that
conversation. The browser server and other writers may append human input
without becoming drivers. See the [source protocol](skill-chat-substrate.md)
for frame shapes and refusal behavior.

## Record and ownership

A record contains `log.ndjson`, `meta.json`, the attach `secret`, an optional
`driver.json`, attachment blobs in `files/`, and delivery state. Copy durable
state and blobs together when moving a record; do not copy runtime locks.
The log records what happened. Driver preference is replaceable state beside
it, and blobs are addressed by content hash rather than embedded in log lines.

Two kernel locks have separate jobs:

- The append lock serializes one read/reduce/append transaction.
- The presence lock lasts for a source's participation and elects the one
  executor allowed to dispatch effects. Process death releases it.

Epoch fencing and time-bounded leases are protocol checks in addition to
these locks. A stale source cannot write after takeover. A headless attach
cannot steal from a human process whose presence is still corroborated.
The record secret is created with mode 0600; local filesystem access is the
attach authorization boundary. An identity stamp is not authentication.

## Conversation discovery

The terminal and browser use the same record-root resolver: an explicit root,
then LUCID_ROOT, then ~/.lucid2/records. User-config defaults are planned in
RFC 15's next creation slice. A custom root replaces the default.

The saved metadata identity selects a record, including after its directory
is renamed. Unknown and duplicate identities are refused by existing-record
operations; send, watch, and browser writes cannot create a replacement.
Explicit terminal creation publishes metadata and its known folder association
with the record's atomic rename. Dot-prefixed staging directories stay hidden.

The hub rebuilds discovery from records at startup, on filesystem hints,
every five seconds while the server runs, and when the browser loads,
returns to focus, or refreshes. Pages use opaque identity cursors. Individual
record errors remain visible beside valid records; an unreadable root is an
error. Listing never writes metadata or starts a harness.

Projects are resolved absolute paths: the nearest repository root, or the
starting folder when there is no repository. Nested repositories and worktrees
have their own roots. Metadata retains the exact working directory separately.
Legacy records appear under No project. A missing working folder does not
change the saved project. Display titles use saved titles of seven words or
fewer, or a bounded fallback from the first prompt. An annotation-first
record uses its typed prompt or its first note. Generated titles and
folder recovery belong to later RFC 15 slices.

Every writer checks metadata identity under the append lock before mutation.
Driver-preference replacement and attachment-file creation use that same lock.

## One fold and one append transaction

The log walker owns replay, effect collection, artifact headers, and the
last valid byte offset. Unknown source entries are carried for forward
compatibility. Recognized malformed entries are not silently reinterpreted.
A delivery cursor beyond the valid prefix is corruption, not empty work.

Every append path holds the append lock while it reads and repairs the tail,
installs folded state, reduces the new operation, writes all bytes, and
fsyncs. A failed write rolls back to the prior durable offset under that same
lock, using descriptor truncation with a path fallback. In-memory state must
not claim an append that failed. Time comes from the injected clock.

Artifact bytes stay outside reducer state. One accepted header per artifact
version indexes its offset, author, time, hash, and ancestry. Later duplicates
do not replace the first accepted version; the highest version is the head.
Oversized versions do not enter the index. The walker derives `afterSeq`
from the preceding protocol sequence for transcript placement; it does not
add a new field to persisted artifact entries.

Indexed artifact reads are lock-free. A read that needs recovery falls back
to the locked path and propagates its errors. A valid indexed GET can succeed
while another process holds the append lock. HTTP boundaries map lock timeout
to 503 with `Retry-After: 1`, and damaged folds or corruption to 409. Missing
content is 404, not a substitute for a damaged-record response.

## Driven conversation lifecycle

`openDrivenConversation` owns opening, the executor lease, following the log,
dispatch, driver changes, rendering snapshots, and shutdown for both chat and
run. Callers use that lifecycle instead of assembling their own follower or
cleanup sequence. Artifact hosting is a required capability at this seam.

The driver follows durable appends while idle as well as during turns. File
notifications are hints; polling also checks for work. An immediate local
callback and the follower share dispatch deduplication. The delivery cursor
advances after dispatch, never before it. This is durable at-least-once
recovery: input IDs and epoch checks provide idempotence, not a claim that
an external process can never see a retry after a crash.

Queue inputs wait for a turn boundary. Steer and answer inputs reach the live
turn where supported. An idle steer or answer stays with the driver in force;
only a queue-input boundary applies a changed preference. Pending credit
survives driver changes. Production drivers currently grant no droppable
credit, so the credit protocol is tested but live token deltas are not recorded.

The terminal paints cached snapshots. A failed submission keeps the draft.
Stopping releases resources even when appending a final event or closing a
harness fails. Error reporting itself must not prevent cleanup.

## Failure and vocabulary ownership

The protocol owns frame kinds, event classes, refusals, input modes, and
bounds. Import those definitions rather than copying literals into another
layer. Unknown hcn event kinds pass through the harness decoder.

Store failure has one owner at the source boundary. A busy artifact read may
produce one durable warning if that warning can be appended; the prompt then
omits the unreadable artifact state. A patch needing those bytes is refused
as `E-PATCH-09`. Failure to append stops the source and produces one sanitized
out-of-log diagnostic. It does not recursively append errors or depend on a
successful detach. Previously owed artifact bytes remain owed.

Answer demotion uses the typed error code and input ID. Only an uncoded error
may use the exact legacy prose prefix followed by a wire-valid input ID. An
unknown code does not fall back to prose matching, and non-error events never
trigger demotion.

A refused hcn child is shut down by ending input, sending TERM, escalating to
KILL after a bound, and waiting for pumps to settle. Releasing the lifecycle
must not leave the child or its output tasks running.

## Code and verification

| Contract | Source | Oracles |
|---|---|---|
| Lifecycle and dispatch | [runtime](../src/cli/runtime.ts), [delivery](../src/store/deliver.ts) | [runtime tests](../test/cli/runtime.test.ts), [live delivery](../test/live-delivery.test.ts), [cursor tests](../test/store/cursor.test.ts) |
| Fold and append | [log](../src/store/log.ts), [conversation host](../src/store/conversation-host.ts) | [store tests](../test/store/store.test.ts), [effect collection](../test/store/collect-effects.test.ts), [artifact placement](../test/store/artifact-place.test.ts) |
| Protocol ownership | [protocol](../src/protocol/index.ts) | [reducer](../test/protocol/reducer.test.ts), [events](../test/protocol/events.test.ts), [frames](../test/protocol/frames.test.ts) |
| Failure ownership | [host](../src/modes/host.ts), [server](../src/server/server.ts) | [store failures](../test/modes/store-failures.test.ts), [server seams](../test/server/seams.test.ts) |

These contracts consolidate the substrate plan and completed RFCs 02-05 and
13. Their historical labels remain in some oracle names; see the
[archive policy](README.md#historical-references).

# Lucid - Domain Context

Canonical vocabulary for Lucid. Terms here are the shared language for the
RFC, the plan, and the code. If a word below is used in a conflicting way
anywhere, this file wins - update it here first, then the usage.

## What Lucid is

An agent-agnostic CLI that turns a terminal coding agent's response into an
**addressable HTML artifact** a human can review and mark up at the element
and text-range level, looping located feedback back to the agent. It
re-implements the problem `lavish-axi` solves, with different technology
(Bun single-binary, Effect, Lit + Shadow DOM) and an addressable-surface
focus.

## Shape

```
viewer  - the whole Lucid window in the browser
 |- chrome    composer | conversation log | queued annotations | controls
 |- surface   the ADDRESSABLE rendering of the agent's output
     |- artifact   agent-authored, free-form HTML (content, not Lucid UI)
     |- overlay    injected Lit + Shadow-DOM layer that makes the
                   artifact addressable (hover targets, annotation
                   cards, text-range highlights)
```

`chrome` lives *around* the artifact; `overlay` lives *on* it. Together with
the artifact, the overlay forms the `surface`; the `surface` plus the
`chrome` form the `viewer`.

## Glossary

### Artifact
The agent-authored, free-form HTML document under review. It is **content,
not Lucid UI**, and renders identically with or without Lucid. The agent has
full creative freedom over it (any HTML/CSS, sandboxed JS).

**The artifact is the primary, durable object** (artifact-first, D18). What
Lucid's CLI and payload historically call a "session" is the artifact's
review record - the co-located log, versions and annotations - and it lives
and dies with the artifact. A **harness session** (a Claude Code / Codex
conversation) is a different object: an inference source temporarily
associated with the artifact. An artifact accumulates a session history -
born in one harness session, continued in others - derived entirely from
optional `attendant` provenance stamps on agent-originated log events. The
payload keeps the field name `session` (the artifact path) for
compatibility; prose should say "review record" for the artifact side and
"harness session" for the inference side.

### Surface
The **addressable rendering** of the agent's output: the artifact plus the
overlay that makes every part of it targetable. "Addressable surface" is
Lucid's core concept.

### Overlay
The interaction layer Lucid injects into/over the artifact (built with Lit +
Shadow DOM) that makes the surface addressable: hover targets, annotation
cards, text-range highlights. It is **CSS-isolated** from the artifact (Shadow
DOM) and never alters the saved artifact file. The artifact iframe is served
with `sandbox="allow-scripts"` (no `allow-same-origin`), which gives it an
opaque origin: the overlay loads and runs, and `postMessage` crosses the
boundary, but artifact-authored scripts cannot reach the Lucid control routes
(`/__lucid/*`) - those are now cross-origin from the opaque iframe and rejected
by both the browser and the server's Host/Origin validation (D-020, resolved).
Because the overlay is injected into the artifact's iframe, it shares the
artifact's **JS realm** - Shadow DOM gives the CSS isolation, and the
opaque-origin sandbox gives the script boundary the artifact cannot cross. The
defensive re-mount is scoped and debounced: it fires only when the overlay's own
nodes are removed or altered, never on arbitrary artifact DOM mutation, so a
self-mutating or animated artifact does not thrash it (D-041).

### Chrome
The Lucid-owned panel surrounding the artifact: the composer, the
conversation log, the **composer queue** (the list of composed-but-unsent
annotations - distinct from the log-side delivery queue `wait` drains), and
controls. Distinct from the overlay - chrome is *around* the artifact, overlay
is *on* it.

### Viewer
The whole Lucid window the human sees in the browser: chrome + surface.

### Addressability / addressable
The property that any element or text range in the artifact can be targeted
by an annotation. In Lucid, addressability is applied by the surface, not
required of the agent. It is **best-effort** (D-022): some artifact-authored
content is inherently unreachable - closed shadow roots, text painted into
`<canvas>`, nested cross-origin iframes - and the overlay marks such regions as
non-addressable rather than failing silently. **Open** shadow roots also
degrade addressability in the current implementation: the element-anchor
fingerprint and DOM-path resolvers scan the light DOM
(`querySelectorAll("*")`) and do not recurse into `shadowRoot`, so a web
component that renders its content into an open shadow root is not targetable
even though the browser could reach it; agents that want such content
annotated should expose it in the light DOM or supply a `data-lucid-id`. An
artifact whose own JS reshapes the DOM **within a version** (no file change)
also degrades it: the overlay re-resolves and orphans committed anchors on
intra-version DOM mutation too, not only on a version swap, so feedback is
never silently detached (D-041).

### Annotation
One piece of **located** human feedback, bound to a specific element or text
range via an anchor, optionally carrying a note. Each annotation records the
artifact **version** it was authored against - the version the browser was
displaying, supplied by the client in the POST and **validated** (not trusted)
server-side: an out-of-range or malformed stamp orphans the annotation rather than
anchoring it (D-023, D-066). An annotation whose anchor
fails to re-attach to the current version is **orphaned** (D-029): surfaced in an
orphaned tray and marked `resolved: false` in the wait payload, never floated at
a stale offset or silently dropped. If the authored-version snapshot is itself
missing or hash-mismatched, the annotation is orphaned rather than re-anchored
against the current version (D-035). An orphan leaves the tray only when a human
dismisses it or the agent acknowledges or re-anchors it via a revision (D-047).

### Feedback
The umbrella for what flows back to the agent: **annotations** (located) plus
human **messages** (non-located, in the conversation log). The human may also
post an **approve/resolve** signal (`review_resolved`), a positive
done-or-approved event distinct from suspend and from explicit `end`, which tells
the agent it can stop iterating (D-046). Approving winds the chrome down to an
approved state; to add more, the human clicks **reopen review**, posting
`review_reopened`, which clears `reviewResolved` so post-approval feedback is
unambiguous (D-059).

### Anchor
The layered locator that binds an annotation to its target and survives most
re-renders. Resolution runs against the snapshot of the **version the annotation
was authored against** first, then carries forward to the current version.
- **Element**: resolved in priority order - `data-lucid-id` (if the agent
  supplied one; it MUST be unique within a version, else resolution skips it and
  falls through to fingerprint - D-047), then a content+structure fingerprint,
  then a DOM path.
- **Text range**: a text quote (exact text + prefix/suffix context) with a
  character-position fallback; position offsets are relative to the artifact
  document body `textContent` (the W3C default - D-047).

### Session
One artifact under review, identified by its **canonical file path**,
together with its event log and lifecycle (`open` -> `wait`/iterate ->
`end`). A genuinely new topic is a new artifact path, and therefore a new
session. Status is one of **active**, **suspended** (paused for inactivity, or ACTIVE-in-log
with a dead server; `wait` reports it, a human resumes via `open` - D-021, D-038),
or **ended** (terminal; only an explicit `end` reaches it - D-021). `open` on an
ENDED path starts a fresh lifecycle **segment** in the same log rather than
erroring (D-045). Multiple concurrent single-artifact sessions each run their own
independent per-session loopback server and origin ("multi-session" - D-036); that
is distinct from the deferred multi-artifact-per-session. Discovery is per-session via `.lucid/<name>/server.json`; bare `lucid` enumerates
only sessions reachable without a global index, and cross-filesystem enumeration of
scattered sessions from any cwd is a deferred limitation - there is no global session
registry (D-065, supersedes D-052).

### Event log (state file)
The co-located, append-only NDJSON file that is the session's **source of
truth**. Current state (annotations, conversation, current version, status)
is derived by folding the log. Every event carries a `seq` assigned by the writer
under the log lock, **globally monotonic across all segments and never reset**
(D-040, D-050). It has a **single appender during an ACTIVE served session: the
server** (D-030), and every append is serialized by an **exclusive advisory lock
(`flock`)** so a mis-judged liveness can never interleave two writers (D-049);
lifecycle commands may write under that lock when no server is live - liveness
determined by a **port handshake, not pid existence** (a reused pid is a
false-positive) - a resuming `open` writes `session_resumed`, `end` writes
`session_ended` directly (D-038, D-049). The browser POSTs events with
**high-entropy (UUIDv4) client-minted IDs** that the server dedupes against the IDs
already in the log (D-044, D-057). The watcher **structurally** validates a settled
file (closing root + balanced structure, not mere parseability) before committing a
segment-scoped snapshot, and reconciles `<file>` against `current.html` on resume
(D-061). Folding tolerates a torn trailing line (crash mid-append) and is
**per-field segment-scoped**: status, current version, `reviewResolved`, the live
annotation set, and the orphan tray come from the latest segment, earlier segments
are read-only history (D-056). Any harness resumes a session by calling `wait` with
no cursor, which returns the full folded state of the current segment.

### Version
A captured revision of the artifact, recorded in the event log as a `version`
event. History is retained from day one; the human-facing diff/revert view is a
later addition. The agent MUST write `<file>` atomically (temp file in the **same
directory** as the target) and the watcher MUST **structurally** validate the
settled file - closing root + balanced structure, not mere parseability - before
committing it (D-043, D-061). A version is committed crash-safely by writing the
**segment-scoped** snapshot `versions/sN/vM.html` then appending the event (D-024,
D-050).

### Snapshot
The frozen HTML file for a version (`versions/vN.html`), referenced from the
`version` event by path + `sha256` hash. The **snapshot** is the file; the
**version** is the recorded revision/event. Distinct from `current.html`, which
is Lucid's live copy of the latest `<file>`.

### Cursor
The **caller-owned** delivery position passed to `wait` (`--since <cursor>`). It
is the per-event `seq`, **globally monotonic across all lifecycle segments and
never reset** (D-040, D-050), so a persisted cursor stays valid across an
`end`-then-reopen. `wait` **tails the log file directly** (the server is only a
writer; D-051). With no cursor, `wait` returns the full folded state of the current
segment (D-056); otherwise it returns events with `seq` greater than the cursor and
echoes a `nextCursor` the caller persists. `open` returns an opening `nextCursor`
so the authoring agent can take only forward feedback without a full fold. There is
no shared server-side watermark; delivery is at-least-once with idempotent IDs, so
a correct caller advances its persisted cursor only after durably applying the
payload, or dedupes by event ID (D-019, D-040). For inspection only, a
`wait --harness <id>` writes its `nextCursor` to an advisory sidecar
`cursor.<harness>.json` (D-051).

### Response channels
In a turn the agent may **mutate the artifact** (producing a new version,
live-reloaded into the surface), **reply in the conversation log** without
changing the artifact (e.g. answering a question), or both. Artifact updates
are feedback-driven, not every-turn. On a new version the viewer live-reloads by
swapping only the artifact subtree and re-running anchors; the swap is deferred
**only** while a committed-but-unsent composer card exists (a bare selection does
not defer), and while deferred the viewer shows a non-blocking newer-version
indicator so staleness is bounded and the draft is never lost (D-042, D-055).

### The contract
What an agent must do to use Lucid: emit a free-form HTML artifact to a file
and follow the CLI protocol (`open` to serve, `wait` to receive feedback,
`end` to close), consuming the documented wait-payload. The agent is
**instructed** that Lucid exists; it does not detect Lucid at runtime.
Invoking Lucid is itself the signal that a response is an artifact rather
than prose.

### wait
The command/loop an agent runs to receive feedback. It **tails the log file
directly** (the server is only a writer; D-051). With no `--since` cursor it returns
the **full folded state of the current segment** (cross-agent bootstrap; D-056);
with a cursor it returns events after it - immediately if any are queued
(drain-if-ready), otherwise blocking. A delta carrying only `version` events (no
annotation/message/`review_resolved`) returns `waiting`, not `feedback`, so the
authoring agent's own revision does not self-trigger (D-062). It MAY return
`waiting` after a bounded, configurable window (no feedback yet; re-issue). On
`suspended` it returns immediately and the agent MUST stop re-issuing and hand back
to a human, never busy-loop (D-039); before blocking on an ACTIVE fold it verifies
the server is live by a **port handshake (not pid existence)** and reports
`suspended` if not (D-038, D-049). Crash-safe and resumable - killing it or swapping
agents loses nothing, since state is re-derived from the event log against the
caller-owned cursor. ("queued" here is log-side, distinct from the chrome's
**composer queue** of composed-but-unsent annotations.)

### open / end
`open` starts, or discovers-and-reuses, an **independent per-session loopback
server** for that one artifact (its own port and origin), discovered via this
session's `server.json` and verified by a **port handshake, not pid existence**
(D-036, D-049); it serves the artifact, opens the viewer, returns an opening cursor,
and on resume writes `session_resumed` under the log lock (D-038, D-049). `open` on an
ENDED path starts a fresh lifecycle segment (D-045). `end` is the only path to the
terminal **ended** state and stops this session's server. Inactivity **suspends** a
session rather than ending it (D-021, D-036). `suspended` and `review_resolved`
release the agent from its wait loop; once it has stopped, nothing but
**external re-invocation** brings it back - `open`/resume does not notify a
stopped agent (D-064). Approval is a release, not an end: the agent leaves the
session open (so the human can reopen the review), does the approved work, and
drains the log once before ending its turn - only a drain that still shows
`reviewResolved: true` clears it to `end`.

### Harness / agent
The terminal coding agent driving Lucid (Claude Code, Codex, OpenCode, or a
custom one). Lucid is **harness-agnostic**: the only integration surface is
the CLI protocol and the co-located event log, so any harness can drive or
resume a session.

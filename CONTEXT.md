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
shell   - one browser window over every OPEN artifact
 |- tab bar   tabs, grouped by project
 |- viewer    the whole Lucid window for the ACTIVE tab
     |- chrome    composer | conversation log | queued annotations | controls
     |- surface   the ADDRESSABLE rendering of the agent's output
         |- artifact   agent-authored, free-form HTML (content, not Lucid UI)
         |- overlay    injected Lit + Shadow-DOM layer that makes the
                       artifact addressable (hover targets, annotation
                       cards, text-range highlights)
```

`chrome` lives *around* the artifact; `overlay` lives *on* it. Together with
the artifact, the overlay forms the `surface`; the `surface` plus the
`chrome` form the `viewer`. One `viewer` per open artifact; the `shell` holds
them all in one window and shows one at a time.

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

Not to be confused with **View** below, which is the *window a surface is
presented in*. One word, one meaning: plan 06 nearly gave this one a second
sense, and the two are a level apart - a surface is what you can point at, a
view is where you are looking at it.

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

**Boot independence** (the normative invariant; plan 04): *the overlay's
ability to boot and to resolve an anchor MUST NOT depend on any property the
artifact author controls* - not its CSP, not its pre-registered handlers, not
its markup shape, not its `<base>`, not its DOM size. Where the artifact can
express such a property, injection neutralizes or overrides it **for the
bootstrap specifically, leaving the artifact otherwise intact**. That second
clause is the hard half, and every mechanism is shaped by it:

- **CSP.** A document `<meta>` policy is lifted into the response header
  (header and meta policies intersect, so a meta would block the injected
  module whatever a header allowed), minus the directives a meta is *required*
  to ignore - lifting `report-uri`, `report-to`, `frame-ancestors` or `sandbox`
  would switch on something the author could not have meant. The script
  directive grants the bootstrap the narrowest thing that works: the serving
  origin when the author kept `'unsafe-inline'` (a nonce would make the browser
  ignore it and strip the artifact's own inline content), a nonce otherwise.
- **Styles.** The overlay adopts **constructed stylesheets**, which `style-src`
  does not govern - so the author's `style-src` is never touched, no style
  nonce exists, and no nonce is published on the page's global for an artifact
  script to borrow.
- **Events.** Picking listens at **window capture**, beside the artifact's own
  handlers rather than below them: `stopPropagation` cannot silence a co-target
  listener.
- **URLs.** The bootstrap `src` is origin-absolute, so a document `<base>`
  cannot re-root it.
- **Markup and scale.** The bootstrap splices at the close the *parser* honors
  (a literal `</body>` in a textarea, script, comment or attribute is text),
  and anchor resolution indexes siblings in one pass, so neither a hostile
  markup shape nor DOM fan-out can stop the loop.

The corpus of hostile artifacts (`test/e2e/hostile-fixtures.ts`) is the
permanent fence: every fixture must survive the full loop, and a fixture that
cannot is a recorded defect with a named ledger entry, never a silent skip.

### Chrome
The Lucid-owned panel surrounding the artifact: the composer, the
conversation log, the **composer queue** (the list of composed-but-unsent
annotations - distinct from the log-side delivery queue `wait` drains), and
controls. Distinct from the overlay - chrome is *around* the artifact, overlay
is *on* it.

### View
**Which window a review is presented in** - not to be confused with Surface
above. Two values, and `open` reports which one it resolved:

- **shell** - the terminal harness's window over many sessions, with a tab
  strip and a palette. The default; nothing about it changed when the other
  arrived.
- **solo** - one session and nothing around it. What a chat desktop app's
  embedded browser pane shows, because the chat app already plays the role the
  shell plays for a terminal harness: a tab strip inside a conversation pane
  offers navigation the conversation already owns.

Opted into per harness integration with `LUCID_VIEW=solo` (never by sniffing
the host app, whose own env vars are undocumented and unstable). The invariant,
which is the whole of it:

> **A view decides presentation only - never process topology.**

A hub still hosts the session if one is running, the hub is still the single
appender, and there is no second process either way. What changes is which URL
`open` returns and whether a browser is launched. See
[docs/EMBEDDED.md](./docs/EMBEDDED.md) for the integration contract.

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

**The identity and resolution invariant** (plan 05):

1. **A session is its artifact's REAL path.** Identity runs through
   `realpath`, so a symlink and its target are one session with one record and
   one log - never two histories for one document. Two records that BOTH hold
   history are refused rather than merged behind you.
2. **One record per name.** A record is named after its artifact with the
   extension dropped, so `plan.html` and `plan.md` in one folder want one
   folder; the second is refused, naming the record and the artifact that owns
   it, and the first artifact's log is never appended to.
3. **Resolution says HOW it matched, and a guess is never reported as a
   match.** A `data-lucid-id` or a unique fingerprint is exact; a domPath
   fall-through, or a range surviving only on character offsets, is
   *positional* - the target is whatever now occupies that slot. The wire
   carries `confidence: "low"` for those and the viewer marks them. A miss
   stays unresolved; the qualifier applies to a success that is a guess, and
   never softens a failure into a maybe.
4. **A refusal creates nothing.** Every check that can refuse an `open` runs
   before any directory is made, so a rejected artifact leaves no record
   behind.

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
is distinct from the deferred multi-artifact-per-session. Per-session discovery is
via `<name>/run/server.json` inside the record. Since plan 02 the record sits
BESIDE its artifact, whatever directory that is - `<dir>/plan.html` ->
`<dir>/plan/`. With artifacts living at `<project>/.lucid/plan.html`, that
makes the record `<project>/.lucid/plan/`; what plan 02 removed was the
SECOND, hidden `.lucid/` nested inside the artifact's own folder. **Model B superseded D-065's "no global session
registry":** a global pointer registry now exists at `<home>/.lucid/registry.json`,
holding only pointers and `lastSeen` - never session data - and the **hub** unions it
with a scan of its **roots** to produce the **listing**. Cross-filesystem enumeration
of scattered artifacts is no longer a deferred limitation; that is what the hub is
for.

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
segment-scoped snapshot, and reconciles `<file>` against the newest **committed
snapshot** on resume - not the machine-local `run/current.html`, which a fresh pull
may not have - rebuilding `current.html` from that snapshot when it is absent
(D-061; plan 02). Folding tolerates a torn trailing line (crash mid-append) and is
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
is Lucid's live copy of the latest `<file>` - **machine-local**, so it lives
under `run/` (`.lucid/<name>/run/current.html`) and is rebuilt from the newest
snapshot when a fresh checkout lacks it, never committed (plan 02).

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

## Glossary - the shell

The vocabulary of the window a human keeps open, as opposed to the
review-protocol vocabulary above. Everything here is about *reaching* an
artifact; nothing here is about reviewing one.

### Hub
The always-on loopback daemon (Model B): one process per machine that
discovers every artifact under its **roots**, hosts each one in-process under
an opaque id (`/s/<id>`), and serves the **shell** at `/`. Data never moves -
a hosted artifact reads and writes its own co-located `.lucid/<name>/` exactly
as a dedicated per-session server does. **Canonical layout (plan 02):** the
artifact and its record sit together under a project's `.lucid/`
(`<project>/.lucid/<name>.html` beside `<project>/.lucid/<name>/`), so review
history is committable and travels with the repo. Committed history (the log,
`versions/`, `pasted/`, `forks/`) lives at the record root; everything
machine-local (the served `current.html`, `server.json`, out-logs, the
`context`/`selection`/`cursor` sidecars, the append lock) lives under `run/`,
kept out of git by a single `run/` line in the record's `.gitignore`. When an
artifact already has a live
dedicated server, the hub proxies to it rather than hosting it, preserving the
one-appender rule (D-049).
_Avoid_: daemon, server (both are ambiguous - "server" is also the
per-session loopback server).

### Root
A folder the hub scans for artifacts. Defaults to the user's project checkouts
plus the agent scratchpads where most artifacts actually land; a human adds
more by hand, and added roots persist across hub restarts. A root is *where to
look*, never *what to show*.

### Listing
The hub's snapshot of every artifact it knows about, broadcast to every open
shell. Derived from the global pointer registry unioned with a scan of the
**roots**. The listing is the cross-project index: it is what makes an artifact
reachable from a window opened anywhere.
_Avoid_: session list, index.

### Project
The grouping key for artifacts - **derived, never declared**. A human never
registers a project; the hub resolves one for every artifact: an artifact in an
agent scratchpad belongs to the project that agent was *working on* (not to the
scratchpad), otherwise to its enclosing repository root. A git **worktree**
resolves to its main repository, and the worktree is kept as a *qualifier* on
the artifact rather than becoming a project of its own.

A project **labels and groups**; it never filters. There is no notion of "the
project you are currently in" - the shell is never scoped to one.
_Avoid_: **project scope**, active project, workspace. (An earlier shell
scoped the tab bar to one project at a time and gated switching behind a
projects drawer. Both are removed - see `.plans/03-cross-project-tab-bar/`.)

### Tab
One **open artifact** in the shell, holding that artifact's **viewer** and its
live connection to the hub. Every tab is an artifact; most artifacts are not
tabs. Closing a tab drops the connection and nothing else - the review record
is untouched, and reopening refolds it from the log.

"Tab" is the artifact-first term (D18). The shell's code still says `session`
in its identifiers (`sessionKeys`, `HubSession`, `openTab`) - legacy naming,
the same accommodation the payload's `session` field already carries. Prose
says tab and artifact.
_Avoid_: session (as a name for a tab), pane, window.

### Tab group
The run of tabs in the shell belonging to one **project**, labelled once at the
head of the run. A tab's group is a fact about its artifact, not a human
choice: a tab cannot be dragged into another group, and a group never contains
two projects. Groups are ordered by when the project was first opened and do
not reorder afterwards.

### Attention state
What a tab reports about its artifact *without being looked at*: a question is
waiting on the human, the agent is working, a turn finished and has not been
seen, or the review is settled. It is derived from the artifact's review record
but carried on the **listing**, so a tab reports truthfully whether or not its
own connection is currently live.
_Avoid_: status, badge, activity (status already names the session lifecycle -
active/suspended/ended - and means something else).

### Unseen
The property of a tab whose artifact changed since the human last **activated**
that tab. Cleared by activating the tab, never by the change itself settling: a
turn that finishes while the human is looking elsewhere stays marked until they
actually arrive.
_Avoid_: unread, dirty, stale.

## Relationships

- One **hub** serves many **shells** (one per browser window) and publishes one
  **listing** to all of them.
- A **hub** scans many **roots**; a **root** contains zero or more **artifacts**.
- A **shell** holds zero or more **tabs**; each **tab** holds exactly one
  **artifact** and renders exactly one **viewer**.
- Every **artifact** resolves to exactly one **project**; a **project** appears
  at most once in a shell, as one **tab group**.
- Every **tab** has exactly one **attention state**; **unseen** is a separate
  property that can hold alongside any of them.

## Flagged ambiguities

- **"Session" names four things** - the harness conversation, an artifact's
  review record, the payload's `session` field, and the shell's `HubSession`
  listing row. Resolved: one glossary, disambiguated in prose. Say **harness
  session** for the conversation, **review record** for the artifact's log and
  annotations, **tab** for an open artifact in the shell. Bare "session" in
  code identifiers and the wire payload is legacy naming, kept for
  compatibility.
- **"Project" was used both as a grouping and as a filter.** Resolved: grouping
  only. A project labels and groups tabs; it never restricts what the shell
  shows.
- **"Server" names two things** - the per-session loopback server and the hub.
  Resolved: say **hub** for the daemon, **per-session server** for the other.

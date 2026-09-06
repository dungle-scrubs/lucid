---
number: 06
title: "An artifact you can address"
type: feature
status: Implemented
author: Kevin Frilot
date: 2026-08-24
---

# RFC-06: An artifact you can address

> **Revision 2.** Answers
> `06_an-artifact-you-can-address.review-draft-2026-08-24.md` - two independent
> cross-family reviews (`muse-spark-1.2-contributor@muse`, `gpt-5.6-sol@codex`).
> Four blocking findings; they agree on two and each found the other's blind
> spot. What changed:
>
> - **B1** A save had two incompatible meanings - an artifact entry that starts
>   no turn, and an input encoded in text. Both reviewers. A save is an artifact
>   entry; the text encoding covers annotation batches only.
> - **B2** The 1MB text bound. A whole-document save cannot fit it, and the
>   bound bites emission too - `serializableObject` caps event payloads, so an
>   artifact arriving in a message hits the same ceiling. Now a stated limit
>   rather than an unnoticed one.
> - **B3** The fence format was deferred twice - #60 passed it to #61, which
>   settled the entry and not how emission supplies it. Decided here.
> - **B4** Emission only described session mode. Turn mode takes one prompt per
>   process and an interactive session is never handed a prompt by lucid at all,
>   so it cannot be taught anything. Now scoped explicitly.
>
> Nine majors folded in and marked where they land.
>
> Renders the decisions of wayfinder map
> [#59](https://github.com/dungle-scrubs/lucid-v2/issues/59), resolved as
> tickets #60-#69. Where revision 2 goes beyond what a ticket decided, it says
> so - the reviews were right that "nothing here is new" has to be checked
> rather than claimed.

## Abstract

An agent emits a document. It renders in a browser beside the conversation. You
select one or more elements and write a note against them, or you operate
controls the agent put there and save. Both reach the agent. The agent responds
by producing a new version, changing the document wherever it judges best.

Artifacts are emitted as a fenced block lucid teaches and parses, stored in the
log but never folded into state, and served to a browser by a loopback server
that appends without holding the executor lease. Annotations carry captured
content with per-spot provenance. Anchors follow the W3C Web Annotation Data
Model, with lucid's own rules for ambiguity and drift on top.

## Motivation

lucid routes a conversation into a durable record and back out. Everything built
so far is that substrate: three integration modes, four harnesses, resume,
cross-harness handoff, live delivery, and a terminal window you can talk back
in.

None of it is the point. The substrate exists so that an agent's output can be
looked at and marked up, and until something is built on it, lucid is a way to
have a conversation in a terminal - which is what the harnesses already were.

This is the first thing built on it, and it is the reason the constraint that
governed the whole substrate existed: no artifact, no annotation, no browser
surface until the substrate is tested through every integration mode. That gate
is met.

## Introduction

### What this is for

lucid routes a conversation into a durable record and back out. Everything
built so far is that substrate: three integration modes, four harnesses,
resume, cross-harness handoff, live delivery, and a terminal window you can
talk back in.

This is the first thing built *on* it. The substrate exists so that an agent's
output can be looked at and marked up, and this RFC is that.

### The interaction, precisely

Annotation here is **addressing**, not correcting. "Explain further." "What is
this?" "You forgot this." A revision request with a location, not marginalia.
The agent may answer by rewriting that spot, or by adding an explanation
elsewhere and leaving the spot untouched. Both are correct and it decides.

Editing is a second act on the same surface. The agent puts controls in the
document - a checkbox beside a todo, an empty input, a textarea - and operating
them and saving tells it what you did.

### Scope

In scope: artifact emission, storage and versioning; the browser surface;
element selection and annotation; in-place editing and save; anchoring across
versions.

Out of scope, each ruled during charting:

- **Annotation status** - addressed, open, dismissed. Past the destination.
  One constraint stands for whenever it returns: status must be stated, never
  inferred from whether an anchor still resolves.
- **The hub, the shell, fork launching** - v1 concepts past this destination.
- **Remote and multi-user access.** One user, one machine, unchanged.
- **Retiring lucid v1.** It stays in use and keeps the `lucid` name.

### Slices

1. The loop, one version at a time. Marks paint on the version they were
   authored against, so nothing is re-anchored and nothing can be orphaned.
2. Editing in place, and save.
3. Annotations across versions - selectors, snapshots, drift, orphans.

## Terminology

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be interpreted
as described in RFC 2119. Other nouns come from `CONTEXT.md`.

- **artifact** - a document an agent emitted, identified by an id, existing as
  an ordered list of versions.
- **version** - one state of an artifact, authored by the agent or by the human.
- **spot** - one anchored place in an artifact. An annotation has one or more.
- **snippet** - the content that was on screen at a spot when it was annotated.
- **save** - the commit point that turns working edits into a version.
- **the server** - the loopback HTTP process serving the browser surface.

## Design

### Emission: lucid teaches, lucid parses

*(from [#60](https://github.com/dungle-scrubs/lucid-v2/issues/60))*

lucid MUST prepend a preamble teaching the agent to emit an artifact as a
fenced block, and MUST parse that block out of the message that carries it.

This is hcn's own mechanism for questions, and it requires no harness
cooperation: prompt text in, structured text out. lucid controls both ends - it
composes the text handed to the harness and receives `message` events.

lucid MUST NOT require an hcn change for this. hcn normalizes what harnesses
**differ** about; its question protocol exists because asking differs per
harness. No harness has a native artifact concept, so there is nothing to
normalize, and ADR 0007 places it on the caller.

#### Which integration modes can emit *(B4)*

Revision 1 described only `session.send` and said the preamble is composed once
at session start. lucid has three integration modes and they are not alike:

| Profile | How a prompt reaches the agent | Artifacts |
|---|---|---|
| `headless-session` | `session.send`, one process across turns | **Yes.** Preamble composed once when the session opens. |
| `headless-turn` | `streamTurn`, one process per turn | **Yes.** The preamble MUST be prepended to every turn, because the process that learned it does not survive. |
| `interactive` | lucid never composes a prompt | **No.** |

The interactive case is a genuine exclusion rather than an oversight. lucid
attaches to that session through a `SessionStart` hook that appends attach state
and hands the agent no context at all. There is nowhere to put a preamble, so an
interactive session cannot be taught this protocol and MUST NOT be expected to
emit artifacts. A record can still be *viewed* in the browser while an
interactive session drives it; it just will not produce artifacts.

#### The fence format *(B3)*

Deferred by #60 to #61, and #61 settled the log entry without settling how
emission supplies it. Deferring a third time would leave implementation steps 1
and 2 without a shared contract, so it is decided here.

```
```lucid-artifact
{"id": "<stable across versions>", "replaces": <version|null>, "contentType": "text/html"}
```
<the document>
```
```

- **`id`** - the agent chooses it and reuses it to revise. A block whose id is
  unknown starts a new artifact at version 1.
- **`replaces`** - the version this one supersedes, or `null` for a first
  emission. lucid MUST refuse a block whose `replaces` is not the artifact's
  current version: an agent revising a version it has not seen is working from
  a stale document, and silently accepting it would lose whatever it missed.
- **`contentType`** - what the renderer needs to know.
- **version, author and hash are lucid's**, never the agent's. The agent does
  not number versions, does not assert authorship, and cannot supply a hash of
  content lucid has not yet stored.

Two blocks in one message are both parsed, in order. A malformed block is
refused with the reason recorded, and the message is otherwise unaffected -
never a dropped turn.

### Storage: in the log, not folded

*(from [#61](https://github.com/dungle-scrubs/lucid-v2/issues/61))*

An artifact version is its own log entry kind. The fold MUST NOT reduce it into
`ChannelState` or the transcript.

The fold does still `JSON.parse` the line, because the entry's source is a field
inside it. That cost is paid once per record open; subsequent folds are
incremental byte ranges, so a running session does not re-parse old artifacts.

Each entry carries: **artifact id**, **version**, **author**, **content type**,
**hash**, and the bytes. The hash is not used until slice three, and MUST be
written from the start - a version written without one can never gain it.

Reading a version is a seek, not a fold. An index of
`(artifact id, version) -> offset` is derived during the fold that already
happens at open.

Artifacts MUST NOT be mutated in place. Every version is a new entry. An
annotation authored against version 3 must be able to find version 3 exactly as
it was, and rewriting an entry would destroy the ground an earlier annotation
stands on.

### The browser surface

*(from [#62](https://github.com/dungle-scrubs/lucid-v2/issues/62),
[#69](https://github.com/dungle-scrubs/lucid-v2/issues/69))*

Components come from assistant-ui where possible. `ExternalStoreRuntime` keeps
lucid's record as the only source of truth - lucid converts its transcript
rather than handing state over. `AssistantSidebar` is chat beside artifact.

**The server is a writer, not a driver.** It MUST NOT hold the presence lock,
open a harness, or act on effects. It appends exactly as `lucid2 send` does,
with `executorLease` false, and whatever it appends reaches the agent through
the process that does hold the lease - live delivery, which already exists.

One server serves all records, started explicitly by its own command, bound to
`127.0.0.1` on port **17454**. Never a wildcard bind. The port MUST be recorded
in `~/.agents/PORTS.md`; v1 holds 17412-17419 and 17428 and stays in use.

The server MUST seek per request and MUST NOT cache documents. Artifacts are
fetched on a separate channel from the conversation stream: the stream is small
and frequent, artifacts large and rare.

**A new version MUST NOT replace what the human is working on.** With no pending
marks and no unsaved edits, a new version may be shown directly. Otherwise the
page reports that one exists and stays where it is until the human switches.
This makes a wholesale frame reload safe, and avoids patching agent-written HTML
in place, which can corrupt a document silently.

### Rendering and selection: the instrumented iframe

The artifact renders in a **sandboxed iframe** via `srcdoc`. lucid instruments
the document first: an id per element, plus a script that draws hover highlight
inside the frame, tracks command-click multi-select, listens for changes to
controls, and posts out only ids and values.

The parent MUST NOT touch the frame's DOM. Reaching in requires
`allow-same-origin`, which lets the frame reach back out; shadow DOM instead of
an iframe would run agent-written script in lucid's origin. The trust boundary
is one narrow message rather than DOM access.

lucid's instrumentation MUST NOT appear in anything sent to the agent, and MUST
NOT mistake the agent's own scripted DOM changes for the human's edits.

### Annotations

*(from [#63](https://github.com/dungle-scrubs/lucid-v2/issues/63))*

An annotation carries the **note**, the **artifact id and version** it was made
against, and one entry per **spot**. Each spot carries the element id, the
**snippet**, and the **author** of the version that snippet came from.

The snippet travels rather than a reference. If the human edits a paragraph and
then annotates it, the agent MUST see the human's text - capturing content at
annotation time settles that with no resolution logic.

**Provenance is per spot, not per annotation.** One annotation can span text the
agent wrote and text the human wrote. Without per-spot authorship the agent
reads all of it as its own work and may defend a sentence it never wrote.

lucid MUST NOT instruct the agent where to put its response.

### Editing and save

*(from [#65](https://github.com/dungle-scrubs/lucid-v2/issues/65))*

A save carries **both** the document as it now stands and a structured map of
the values of controls the agent authored. Ticking a box and rewriting a
paragraph are different acts and neither encoding expresses the other.

**A save is an artifact version entry. It is not an input.** *(B1.)*

Revision 1 said a save produces an artifact version and starts no turn, and
then said saves are encoded in the input text. Both reviewers caught it: an
input is enqueued, counted against `INPUT_QUEUE_MAX`, produces a send effect the
lease holder dispatches, and carries a disposition through its lifecycle. A
thing on the input channel cannot also be "not an input".

So the two paths separate cleanly:

| | Annotation batch | Save |
|---|---|---|
| What it is | a request | a statement of fact |
| Channel | an `input`, encoded in text | an artifact version entry |
| Starts a turn | yes | no |
| Counts against `INPUT_QUEUE_MAX` | yes | no |
| Author recorded | the note is yours | the version is yours |

The save is the commit point, which is what stops every keystroke being a
version. The agent finds a saved version through live delivery or the next
fold - facts wait to be read.

### The size limit, stated *(B2)*

Both reviewers found that a whole-document save does not fit lucid's text bound.
Checking it made the problem larger than either reported: `TEXT_MAX` is
1,000,000, `isWireText` enforces it on input text, and `serializableObject`
enforces it on **event payloads** - so an artifact arriving inside a `message`
event hits the same ceiling as a save would.

The bound is a resource limit protecting the log and the reducer, and raising it
to accommodate documents would weaken it for everything else.

Therefore, and stated as a limit rather than discovered as a failure:

- **An artifact MUST NOT exceed 1MB.** That is a large HTML document, and it is
  not a large image. A document with a photograph inlined as a data URI will
  exceed it.
- lucid MUST refuse an oversized emission with the reason recorded on the turn,
  and MUST tell the person in the window why. An agent that tried to emit
  something too large should learn that, not fail silently.
- The save path does not hit the input bound at all, because a save is not an
  input, but the artifact entry it writes is subject to the same 1MB limit.

The escape hatch, if this proves too tight in use: artifact bytes move to a
sidecar file with the log holding a pointer and hash - the option #61 weighed
and set aside. The entry shape was chosen to make that a change of one field.

### Anchoring across versions

*(from [#66](https://github.com/dungle-scrubs/lucid-v2/issues/66))*

Slice three. Per spot, written at annotation time: a **TextQuoteSelector**
(`{exact, prefix, suffix}`), a **TextPositionSelector**, and a **CssSelector**,
tried in that order. `dom-anchor-text-quote` performs the approximate search;
lucid MUST NOT hand-roll it.

This replaces exactly one thing from v1: its element fingerprint, a hash that is
exact-or-nothing and misses whenever the agent rewords. Everything else from
v1's `src/anchors/` is kept:

- refuse a layer that matches twice rather than guessing
- label how it re-attached, so a caller can tell a confident match from a
  hopeful one
- the snapshot guard: verify the authored version's bytes by hash before
  re-anchoring, and orphan rather than re-point when it cannot be verified
- per-spot resolution with partial paint

An anchor that resolves nowhere MUST be shown as unresolved, attached to its
version, with its note and snippets intact. It MUST NOT be dropped, and MUST NOT
be re-pointed at whatever now occupies that space.

`refinedBy` is NOT used. It nests a selector inside another; these three are
alternatives for one spot.

### Encoding

*(from [#67](https://github.com/dungle-scrubs/lucid-v2/issues/67))*

**An annotation batch** is encoded in the input text, taught by a preamble,
exactly as the artifact block is. No frame gains a field and no protocol version
changes. A batch of marks is **one input**: one idempotent id, one disposition,
one turn, one charge against `INPUT_QUEUE_MAX`.

A save is not encoded here at all - see above.

#### What the projection has to gain

Revision 1 said the projection MUST render a batch as annotations rather than
raw text, and did not say that this is new code. It is. `src/tui/view.ts` strips
exactly one fence today, `hcn-question`, and renders exactly one structured kind,
`question`. Nothing strips a `lucid-artifact` block or an annotation batch, so
without this work a raw document and a wall of JSON would both land in the
terminal transcript.

Three additions, all in the projection and none in the log:

1. Strip the `lucid-artifact` fence from message text; render it as a named
   reference to the artifact and version, never as its bytes.
2. Strip the annotation-batch encoding from input text; render it as the notes
   and the spots they were made against.
3. Render a saved version as a line saying a version was saved, not as a
   document.

The log keeps the raw text in every case. This is the same split the question
block already uses, and the same reason: the log is the truth, the view is a
view.

## State Machine

### An artifact

```
   (no artifact)
        │  agent emits a block with an unknown id
        ▼
   v1 ──── agent emits, replaces = v1 ────► v2 ──── … ────► vN
    │                                        │
    │  human saves, based on v1              │  human saves, based on v2
    ▼                                        ▼
   v2 (author: human)                       v3 (author: human)
```

Versions are a single ordered list per artifact, alternating authors as they
happen. There is no branching: a save based on a superseded version still
appends at the end, recording what it was working from.

Nothing is ever rewritten. An annotation authored against version 3 must find
version 3 exactly as it was.

### The page, against a version

```
   viewing vN, nothing pending
        │  new version arrives ──► viewing vN+1
        │
        │  human selects / edits
        ▼
   viewing vN, work pending
        │  new version arrives ──► still viewing vN, told one exists
        │  sends marks ──────────► viewing vN, nothing pending
        │  saves ────────────────► viewing the version just written
        └  switches version ─────► whatever they chose
```

The rule the states exist for: **lucid never changes version under a person who
has work pending.** That is what makes a wholesale frame reload safe, and it is
why no DOM patching is attempted.

### An annotation, across versions *(slice three)*

```
   authored against vN
        │
        ├─ vN's bytes verify by hash ──► resolve against current
        │                                   ├─ unique match ──► exact
        │                                   ├─ path only ─────► positional
        │                                   └─ nothing ───────► unresolved
        │
        └─ vN's bytes missing or mismatched ──► unresolved, never re-pointed
```

`unresolved` is a state with a surface, not a deletion. The note and its
snippets survive, attached to the version they were made against.

Resolution says nothing about whether the annotation was **addressed**. The
agent may answer by rewriting the spot or by explaining elsewhere, and it
decides. Status is out of scope on this map for exactly that reason.

## Error Handling

Every row is a case the reviews raised or the design creates. Nothing here fails
a turn: an artifact that cannot be stored must never cost the conversation.

| Condition | Handling |
|---|---|
| **Artifact exceeds 1MB** | Refuse the emission, record the reason on the turn, tell the person in the window. The turn otherwise completes. |
| **Malformed `lucid-artifact` block** | Refuse that block with the reason recorded; the rest of the message is unaffected. Never a dropped turn. |
| **`replaces` names a version that is not current** | Refuse. The agent is revising a document it has not seen, and accepting it would lose whatever it missed. Record what it thought it was replacing. |
| **`replaces` names an unknown artifact id** | Treat as a first emission at version 1. An agent that invents an id has started something new, which is harmless. |
| **Two blocks in one message** | Both parsed, in order. |
| **Save based on a superseded version** | Accepted, recording the version it was working from. Not an error, and not merged - the agent reconciles. |
| **Save exceeds 1MB** | Refused, draft kept in the page. Losing typed work to a size limit is the worst outcome available. |
| **Annotation batch exceeds the input bound** | Refused with `input-queue-full` or `wrong-type` as the reducer decides; the page keeps the marks and says why. |
| **`postMessage` from an unexpected source** | Ignored silently. It is either a bug or an attack, and neither deserves a code path that acts. |
| **Token refused** | The page says so and stops. No retry, no renewal; reloading from the server is the remedy. |
| **Server unreachable** | The page says so. The record is unaffected - the server holds no state and no lease. |
| **Artifact entry present but bytes unreadable** | Report it against that version. Slice three's hash makes this detectable rather than silent. |

## Security Considerations

*(from [#68](https://github.com/dungle-scrubs/lucid-v2/issues/68))*

A server is a different kind of surface from a filesystem, and one threat is
concrete: **any website you visit can POST to `127.0.0.1:17454`.** Same-origin
stops it reading the response; it does not stop the request. A simple POST is
delivered without a preflight, so a drive-by page could append inputs to your
conversations.

Therefore:

1. A **session token** minted when the server starts, held in memory, injected
   into the page it serves. A foreign origin cannot read that page.
2. Required as a **custom header** on every request - never a cookie, never a
   query parameter. A custom header forces a preflight the server refuses for
   any origin but its own, so the request never arrives.
3. **Reject unexpected `Origin` values.** Redundant with the preflight, and
   redundancy is right for the one place lucid is reachable by something it did
   not start.

Cookies MUST NOT be used. A cookie is sent automatically, which is the property
that makes CSRF work.

**The record secret MUST NOT reach the browser.** It authenticates an attach;
the browser never attaches. Two credentials for two boundaries, and the more
powerful one stays on the filesystem side.

The artifact itself is untrusted content: agent-written HTML and script,
isolated by the sandbox, never executed in lucid's origin.

### Token lifecycle *(major, both reviewers)*

The token is minted at server start, held in memory only, and never written to
disk. Restarting the server invalidates every page holding the old one, which is
correct: a page from a previous server has no claim on this one.

A page whose token is refused MUST say so and stop, rather than retrying. There
is no refresh and no renewal - the remedy is to reload the page from the server,
which is the act that hands out a current token.

### The postMessage boundary is not free *(gpt, major)*

Revision 1 said the frame can only say which ids were selected, and treated that
as the boundary. A `message` listener receives events from **any** frame and any
origin unless it checks, so the boundary exists only if it is enforced:

- The parent MUST verify `event.source` is the artifact frame it created, and
  MUST ignore anything else.
- The parent MUST validate the message shape before acting - ids are strings
  from a known render, values match declared controls - and MUST NOT treat the
  frame's message as trusted input merely because it arrived on that channel.
- The frame is sandboxed without `allow-same-origin`, so its origin is opaque.
  An origin comparison is therefore not the check; identity of the source window
  is.

### Concurrent saves, and switching version *(muse, major)*

Two things can produce a version at once: the agent emitting, and a person
saving. The RFC's own rule that a new version never takes the screen while work
is pending covers the display side. The durable side needs its own answer:

- Versions are appended under the append lock, so two writers cannot interleave
  a version. Ordering is whatever the log says.
- A save MUST record the version it was working from. A save based on version 4
  that lands after the agent wrote version 5 is not an error and MUST NOT be
  rejected - it is a fact about version 4, and the agent can see both.
- lucid MUST NOT merge them. Merging two documents is not a thing lucid can do
  correctly, and the agent is better placed to reconcile than any rule here.

## Implementation Plan

Slice one, in order. Each step should be green on its own.

1. **The artifact log entry**, its metadata, and the offset index. No emission
   yet; a fixture writes one and a test reads it back by seek.
2. **Emission** - the preamble, the fence parser, an artifact version appended
   when an agent emits one.
3. **The server** - loopback, token, one command to start it. Serves a page
   that renders the transcript through assistant-ui.
4. **The instrumented iframe** - ids, hover, command-click multi-select,
   messages out. No annotation yet.
5. **Annotation** - compose against a selection, queue, send one batch, render
   it as annotations.
6. **Version viewing** - switch versions; marks paint on the version they were
   made on.

Slice two adds controls, change tracking and save. Slice three adds selectors,
the snapshot guard, drift and orphans.

Notes:

- The instrumented script and the agent's script share a frame. Neither may
  break the other.
- Every artifact version needs its hash from the first one written.
- `lucid2 chat` is unaffected and stays. Both surfaces fold the same log, so no
  synchronisation is built between them.

## Alternatives Considered

Each of these was weighed during charting and set aside; the ticket holding the
reasoning is linked.

**Artifact bytes beside the record, with the log holding a pointer**
([#61](https://github.com/dungle-scrubs/lucid-v2/issues/61)). Keeps folds small
and would sidestep the 1MB limit entirely. Set aside because the record stops
being one file and two things must be kept consistent. Retained as the escape
hatch if the size limit proves too tight - the entry shape makes it a change of
one field.

**The agent writes a file and lucid notices**
([#60](https://github.com/dungle-scrubs/lucid-v2/issues/60)). Rejected: the
write is unordered relative to the turn that produced it, it depends on an
agreed path both sides can reach, and it puts emission outside the event stream
everything else flows through.

**Growing the input frame a structured field**
([#67](https://github.com/dungle-scrubs/lucid-v2/issues/67)). Typed and
validated at the codec, which is more honest than JSON in a text field.
Rejected because it would be lucid's third encoding of "structured thing inside
a conversation", and because every reader predating the field must be audited on
both the codec and the fold paths - the asymmetry that produced #43.

**Shadow DOM instead of a sandboxed iframe.** Solves style bleed and gives the
parent direct access for selection. Rejected: agent-written script would run in
lucid's origin.

**Reaching into the frame from the parent**, using `allow-same-origin`. Simplest
way to implement hover and selection. Rejected: it lets the frame reach back
out, so the sandbox stops meaning anything.

**Patching the document in place on a new version**
([#69](https://github.com/dungle-scrubs/lucid-v2/issues/69)). Would avoid a
reload destroying a selection or an unsaved edit. Rejected because agent-written
HTML can change arbitrarily between versions and a bad patch corrupts silently;
not switching version under the person solves the same problem without the risk.

**Keeping v1's element fingerprint**
([#66](https://github.com/dungle-scrubs/lucid-v2/issues/66)). A hash of tag,
sibling index and text. Rejected as exact-or-nothing: it misses whenever the
agent rewords, which against a document the agent rewrites on purpose is the
common case rather than the edge.

## Open Questions

Both reviewers said Open Question 3 - the fence format - was wrongly deferred,
having already been passed from #60 to #61 without landing. It is decided in
Emission above and is no longer a question.

1. **Which channel carries conversation updates to the page** - server-sent
   events, a websocket, or polling.
   Criterion: whichever is simplest that survives the server restarting under a
   page. Settled by building.
   Decider: implementation.

2. **Whether a version change is pushed or polled**, and whether the
   announcement rides the conversation stream or its own channel.
   Decider: implementation.

3. **Is 1MB the right artifact limit?** *(new, from B2.)* It is what the
   existing bound gives, not a number chosen for artifacts. A document with an
   inlined photograph exceeds it immediately, and whether that matters depends
   on what artifacts turn out to be. Raising `TEXT_MAX` is the wrong lever - it
   guards the log and the reducer for everything. The right lever is the sidecar
   file in Alternatives Considered.
   Criterion: whether real artifacts hit it. Revisit after slice one rather than
   guessing now.
   Decider: this RFC's next review, informed by use.

4. **How does an agent learn what its artifact looks like now?** *(new.)* After
   a human saves, the current version is not what the agent wrote. It finds out
   through live delivery or the next fold - but nothing in this RFC says the
   agent is given the document rather than told it changed. For a todo list the
   difference is whether it must ask.
   Decider: this RFC's next review.

## References

### Normative

- Wayfinder map [#59](https://github.com/dungle-scrubs/lucid-v2/issues/59) and
  tickets #60-#69 - the decisions this renders, each with its reasoning.
- `CONTEXT.md` - what lucid is and what the words mean.
- `docs/rfc/04_live-delivery-a-running-host-follows-its-own-log.rfc.md` - the
  executor lease and live delivery, which the server depends on and does not
  change.
- `docs/rfc/05_one-window-the-conversation-you-can-talk-back-to.rfc.md` - the
  terminal window this leaves in place.
- [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/) - the
  selector vocabulary.
- `~/dev/lucid/src/anchors/` - v1's resolution discipline, kept.

### Informative

- [assistant-ui ExternalStoreRuntime](https://www.assistant-ui.com/docs/runtimes/custom/external-store)
- [Hypothesis fuzzy anchoring](https://web.hypothes.is/blog/fuzzy-anchoring/) and
  [dom-anchor-text-quote](https://github.com/tilgovi/dom-anchor-text-quote)
- hcn `src/interpretation/question.ts` - the preamble-and-fence mechanism this
  copies.

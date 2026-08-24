---
number: 06
title: "An artifact you can address"
type: feature
status: Draft
author: Kevin Frilot
date: 2026-08-24
---

# RFC-06: An artifact you can address

> Renders the decisions of wayfinder map
> [#59](https://github.com/dungle-scrubs/lucid-v2/issues/59) into one document.
> Ten questions were resolved as tickets #60 through #69; each decision below
> links the ticket that holds its reasoning. **Nothing here is new.** Where a
> reader wants to know *why*, the ticket answers; this document says *what*.

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
composes the text handed to `session.send` and receives `message` events.

lucid MUST NOT require an hcn change for this. hcn normalizes what harnesses
**differ** about; its question protocol exists because asking differs per
harness. No harness has a native artifact concept, so there is nothing to
normalize, and ADR 0007 places it on the caller.

The preamble MUST be composed once at session start, not per send, so an agent
is never handed a structure it was not taught to read.

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

A save produces a new artifact version whose author is the human. The save is
the commit point, which is what stops every keystroke being a version.

**A save MUST NOT start a turn.** It appends a version and stops; the agent
finds it through live delivery or the next fold. An annotation is a request and
becomes an input; a save is a statement of fact, and facts wait to be read.

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

An annotation batch and a save are encoded **in the input text**, taught by a
preamble, exactly as the artifact block is. No frame gains a field and no
protocol version changes.

A batch of marks is **one input**, not one per mark: one idempotent id, one
disposition, one turn, one charge against `INPUT_QUEUE_MAX`.

The projection MUST render an annotation batch as annotations, never as raw
encoded text. The log keeps the raw text; the view shows what happened. The
same split already applies to hcn's question block.

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

The artifact itself is untrusted content: agent-written HTML and script, isolated
by the sandbox, never executed in lucid's origin.

## Implementation Notes

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

## Open Questions

1. **Which channel carries conversation updates to the page** - server-sent
   events, a websocket, or polling. Settled better by building than deciding.
   Decider: implementation.
2. **Whether a version change is pushed or polled**, and whether the
   announcement rides the conversation stream or its own channel.
   Decider: implementation.
3. **What the artifact fence carries besides the document** - whether one block
   can hold metadata the renderer needs, and how a version declares its
   predecessor. Deferred from #60 as a format question rather than a mechanism
   one. Decider: this RFC's review.

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

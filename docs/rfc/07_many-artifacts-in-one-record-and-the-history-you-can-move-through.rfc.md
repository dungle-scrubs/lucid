---
number: 07
title: "Many artifacts in one record, and the history you can move through"
type: feature
status: Draft
author: Kevin Frilot
date: 2026-08-26
---

# RFC-07: Many artifacts in one record, and the history you can move through

## Abstract

A record can already hold many artifacts, and the browser shows one of them.
The rest are unreachable from the page although the agent can still revise
them. Version history has the opposite problem: every version is reachable,
through an unbounded row of buttons, and an old version can be edited and
annotated as though it were current. This RFC makes every artifact in a
record reachable and up to two visible at once, and makes version history
navigable, comparable, and restorable, with everything but the current
version read-only. It adds two capabilities the append-only log cannot
express today - renaming an artifact and retiring one - without making
`artifactId` mutable.

## Introduction

### Problem statement

Six defects, all present in the delivered RFC-06 surface.

1. **Only one artifact is reachable.** `viewArtifactCatalog` returns every
   artifact in the record; the client takes `artifacts[artifacts.length - 1]`
   and renders that. A second artifact hides the first. The first is still in
   the log and the agent can still revise it, so the page and the agent
   disagree about what exists.
2. **The version list does not scale.** Two versions or more renders one
   button per version into the document header, uncapped. At a hundred
   versions it is a hundred buttons.
3. **An old version is editable.** Viewing an older version does not disable
   editing or saving. A save from one appends a new version with `basedOn`
   set to the old one, and the page reports that the agent has since written
   a newer version. Nothing forbids it.
4. **An old version is annotatable.** Notes are held per `artifactId@version`
   and a batch names the version it was made against, so a note can be
   written against a version that is no longer current.
5. **There is no way to compare two versions**, and no way to go back to one.
6. **Queued notes are unbounded**, and a queue goes as a single input.

### Scope

In scope:

- Reaching every artifact in a record, and showing up to two at once.
- The version picker, and what a version that is not current permits.
- Comparing two versions of one artifact.
- Restoring an older version as the current one.
- A bound on the note queue.
- Renaming and retiring an artifact.

Explicitly out of scope:

- **A declared relationship between artifacts.** They remain siblings in a
  record. No field in the artifact header points at another artifact, and the
  page MUST NOT present them as related beyond sharing a conversation.
- **Cross-artifact notes.** An annotation batch remains one `artifactId` and
  one `version`. Selecting in two artifact panes and writing one note about
  both is not specified here.
- **More than two artifacts visible at once.**
- **Rendering an artifact in the terminal.** Unchanged from RFC-06.
- **Visual treatment.** `CONTEXT.md` records that the browser surface is a
  prototype and a design pass is expected. This RFC does specify affordances:
  that the version picker is a dropdown rather than a row of buttons (R5),
  that a comparison is two columns or one (R9), that panes are separated by
  draggable grips (R4). Those are choices about what a control is and what it
  does, and the RFC has to make them because the behaviour depends on them -
  "read-only while viewing an older version" is meaningless without knowing
  how a version is chosen. What is out of scope is everything downstream of
  that: colour, type, spacing, iconography, motion, and where in the header a
  control sits. A design pass MAY replace any visual treatment here and MUST
  NOT be read as bound by one.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD
NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted
as described in RFC 2119.

Terms defined in `CONTEXT.md` carry their meaning from there and are not
redefined. This RFC uses: record, artifact, version, save, annotation batch,
note, spot, document mode, browser surface. It does not use `orphan` or
`note box`, and nothing here changes them.

New terms:

| Term | What it is |
|---|---|
| **current version** | The highest version of an artifact in the record. The only one that accepts a save or a note |
| **title** | A display name for an artifact. Mutable, and not its identity |
| **retired** | An artifact marked as no longer wanted. Its versions stay in the log; the browser stops offering it |
| **artifact pane** | One document on screen. At most two exist at a time |
| **conversation pane** | The thread, to the right of the artifact panes. Exactly one |
| **grip** | The draggable divider between two panes |
| **restore** | Making an older version current by appending a copy of it as a new version |

## Motivation

RFC-06 delivered one artifact addressed and marked up, which was the unit of
work it set out to prove. Using it produced the six defects above, and five
of the six are only visible once a conversation runs long enough to
accumulate versions or ask for a second document. They are not design
problems and do not wait on the design pass: three of them are decisions
about what the product permits, and two of them cannot be expressed at all
without a change to what the log carries.

Doing this before the design pass also settles what the document header has
to hold. A version picker cannot be designed until it is known whether the
header also carries an artifact identity beside it.

## Design

### R1 - The URL names the artifact, and MAY name the version

The route is `/c/:conversationId` and the client parses exactly that. An
artifact is never in the URL, so nothing about an artifact is linkable.

- The server MUST serve the page at `/c/:conversationId`,
  `/c/:conversationId/:artifactId`, and
  `/c/:conversationId/:artifactId/:version`.
- `artifactId` in a URL MUST be percent-encoded when written and decoded when
  read. It MUST NOT be validated against `validConversationId`.

  The two identity domains differ, and narrowing one to the other would hide
  records that already exist. `isArtifactField` accepts any non-empty string
  of at most 128 units with no control characters, so `plan/日本語` is a
  valid `artifactId` that the fold indexes today; `validConversationId`
  accepts a restricted path-safe ASCII alphabet and rejects it. Requiring the
  narrower rule would make an artifact the record holds unreachable, which is
  the defect this RFC exists to fix.

- A decoded `artifactId` MUST be checked as an artifact field, on the terms
  the store itself applies, and a value failing that check MUST be answered
  with `E-ART-01` rather than looked up.
- Path safety MUST come from never joining `artifactId` into a filesystem
  path, not from restricting what an `artifactId` may contain. See Security.
- With no `artifactId`, the page MUST show the artifact with the most recent
  version entry in the record. This preserves today's behaviour for a record
  holding one artifact.
- With a `version`, the page MUST open showing that version.
- Changing which artifact or version is shown SHOULD update the URL without
  a navigation, so the address bar always names what is on screen.
- A URL naming an artifact the record does not hold MUST render the page with
  a message saying so, not a blank frame or an error page.

### R2 - Every artifact in the record is listed

- The page MUST list every artifact in the record that is not retired. A
  retired artifact MUST NOT appear in that list. Revealing retired artifacts
  (R12) MUST show them somewhere separate from it, marked retired, and MUST
  NOT mix them back into the list of artifacts in use.
- The list MUST be labelled in terms of the conversation - "also in this
  conversation" or equivalent - and MUST NOT imply a relationship between
  the artifacts. They are siblings.
- Selecting one MUST load it into an artifact pane.
- The list MUST offer opening one in a new tab, which is a link to the URL
  from R1.
- Each entry MUST show its title, and MUST show its current version.

### R3 - Two artifact panes at most

- The page MUST support one or two artifact panes.
- Both panes share one conversation pane and one record. There is one
  conversation, whichever artifact a note or a save came from.
- A pane MUST have a way to be closed, leaving one pane.
- **Opening a second pane is a distinct act from choosing an artifact.**
  Choosing one from the list (R2) replaces the content of the active pane.
  Opening beside is a separate action on a list entry, and it MUST be offered
  only while one pane is open.
- Opening a third artifact when two panes are open MUST replace the content
  of the pane that is **not** active, and the page MUST make clear which pane
  changed. The active pane is the one holding the selection, or with no
  selection the one interacted with most recently.
- **One pane is active at a time, and the URL names it.** R1 gives the
  address bar room for one artifact and one version, so with two panes open
  the URL names the active pane. Opening a link therefore restores one pane,
  not two. Which panes were open is a property of this window, not of the
  address, and MUST NOT be encoded in the URL.
- Each artifact pane MUST carry its own version picker and its own save
  state. A note queue is keyed by `artifactId` **and** `version`, not by
  pane, and R10 governs it.
- **Document mode is shared.** One mode governs both artifact panes. Alt
  Backspace toggles it for both, and therefore does not have to name a pane
  or depend on which pane has focus.
- A selection is still per artifact, because an annotation batch names one
  `artifactId` and one `version`. Selecting in one pane MUST clear the
  selection in the other. Mark-up mode being on in both panes does not make a
  note that spans them.

### R4 - How the grips resize

Two grips exist when two artifact panes are open: one between the artifact
panes, and one between the artifact panes and the conversation pane.

- Dragging the grip **between the artifact panes and the conversation pane**
  MUST resize the conversation pane by the full drag distance, and MUST
  absorb the change **evenly across both artifact panes**. Each artifact pane
  therefore changes by half the drag distance, which is why the artifact
  panes appear to move more slowly than the pointer.
- Dragging the grip **between the two artifact panes** MUST resize both
  artifact panes, one growing as the other shrinks, and MUST NOT change the
  width of the conversation pane.
**With one artifact pane** only the conversation grip exists. It MUST resize
the conversation pane by the full drag distance, and the single artifact pane
MUST absorb all of it. "Evenly across both" is a rule about two panes; with
one there is nothing to divide.

**Minimums.** A drag MUST stop at a minimum rather than reduce a pane to
nothing.

- The conversation pane MUST keep at least `CONVERSATION_MIN`, which is 280
  CSS pixels today (`src/server/client/layout.ts`).
- Each artifact pane MUST keep at least `DOCUMENT_MIN`, which is 320 CSS
  pixels today, and which currently guards the single document pane.
- When the viewport is too narrow to give every open pane its minimum, the
  page MUST reduce the number of artifact panes to one rather than render
  panes below their minimum.

**What persists.** Two values, not three, because three widths carry an
invariant that a viewport change breaks:

- the conversation pane width, in CSS pixels, as today; and
- the split between the two artifact panes, as a **ratio** rather than two
  widths.

A ratio needs no *stored* reconciliation when the viewport changes: it stays
what it was, and only the widths derived from it move. It still has to be
clamped when it is applied, because the legal interval depends on the room
available. With `A` the width left for the artifact panes, a ratio `r`
satisfies both minimums only where

```
DOCUMENT_MIN / A  <=  r  <=  1 - DOCUMENT_MIN / A
```

At `A = 720` that is `0.44 <= r <= 0.56`; at `A = 1600` it is
`0.2 <= r <= 0.8`. A stored `r` outside the interval MUST be clamped into it
for display and MUST NOT be overwritten in storage, so widening the window
restores the split the person chose.

**Applying the two values has one order**, and every implementation MUST use
it, or two of them will clamp different things from the same storage:

1. Clamp the conversation width to `CONVERSATION_MIN` and to what leaves the
   open artifact panes their minimums. With two panes that upper bound is
   `W - 2 * DOCUMENT_MIN - grips`, which is stricter than
   `clampConversationWidth` today, because today only one document exists.
2. Take `A` as what is left.
3. Clamp the ratio into the interval above and derive the two widths.

**When the viewport cannot hold both artifact minimums**, the page drops to
one pane. The pane that survives MUST be the one holding the selection, or
with no selection the one interacted with most recently. The other pane's
artifact is not closed or forgotten: it stays in the artifact list, and its
queued notes belong to the artifact and version rather than the pane (R7), so
reopening it when the room returns finds them. The page MUST NOT reopen the
second pane on its own; a person asks for two panes and a resize is not that
request.

Both values MUST survive a reload, and MUST be treated as absent when storage
refuses to answer, the way the conversation width already is.

### R5 - The version picker is a dropdown

- With one version, the picker MUST be a plain badge with nothing to open.
- With more than one, the picker MUST be a dropdown listing every version,
  **newest first**, with the current version marked as current.
- Each entry MUST say whether that version was written by the agent or saved
  by a person.
- Choosing a version MUST show it and MUST update the URL per R1.
- While a version other than the current one is shown, the page MUST offer a
  way back to the current version.

### R6 - A version that is not current is read-only

- The page MUST NOT allow editing or saving while a version other than the
  current one is shown. Controls that would edit MUST be inert, and the save
  action MUST be unavailable rather than failing after the fact.
- The page MUST say why, naming the version being viewed.
- The save endpoint MUST continue to accept a request whose `basedOn` is not
  the current version, and MUST continue to report `supersededSince`.

**What that tolerance costs, stated rather than implied.** The rule in this
requirement is enforced by the page and by nothing else. A request from
`curl`, from a tab left open on an older build, or from a future agent-facing
tool can still append a save whose `basedOn` is stale, and the record will
accept it. R6 is therefore a rule about what lucid offers, not an invariant
of the record.

That is deliberate, on two grounds. The record already tolerates this and
records what a save was working from, because the agent reconciles and lucid
does not merge; making the record refuse would be a new policy in the layer
that has least context to judge it. And the party this rule protects against
is a person who did not notice which version they were looking at, not an
attacker - a single-user loopback tool has no third party to defend against
here.

The consequence for reversibility runs one way. Relaxing R6 later, to allow
editing an older version again, needs no change to the record. Tightening it
later, to make the record refuse, is a change that would break any client
already relying on acceptance. The cheap direction is the one left open.

### R7 - A version that is not current cannot be annotated

- The page MUST NOT allow selecting or writing a note while a version other
  than the current one is shown.
- Document mode MUST be unavailable, or MUST behave as read-only, while an
  older version is shown.
- Notes already queued against the current version MUST survive looking at an
  older version and coming back. They are queued per `artifactId@version`
  already.
- The annotation batch MUST continue to carry the `version` it was made
  against, for the same reason R6 keeps `basedOn`.

### R8 - Restore makes an older version current

Restore is a person's act on the record. lucid appends; it does not edit a
document and it does not ask the agent to.

- The page MUST offer restoring the version being viewed when that version is
  not the current one.
- Restore MUST append a new version whose bytes are a copy of the restored
  version, with `author` set to `human` and `basedOn` set to the restored
  version number.
- Restore MUST require a confirmation before it appends.
- Restore MUST NOT remove, rewrite, or hide any version. The version it
  replaced remains in the list and remains reachable.
- Undoing a restore is restoring the other version, which is the same act
  again. The page SHOULD say so at the point of confirmation, because a
  person deciding whether to restore is deciding whether it is reversible.
- After a restore the page MUST follow the new current version.
- The agent learns of a restore the same way it learns of any save, through
  the `[lucid artifact state]` block on the next input. No turn is started.

### R9 - Versions can be compared

- The page MUST offer comparing the version being viewed against another
  version of the same artifact.
- The comparison MUST be computed from the two versions' bytes as stored. It
  MUST NOT be computed from the rendered frame, which carries lucid's
  instrumentation.
- The comparison MUST NOT be sent to the agent and MUST NOT append to the
  record. It is a view.
- A comparison MUST NOT offer editing either version. R6 governs.

- The comparison MUST be presented **side-by-side** - the two versions in two
  columns - when there is enough horizontal room for both to be read.
- Below that width the comparison MUST be presented **inline**: one column,
  with the changed regions marked in the order they occur.
- Which of the two is shown MUST follow the room available, not a stored
  preference. The same comparison is being shown either way.
- The threshold MUST be expressed as the width at which a column becomes too
  narrow to read, not as a device class. Concretely: side-by-side MUST be used
  only where each column would be at least **360 CSS pixels** wide. Below
  that, inline.

  360 is a policy number. It is `DOCUMENT_MIN` plus 40, and the 40 is chosen
  rather than measured: a comparison column carries change marks in its
  gutter that a document pane does not, and 40 is room for them. An
  implementation MAY measure its own gutter and choose a different number;
  what it MUST NOT do is switch on a device class. The width measured is the
  column's own content box, so what an implementation puts inside a column
  does not change where it switches.
- The comparison MUST be a **line-oriented text difference over the stored
  bytes**. It MUST NOT parse either version into a DOM and compare trees. The
  bytes are what the record holds and what the agent reads; a tree comparison
  would need a parse that can fail, and would hide a change that alters the
  bytes without altering the tree.
- A version the catalog names MUST be readable. An oversized version is
  carried in the log and **not added to `artifactIndex`**, and both the
  catalog and the per-version read derive from that index, so such a version
  is invisible to both. There is no state in which the catalog offers a
  version that cannot be read.
- The catalog MUST NOT be extended to report `artifactRefusals`. Doing so
  would let an unreadable version be the highest one, and "current version"
  is defined as the highest - which would make the current version
  unreadable, a state R6, R8 and the state machine have no answer for. A
  refused version is not a version of the document; it is a rejected append.
- A comparison MUST therefore fail only for reasons that apply to any read:
  the record became unreadable, or the version was named by a stale URL and
  has since gone. `E-ART-08` covers that.

### R10 - The note queue is bounded

- A queue MUST hold at most **20** notes.
- Adding a note to a full queue MUST be refused, MUST say why, and MUST leave
  the queued notes untouched.
**A queue belongs to an `artifactId` and a `version`, not to a pane.** That
is what the client does today (`notesByVersion`, keyed
`${artifactId}@${version}`), and R7 depends on it: notes queued against the
current version survive looking at an older version and coming back. A pane
shows one queue at a time, the one for the artifact and version it is
showing.

- The bound is per queue. Every artifact and version pair may hold at most 20
  notes.
- **The number of queues is not bounded by the number of panes.** Moving
  between versions creates a queue per version visited, each bounded at 20,
  and every one of them survives. A person can therefore hold well over 40
  unsent notes across a record, and R10 does not stop that.

  This is a deliberate limit on the requirement, not an oversight. The defect
  R10 fixes is one queue growing without end, which is what makes a single
  input unbounded. How many bounded queues a person accumulates is a
  different question, and the RFC does not answer it. Any later answer has to
  reckon with R7: a queue cannot simply be discarded on leaving a version,
  because keeping it is the point.

- One queue goes as one input, carrying one `artifactId` and one `version`,
  unchanged from RFC-06.
- **`INPUT_QUEUE_MAX` does not bound queues.** It bounds inputs in flight:
  eight, counted from an `applied` disposition and released on the turn
  ending. An unsent queue counts zero however full it is, and a sent batch
  counts one however many notes it carries, and only once it has been
  applied. Sending two queues is two inputs against that bound, not forty.
- **Command-Enter sends one queue: the one belonging to the artifact pane
  that holds the selection or, with no selection, the pane last interacted
  with.** The page MUST make clear which queue is about to go. A key that
  sends one of two queues without saying which is worse than a key that does
  nothing.
- Sending one queue MUST NOT send or clear the other, and MUST NOT be blocked
  by the other being non-empty.
- The two inputs are ordered by when they were sent, like any other inputs.
  Nothing here orders them relative to each other beyond that, and nothing
  merges them.

### R11 - Rename changes a title, never an identity

`artifactId` is identity in two places: `replaces` names it when the agent
revises, and every annotation batch carries it. Changing it would break the
link between existing notes and the artifact they point at, and between an
agent's next revision and the thing it means to revise.

- `artifactId` MUST be immutable for the life of a record.
- An artifact MAY carry a **title**, which is what the page displays.
- With no title, the page MUST display the `artifactId`.
- Renaming MUST write a title and MUST NOT touch any version entry.
- A title MUST be treated as text everywhere it is displayed. See Security.

### R12 - Retire is a tombstone

The log is append-only and never rewritten, so nothing can be deleted from
it. Retiring an artifact records an intention; it does not remove bytes.

- Retiring MUST append an entry marking the artifact retired. Every version
  stays in the log.
- A retired artifact MUST NOT appear in the list from R2 and MUST NOT be
  offered for opening.
- A URL naming a retired artifact MUST say it was retired rather than
  behaving as though it never existed.
- Retiring MUST require a confirmation.
- Retiring MUST be reversible by appending an entry that un-retires it,
  because nothing was destroyed.
- The page for a retired artifact MUST offer un-retiring it. A person who can
  reach the URL can bring it back, which is what makes E-ART-02 a recovery
  path rather than a dead end.
- The artifact list SHOULD say how many artifacts are retired and offer
  revealing them, separately from the list itself per R2. Without it,
  reaching a retired artifact depends on browser history or on the agent
  naming it, which is thin.
- Both routes to un-retiring - the revealed list and the retired artifact's
  own page - MUST reach the same act. Neither has priority over the other,
  and neither may be the only one: the page from R1 is the route that works
  from a link, and the revealed list is the route that works when there is
  no link to hand.
- Un-retiring MUST NOT require a confirmation. It restores access to
  something already in the record and destroys nothing.

**A retired artifact stays in the `[lucid artifact state]` block**, marked
retired. The agent is told it exists and that it is retired. An agent
revising an artifact nobody told it was retired is a worse failure than a
longer state block, and it would be refused for a reason the agent could not
see. This also means the agent can name an artifact the list does not show,
which is the second reason un-retiring has a control.

### Data model

Titles and retirement are facts about an artifact, not about a version, so
they do not belong on a version entry. Writing them as a version would make
renaming an artifact create a version of it.

A new entry source is added. `ENTRY_SOURCES` is a closed list in
`src/store/log.ts`, and the fold carries an entry whose `src` it does not
recognise rather than dropping it (RFC-04 P1). An older reader that has P1
therefore tolerates this entry, and no version bump is needed.

**This is not the mechanism that let `basedOn` and `values` be added, and the
two MUST NOT be reasoned about together.** They pass different gates:

| | What it is | What tolerates it | What a reader without it does |
|---|---|---|---|
| `basedOn`, `values` | An additive **field** on a `src` the reader already knows | `coerceArtifactEntry` reads the fields it names and ignores the rest | Ignores the field. Always safe |
| `artifact-meta` | An additive **source**, a new value of `src` | The `knownEntry` branch of the fold, added by RFC-04 P1 | Throws `corrupt-log`. Safe only after P1 |

The consequence is a deploy ordering that the field case never had: a reader
built before P1 fails on a record containing an `artifact-meta` entry. P1 is
Implemented, so this is a statement about old binaries rather than a
migration step, but a reader who takes the two cases as equivalent will get
that wrong.

```json
{
  "v": 1,
  "at": 1787656695574,
  "src": "artifact-meta",
  "artifactId": "onboarding-checklist",
  "title": "First day checklist",
  "retired": false
}
```

- `artifactId` MUST be present and MUST be a valid artifact field on the same
  terms as an artifact entry's.
- The **endpoint** MUST refuse a request naming an artifact the record does
  not hold, with `E-ART-01`, and MUST NOT append. This is where "must match
  an artifact the record holds" is enforced, because it is the only place
  that can answer a caller.
- The **fold** MUST tolerate such an entry anyway and ignore it. The two are
  not in tension: the endpoint refuses what it can see, and the fold stays
  total over records it did not write - a hand-edited log, or one written by
  a build whose endpoint had a defect, must still open.
- `title` is OPTIONAL. When present it MUST be a non-empty string of at most
  **200 UTF-16 code units** containing no control characters. A title outside
  that MUST be refused at the endpoint and MUST NOT be appended.

  200 is a policy number, not one derived from anything. It is chosen to be
  clearly larger than the 128 that `isArtifactField` allows an `artifactId`,
  because a title is prose and an id is a key, and small enough that no title
  is a document. The unit is UTF-16 code units because that is what
  `String.prototype.length` counts and what the existing 128 bound counts, so
  one rule holds at the endpoint and in the fold with no conversion.
- A title longer than the space available MUST be truncated **for display
  only**. Display truncation is not a second bound: the stored title is
  whatever was accepted, and the 200-character rule is the only limit on
  what a record may hold.
- `retired` is OPTIONAL and MUST be a boolean when present.
- The fold MUST apply these entries in log order, last write winning per
  field. An entry naming an artifact with no version entries MUST be
  ignored rather than creating one.
- An `artifact-meta` entry MUST NOT be reduced into `ChannelState` or the
  transcript, for the same reason an artifact entry is not: it is not
  something anyone said.

**A malformed `artifact-meta` entry MUST NOT make a record fail to open.**
Unlike an artifact entry, whose malformed fields are `corrupt-log` because
the bytes and their hash are the document, a meta entry carries an opinion
about a document. Losing an opinion is recoverable by writing it again;
losing the record is not. The fold therefore applies **each field on its own
merits and ignores what it cannot use**:

- `title` present and not a valid title: ignored. Any earlier title stands.
- `retired` present and not a boolean: ignored. Any earlier value stands.
- Neither field present: the entry is a no-op, not an error.
- `artifactId` missing or not an artifact field: the whole entry is ignored,
  because nothing identifies what it is about.

This is deliberately more forgiving than the endpoint, which refuses all four
cases. The endpoint answers a caller and can say no; the fold reads records
it did not write, including hand-edited ones and ones written by a build with
a defect, and its job is to stay total. `E-ART-06` and `E-ART-07` are the
endpoint's refusals, and neither has a fold counterpart by design.

### Endpoints

| Method | Path | Status | What it does |
|---|---|---|---|
| GET | `/api/conversations/:id/artifacts` | **changed** | Already returns every artifact. MUST also return each artifact's title and retired flag |
| GET | `/api/conversations/:id/artifacts/:artifactId/:version` | unchanged | Reads one version |
| POST | `/api/conversations/:id/artifacts/:artifactId/save` | unchanged | Appends a save, including its tolerance of a stale `basedOn` per R6 |
| POST | `/api/conversations/:id/artifacts/:artifactId/restore` | **new** | Appends the copy described in R8. Body names the version being restored |
| POST | `/api/conversations/:id/artifacts/:artifactId/meta` | **new** | Appends an `artifact-meta` entry. Body carries `title`, `retired`, or both. Refuses `E-ART-01` for an artifact the record does not hold, and `E-ART-07` for a title outside the bound |

**Two routes are new** - restore and meta. `src/server/server.ts` today has
only the catalog, the per-version read, and the save. A reader comparing this
table against the current source will find those two absent rather than
different, which is what an RFC for unbuilt work looks like.

**One route changes, additively.** The catalog keeps `artifactId`,
`versions`, `latest` and `authors` exactly as they are, and gains `title` and
`retired`. A client built before this RFC keeps working and never sees the
new fields. A client built after it MUST tolerate their absence, because a
server can be older than the client is.

## State Machine

### One artifact pane, with respect to the version it shows

A pane is opened into one of two states, not always into `LIVE`.

```
(open)          -> LIVE          (on: the artifact resolves)
(open)          -> UNAVAILABLE   (on: the artifact is unknown, invalid, or retired)

LIVE            -> VIEWING_OLD   (on: pick a version other than current)
LIVE            -> COMPARING     (on: compare, guard: more than one version)
LIVE            -> UNAVAILABLE   (on: the artifact is retired elsewhere)

VIEWING_OLD     -> LIVE          (on: pick current, or "back to current")
VIEWING_OLD     -> LIVE          (on: restore confirmed; the pane follows the new current version)
VIEWING_OLD     -> COMPARING     (on: compare)
VIEWING_OLD     -> UNAVAILABLE   (on: the artifact is retired elsewhere)

COMPARING       -> VIEWING_OLD   (on: leave, when a version other than current was being viewed)
COMPARING       -> LIVE          (on: leave, when the current version was being viewed)
COMPARING       -> UNAVAILABLE   (on: the artifact is retired elsewhere)

UNAVAILABLE     -> LIVE          (on: un-retired, for a retired artifact)
UNAVAILABLE     -> LIVE          (on: choose another artifact that resolves)
UNAVAILABLE     -> UNAVAILABLE   (on: choose another artifact that does not)
```

- **An unknown artifact has no way out except choosing another one.** It
  cannot be un-retired, because the meta endpoint refuses an artifact the
  record does not hold (`E-ART-01`). The pane says so, and offers the artifact
  list.
- **Retirement can arrive from elsewhere** - another tab, another process -
  while a pane is in any state. Every state therefore has an edge to
  `UNAVAILABLE`. A pane holding unsent notes MUST keep them, per R7; they
  belong to the artifact and version, not to the pane.
- **Choosing another artifact replaces a pane's content, it does not close
  the pane.** This is R2: selecting an artifact loads it into a pane.
- **Un-retiring needs no confirmation** (R12), so the edge out of
  `UNAVAILABLE` carries none.

- In `LIVE`, editing, saving, selecting and annotating are all permitted.
- In `VIEWING_OLD`, `COMPARING` and `UNAVAILABLE`, none of them are. This is
  R6 and R7.
- `COMPARING` has no restore path out of it. Restore is reached by leaving the
  comparison first, which lands in `VIEWING_OLD`, and restoring from there.
  This is two acts by design: a comparison is a reading view, and the RFC does
  not put a write behind it.
- `LIVE -> COMPARING` is guarded on there being more than one version. With
  one version there is nothing to compare and the affordance MUST NOT be
  offered.
- A new version arriving from the agent MUST NOT move a pane out of
  `VIEWING_OLD` or `COMPARING`. RFC-06 already says a newer version is
  announced rather than swapped in, and that holds here.
- `UNAVAILABLE` is the state behind `E-ART-01` and `E-ART-02`. A pane in it
  renders a message and the way out, not a document.

### Two artifact panes

Each pane holds its own state from the machine above, independently. Two
panes therefore have any combination of the states above, and this is
deliberate: comparing one artifact while reading another is the case that
motivated two panes.

What is **not** per pane:

- **Document mode is shared** (R3). One mode governs both panes.
- **The selection is single** (R3). At most one pane holds a selection.
  Selecting in one pane clears the other's selection.

The two interact in one place worth naming. Mark-up mode is shared, but a
pane in `VIEWING_OLD`, `COMPARING` or `UNAVAILABLE` does not permit selection
(R7). So mark-up mode may be on while one of the two panes cannot be marked
up. That pane MUST say why rather than appearing inert for no stated reason.

## Error Handling

```
E-ART-01  unknown-artifact            (severity: info)
          A URL or request names an artifactId the record does not hold.
          Recovery: the page says so and offers the list from R2.
          Escalation: none.

E-ART-02  artifact-retired            (severity: info)
          A URL names a retired artifact.
          Recovery: the page says it was retired, and does not render it.
          Escalation: none.

E-ART-03  not-current-version         (severity: info at the endpoint,
                                       warning in the page)
          A save arrives whose `basedOn` is not the current version.
          At the endpoint this is not an error: it is accepted, appended,
          and answered with `supersededSince: true`, unchanged from RFC-06.
          The endpoint has no way to know whether the caller is this
          page, curl, or an older build, and R6 does not make it guess.
          Recovery: none needed. The save is in the record.
          In the page it is a defect in the page: R6 should have made it
          unreachable. The page MUST say the version moved and MUST show
          the version that was written.
          Escalation: none.

E-ART-04  queue-full                  (severity: info)
          A note is added to a queue already holding 20.
          Recovery: refuse the addition, keep the queue, say why.
          Escalation: none.

E-ART-05  restore-of-current          (severity: info)
          Restore is requested for the version that is already current.
          R8 offers restore only from VIEWING_OLD, so the page cannot
          reach this; it arises when the version became current between
          the page reading it and the request landing, or from a caller
          that is not the page.
          Recovery: refuse. It would append a duplicate version that
          records nothing.
          Escalation: none.

E-ART-08  version-unreadable          (severity: warning)
          A version read fails although the catalog named it. Not
          reachable through an oversized version: those are absent from
          `artifactIndex`, which is what the catalog is derived from, so
          the catalog never offers one. It is reachable through a stale
          URL or a catalog read that raced a record becoming unreadable.
          Recovery: the page says that version cannot be shown. A
          comparison MUST report it for the side that failed rather than
          rendering that side empty, which would read as "nothing
          changed".
          Escalation: none.

E-ART-06  meta-for-unknown-artifact   (severity: warning)
          An `artifact-meta` entry names an artifact with no version
          entries.
          Recovery: the fold ignores it. It MUST NOT create an artifact.
          Escalation: none - a record that folds is not corrupt.

E-ART-07  title-too-large             (severity: info)
          A title exceeds the bound.
          Recovery: refuse the write. Nothing is appended.
          Escalation: none.
```

Every one of these is refused before an append, except `E-ART-03`, which is
accepted by design and reported, and `E-ART-08`, which is a read failure with
nothing to append.

Each error names the state it can be observed in. `E-ART-01` and `E-ART-02`
put a pane in `UNAVAILABLE`. `E-ART-08` is observable from `VIEWING_OLD` and
from `COMPARING`. `E-ART-04` arises in `LIVE`, the only state that permits
adding a note, and leaves the pane there. `E-ART-03`, `E-ART-05`, `E-ART-06`
and `E-ART-07` are answers to a request and do not change a pane's state.

## Security Considerations

**Trust boundaries.** Unchanged in shape from RFC-06: the artifact frame is
sandboxed without `allow-same-origin` and the page cannot reach into it. The
server is loopback-only and every request carries the per-conversation
token. This RFC adds no network surface and no new reader.

**A title is agent-authored text in lucid's own chrome.** This is the one new
exposure and it matters more than its size suggests. Artifact bytes are
dangerous but contained - they render inside a sandboxed frame that can
reach nothing. A title renders in the page itself, outside that frame,
beside the controls. Therefore:

- A title MUST be rendered as text. It MUST NOT be interpreted as HTML or
  markup anywhere.
- A title MUST be length-bounded when written, and MUST be truncated for
  display rather than allowed to push other controls off screen.
- A title MUST NOT be used to build a URL, a selector, or a filesystem path.
  `artifactId` remains the only identity, and it is already validated.

**`artifactId` in the URL.** No path today joins an `artifactId` into the
filesystem: `artifactId` reaches the server as a body field or a path segment
on the version and save routes and is used as an index key, not as a path
component. This requirement is therefore a constraint on the code R1 asks for,
not a description of a risk that exists now.

R1 puts a value from the address bar into a request. It MUST NOT be joined
into a filesystem path at all. A record's directory is chosen by
`conversationId`, which is validated today; an artifact inside it is found by
index lookup on a string. Keeping that shape is what makes traversal
unreachable rather than merely guarded.

`artifactId` MUST NOT be narrowed to `validConversationId`'s alphabet to
achieve this. That would trade the defect this RFC is fixing - artifacts the
page cannot reach - for a guard the index-lookup shape already makes
unnecessary. It is checked as an artifact field, which is what the store
requires of it, and percent-encoded in any URL.

**Blast radius.** Nothing here can destroy a version: retire is a tombstone,
restore is an append, rename touches no version entry. The worst case is a
retired artifact that should not have been retired, which is reversed by
appending. A malicious or confused agent can already emit artifacts; this
RFC lets it also propose titles, which is a display concern bounded by the
rules above.

**Prompt injection.** A title travels to the agent in the
`[lucid artifact state]` block, where a crafted title could try to read as
instructions. This is not new - `artifactId` already travels there and
annotation snippets carry the person's own text - but a title is longer and
more free-form than an id. The state block SHOULD keep titles clearly
delimited as data.

**Data sensitivity.** No credentials, no PII handling, no change to the
per-conversation secret or to how the token is minted.

## Alternatives Considered

**Rename by changing `artifactId`.** The obvious reading of "rename". It
was rejected because `artifactId` is identity: `replaces` names it and every
annotation batch carries it. Renaming would orphan every existing note on
that artifact and break the agent's next revision. A mutable title costs one
optional field and has none of that.

**Delete by rewriting the log.** Rejected outright. The log is append-only
and its integrity depends on that. There is no version of this that is not a
new storage model.

**Retire as an additive field on a new artifact version.** Rejected because
it would make retiring, and renaming, create a version of the document. A
version is a state of the document, not a state of our opinion about it.

**More than two artifact panes.** Rejected as scope. Two answers the case
that motivated it, and the resize rules in R4 are specified for exactly two.
Nothing in the data model prevents raising it later.

**Per-hunk revert, as v1 has it.** v1's revert sends the agent an
instruction to undo one hunk, with a reason, and the agent answers with a new
version. It was rejected here in favour of restoring a whole version, which
needs no agent, no anchoring, and no reconciliation. The two are not
exclusive and per-hunk revert remains available as later work.

**Tabs instead of side-by-side.** Rejected because the case that motivated
this is reading two artifacts at once. Tabs are still available through R1,
which is why opening in a new tab is a requirement rather than a
consequence.

## Implementation Plan

Each phase leaves the suite green and the surface usable.

**Phase 1 - the record can say it.** The `artifact-meta` entry, its
validation, its fold, and the catalog carrying title and retired. No UI.
Verified by store tests, including that an unknown `src` is still carried and
that a meta entry for an unknown artifact is ignored.

**Phase 2 - the URL names the artifact.** R1 routing, validation, and the
page choosing its artifact from the URL. One pane still. Verified by server
tests and by loading a record holding two artifacts and reaching both.

**Phase 3 - the list.** R2. Reaching every artifact by clicking, and by
opening a new tab.

**Phase 4 - the version picker and read-only.** R5, R6, R7. This is the
phase that changes what the product permits, and it is deliberately after
the routing work so that a version is linkable when the picker appears.

**Phase 5 - restore.** R8, with its confirmation.

**Phase 6 - two panes.** R3 and R4, including the resize rules and their
persistence.

**Phase 7 - compare.** R9, both layouts and the width they switch at.

**Phase 8 - rename and retire in the page.** R11 and R12 reach the UI.

**Phase 9 - the queue bound.** R10. Independent of everything above and MAY
land at any point.

## Open Questions

None outstanding. Every question this draft opened was answered before it
left Draft; the answers are recorded as requirements above, and this section
records what they were so a later reader sees the path.

1. **What a comparison looks like.** Answered: side-by-side where there is
   horizontal room, inline below that width, chosen by the room available
   rather than a stored preference (R9). v1's change view was the prior art
   and was not copied wholesale, because its shape serves acting on a change
   through a per-hunk revert, and this RFC has no per-hunk revert.

2. **Document mode with two artifact panes.** Answered: one mode governs both
   panes (R3). Alt Backspace therefore needs no focused pane and no
   per-pane meaning. A selection stays per artifact, because a batch names
   one `artifactId`.

3. **Whether a retired artifact is withheld from the agent.** Answered: it
   stays in the state block, marked retired (R12). An agent revising an
   artifact nobody told it was retired would be refused for a reason it could
   not see.

4. **Whether the page offers un-retiring.** Answered: yes (R12). The retired
   artifact's own page MUST offer it, which is what turns E-ART-02 from a
   dead end into the way back. The list SHOULD also be able to reveal
   retired artifacts, because otherwise finding that page depends on browser
   history. A trash view was considered and rejected as more surface than the
   act deserves.

## What the review changed

This draft answers
`docs/rfc/07_many-artifacts-in-one-record-and-the-history-you-can-move-through.review-draft-2026-08-26.md`,
a cross-family review by `muse-spark-1.2-contributor@muse`. One line per
point, so the path is visible without a diff.

| Point | What changed |
|---|---|
| F-01 | Data model no longer claims `artifact-meta` rides the same mechanism as `basedOn` and `values`. A table separates additive field from additive source, and names the deploy consequence: a reader without RFC-04 P1 throws on a new source and never on a new field |
| F-02 | The catalog change is stated as additive, in both directions: an older client keeps working, and a newer client has to tolerate a server that never sends the new fields. A note says the three new routes are absent today by design |
| F-03 | The traversal requirement is rewritten as a constraint on the code R1 asks for, since no path joins an `artifactId` into the filesystem today. It now also forbids ever doing so: an artifact is found by index lookup, not by path |
| F-04 | R4 defines the one-pane case, names the minimums (`CONVERSATION_MIN` 280, `DOCUMENT_MIN` 320), says what happens when the viewport cannot hold them, and persists two values - a conversation width and a ratio - rather than three widths carrying an invariant |
| F-05 | R2 says a retired artifact is never in the artifact list; R12 says revealing them shows them separately. Both routes to un-retiring are required, neither has priority, and the reason each exists is stated |
| F-06 | The endpoint refuses a meta write for an unknown artifact; the fold tolerates and ignores one. The RFC now says why both are right rather than leaving them as a contradiction |
| F-07 | A title is at most 200 characters with no control characters, refused at the endpoint outside that. Display truncation is named as not a second bound |
| F-08 | R6 no longer claims tolerance is what keeps the decision reversible. It states that the rule is enforced by the page alone, that `curl` and an old tab can bypass it, why that is accepted, and that reversibility runs one way: relaxing later is free, tightening later is breaking |
| F-09 | R10 says two panes hold two queues and two inputs, each counting against `INPUT_QUEUE_MAX`, that this RFC does not raise that bound, and that Command-Enter sends the queue of the pane holding the selection, and the page says which |
| F-10 | R9 names the comparison as a line-oriented text difference over stored bytes, gives the side-by-side threshold as 360 CSS pixels per column, and adds `E-ART-08` for a version whose bytes cannot be read, which a size-refused version makes reachable |
| F-11 | Scope no longer says visual design is out of scope while specifying controls. It says the RFC chooses affordances because the behaviour depends on them, and that colour, type, spacing, icons, motion and placement are the design pass's, which MAY replace any visual treatment here |
| F-12 | Terminology names only the `CONTEXT.md` terms this RFC uses, and says `orphan` and `note box` are untouched |
| Claim 6 | The state machine gains `UNAVAILABLE`, guards `COMPARING` on there being more than one version, and has a section for two panes: each pane holds its own state, mode and selection are shared, and a pane that cannot be marked up while mark-up mode is on must say why |
| Errors | `E-ART-03` separates the endpoint's answer from the page's defect. `E-ART-05` says how it is reachable given R8. A closing paragraph maps every error to the state it is observed in |

### Second review

`...review-draft-2026-08-26-r2.md`, by `gpt-5.6-sol@codex`, a third family.
It had a shell, and several of its findings are demonstrated by folding
synthetic logs through the real store rather than reasoned about. It marks
eight of the twelve above resolved, three partly resolved, and agrees the two
points below were rightly declined.

| Point | What changed |
|---|---|
| N-01 | R1 no longer validates `artifactId` as a `conversationId`. Proved wrong by probe: `foldLog` indexes `plan/日本語` and `validConversationId` rejects it, so the rule would have hidden artifacts the record holds. The URL percent-encodes instead, the value is checked as an artifact field, and path safety comes from never joining it into a path |
| N-02 | R3 separates choosing an artifact from opening one beside, defines closing a pane, says which pane a third artifact replaces, and gives the URL to the active pane - so a link restores one pane and pane count is a property of the window, not the address |
| N-03 | One queue model: keyed by `artifactId` and `version`, never by pane. R3 no longer says otherwise. The RFC now states plainly that the number of queues is not bounded, why that limit is deliberate, and what a later answer has to reckon with. The `INPUT_QUEUE_MAX` claim was wrong and is corrected: it bounds inputs in flight from an applied disposition, so an unsent queue counts zero and a sent batch counts one |
| N-04 | `E-ART-08`'s premise was false. An oversized version is never added to `artifactIndex`, and both the catalog and the per-version read derive from that index, so the catalog cannot name an unreadable version. R9 now forbids extending the catalog to report refusals, because that would make an unreadable version current, and `E-ART-08` is restated for the cases that are actually reachable |
| N-05 | The state machine gains open-into-`UNAVAILABLE`, an edge to `UNAVAILABLE` from every state for retirement arriving elsewhere, and exits by choosing another artifact. It says an unknown artifact cannot be un-retired, that choosing another artifact replaces a pane rather than closing it, and that un-retiring carries no confirmation. `E-ART-04` is added to the error-to-state map |
| N-06 | R4 no longer claims a ratio needs no reconciliation. It gives the legal interval, worked examples, a required order of operations for applying the two stored values, a two-document upper clamp on the conversation width that today's `clampConversationWidth` does not have, which pane survives a viewport too narrow for two, and that the page does not reopen the second pane on its own |
| N-07 | 200 and 360 are named as policy numbers rather than derived. The title bound counts UTF-16 code units, which is what the neighbouring 128 counts. The 40 pixels above `DOCUMENT_MIN` is stated as chosen rather than measured, an implementation is free to measure its own, and the width measured is the column's content box |
| N-08 | The Endpoints table was malformed: prose inserted mid-table orphaned two rows. Rebuilt as one table with a status column. The claim of "three routes marked new" was false - two are new and one changes additively - and now says so |
| N-09 | The fold's rule for a malformed `artifact-meta` entry is defined: each field on its own merits, ignore what cannot be used, ignore the entry entirely with no usable `artifactId`, and never fail to open the record. The RFC says why this is more forgiving than the endpoint, and that `E-ART-06` and `E-ART-07` have no fold counterpart by design |

Two review points were not applied as written.

- **F-02 and F-03 call the absence of the new routes "drift from the
  codebase".** An RFC specifies what is not yet built, so absence is not
  drift. The real observations inside both points - that the catalog change
  needs to be additive, and that the traversal requirement described a risk
  that does not exist yet - are applied above.
- Every finding in the **first** review is graded at level 2 on the evidence
  ladder or below, because that reviewer's sandbox denied it a shell. Those
  findings were checked against the source by hand while applying them. The
  second reviewer had a shell and reached level 4 on several, including the
  two that refuted claims this RFC had made.
- The second reviewer could not run the structural validator, because `npx`
  had no network to fetch `tsx`, and could not get a clean test run, because
  its sandbox refused `mkdtemp`. Both are reported in its Not-reviewed
  section rather than worked around. The validator and the suite were run
  here instead, and both are green.

## References

### Normative

- `CONTEXT.md` - what lucid is, and every term this RFC does not redefine.
- `docs/rfc/06_an-artifact-you-can-address.rfc.md` - the artifact layer this
  RFC extends: the fence, the annotation batch, the save, and the anchoring
  rules.
- `docs/rfc/04_live-delivery-a-running-host-follows-its-own-log.rfc.md` -
  P1, which is why a new entry source does not need a version bump.
- `src/store/log.ts` - `ENTRY_SOURCES`, the artifact entry, and the fold that
  this RFC adds a source to.

### Informative

- `docs/decisions.md` - the standing decisions this RFC does not disturb.
- `PLAN.md` - the delivered substrate RFC, kept as history.
- `~/dev/lucid` `client/chrome/Header.tsx` and `client/chrome/Surface.tsx` -
  v1's version picker and change view, which are prior art for R5 and R9 and
  the source of the per-hunk revert rejected in Alternatives.

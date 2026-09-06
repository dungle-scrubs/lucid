# lucid — design brief

A brief for designing lucid's browser surface. It assumes no knowledge of the
product and no access to its source. Everything a design needs to account for
is here.

Read this with [current visual rules](design.md) and the runnable behavior
reference (`bun run build:reference`). The reference uses the product's
instrumentation stylesheet; do not use a historical exported HTML page as
a claim about the current interface.

---

## 1. What lucid is

lucid is a place to **read what an agent produced, and mark it up**.

An AI coding agent runs somewhere — a background process, or a terminal
session a person is already using. lucid records that conversation
permanently and shows it in a browser. The conversation outlives the process:
close the agent, reopen it later, hand it to a different agent entirely, and
the conversation continues where it stopped.

The thing the agent produces is called an **artifact**: a document, rendered
live in the browser. A checklist, a plan, a report, a specification. The
agent writes it, the person reads it, marks it up, and the agent revises it.

**One person, on one machine.** Not a team tool, not a hosted service, not
multi-user. That is a decision, not a limitation to design around.

### The shape of the thing

Two surfaces, side by side.

- **The document.** The artifact itself, rendered as the agent wrote it. This
  is the primary surface and it gets the room.
- **The conversation.** What was said, in order. The product calls this *the
  margin note*: a reading column beside the document, not half the screen.

That relationship is the product's core idea and the design must carry it.
The document is the work; the conversation is the commentary.

### What is unusual about it

**The document is not lucid's.** The agent wrote the HTML, including its own
styling. lucid renders it untouched and draws its own marks over the top —
outlines, highlights, an editing affordance. Every mark lucid makes has to
stay legible over a document whose appearance lucid does not control and
cannot predict, in both light and dark.

This is the single hardest constraint in the brief.

**Nothing is ever destroyed.** Every version of the document is kept. Editing
appends a new version, restoring an old one appends a copy of it at the end.
Nothing is overwritten, so no action a person takes here is irreversible.
Where the design would normally warn about losing work, the truthful message
is usually that nothing is lost.

---

## 2. Who uses it, and what they do

One person, working with a coding agent, on their own machine.

A session looks like this:

1. Ask the agent for something. It writes a document.
2. Read the document.
3. Mark up the parts that are wrong — select a paragraph, or drag over a
   phrase, and write a note about it.
4. Send the notes. The agent revises the document.
5. Read the new version. Repeat.

Alongside that, the person can **edit the document directly** — tick a
checkbox, fill a field, correct a sentence — and save it as a new version the
agent then works from.

So there are two things a person does to a document: **write about it**, and
**change it**. They are separate modes, and confusing them is the failure
this design must prevent.

---

## 3. The two modes

**Annotate** — the mode a document opens in. Clicking picks a part of the
document to write a note about. The agent's own controls do not operate: a
click on a checkbox selects it for a note rather than ticking it.

**Edit** — the document behaves as the agent built it. Controls work, text
takes a caret, and changes are saved as a new version.

### The mode may never be ambiguous

This is not a preference. The same click, on the same pixel, does one of two
completely different things:

| | annotate | edit |
|---|---|---|
| click a checkbox | outlines it, starts a note | **ticks it**, document now unsaved |

A person who is unsure which mode they are in cannot predict what a click
will do. The design must make the mode legible at every screen size, at all
times.

### Decided: the document sheet carries the mode signal

Not the background around it. The sheet is the one thing on screen at every
size, and it is where the eyes already are; on a phone the ground around it
is close to zero.

Each mode also carries a subtle background pattern behind the sheet — from
Hero Patterns, **Topography** for one and **Graph Paper** for the other — but
those are decorative. They are not load-bearing and must not be the only
signal.

### What else differs, and why

Forced by behaviour, so the design must carry it:

- A click means two different things.
- Text is editable in edit mode only.
- The agent's controls are inert in annotate mode.
- An older version suspends both modes without being a third mode.
- **Annotate is where a document opens**, so the first state anyone meets is
  the one where clicking a control does not operate it.

Open to the designer: the cursor (a crosshair today, which is a choice),
every colour, and whether annotations stay visible while editing.

---

## 4. What is on screen

```
┌──────────────────────────────────────────────────────────┐
│  conversation name        what is driving      status     │
├────────────────────────────────────┬─────────────────────┤
│  name    version    mode           │                     │
│ ─────────────────────────────────  │   the conversation  │
│                                    │                     │
│         the document               │   messages, and     │
│           (the sheet)              │   the notes you     │
│                                    │   wrote, in the     │
│                                    │   order they        │
│ ─────────────────────────────────  │   happened          │
│  guidance                   save   │                     │
│                                    ├─────────────────────┤
│                                    │  activity / queue   │
│                                    │  composer           │
└────────────────────────────────────┴─────────────────────┘
```

**The bar across the top** names the conversation, what is driving it (which
agent, which model), and whether anything is currently attached.

**The document pane** holds the artifact's name, its version, the mode
control, the document itself, and a bar underneath carrying a line of
guidance and the save control.

**The conversation pane** holds the transcript and, fixed at its foot, a dock
that never scrolls away: what is happening now, any notes waiting to be sent,
and the box you type in.

A draggable divider sits between them on wide screens.

### The name is edited in place

The artifact's name is an editable field carrying the name, with an edit icon
appearing on hover to say it can be changed. It should read as directly
editable rather than as a control that reveals a field.

---

## 5. Every state

The behaviour reference shows all of these. This section says what each one
*means*.

### In the document

| State | What it means |
|---|---|
| **nothing** | Annotate mode, nothing under the pointer |
| **hovered** | This is what a click would take |
| **selected** | This is in the note being written |
| **text dragged over** | These exact words are in the note, not the whole block |
| **annotated** | Something was already said about this |
| **edited** | Changed and not yet saved |
| **editable** | A caret can go here |
| **caret here** | Typing lands in this block |

Two of these need care.

**Text dragged over** is drawn one box per visual line, so a phrase that
wraps is several boxes rather than one rectangle. **A drag can end mid-word,
and the design must show that it did.** This is not hypothetical: a selection
once read `ALPHA BRA`, the note said "these two words only", the agent read
that as two whole words, and a six-item list was cut to two. A treatment that
rounds selections out to word boundaries would hide exactly the thing that
went wrong.

**Editable** appears only when the pointer approaches a block, not
persistently — the document is the agent's, and lucid marking every paragraph
is too much. On a touch screen there is no approach, so the cue is persistent
there instead. Those are the same decision for two input devices.

### Combinations, and a rule

An element can be in several states at once. The rule:

> **What you are doing wins over what is already true.**

Hover and selection are transient and must always be visible. Annotated and
edited are persistent and yield to them — but must stay legible underneath,
because an element genuinely can be both and the person needs both facts.

In practice this means **whatever carries "annotated" cannot be the same
visual channel as whatever carries "selected"**. Two channels, not one.

### Notes, in the conversation

A note sits in the transcript where it was written, between the messages
around it. Eight states:

| | What it means |
|---|---|
| **queued** | Written, not sent. Still yours to change |
| **sent** | Sent. Nothing known about where it points now |
| **certain** | The words it pointed at are still there, unchanged |
| **changed but matched** | The passage was reworded and found anyway |
| **matched without the words** | A guess. Worth checking |
| **lost** | The document changed and the spot is gone |
| **not on this version** | It exists, on a version you are not looking at |

The middle three are one question — *how confident is lucid that this note
still points where it did* — and the design needs **three bands plus lost
plus not-on-this-version**, not seven treatments.

**Lost is not an error.** It is a fact about history: the document moved on.

### Attaching a file

A person can attach a file to what they send: in the composer, and on a note.
The note is the one that matters — a screenshot of what is wrong with a
paragraph is marking up, which is what the product is for.

States, all of which exist today:

| | What it means |
|---|---|
| **attach** | The control that opens a file picker. Present in the composer and in the note box |
| **attached, a picture** | A thumbnail of what you attached |
| **attached, not a picture** | A marker saying whether it is text or some other file, with its name |
| **removing one** | Takes it off the message. The bytes stay in the record |
| **too large** | Refused, with the reason. 25 MB is the limit |
| **could not attach** | Something else failed, and it says what |

Two things a design has to know, because they are not obvious and they change
what is honest to show:

**A file is stored the moment it is chosen, not when the message is sent.**
Attaching and sending are separate acts, so closing the page does not lose an
attachment, and removing one from a message does not remove it from the
record.

**lucid cannot promise the agent saw it.** A file whose contents are text goes
into the message and is delivered as certainly as the message. Anything else —
an image, a PDF — is *named*, not sent: the agent is told where it is and may
or may not be able to open it. The design must never present the second as
though it were the first. That is not a wording preference; the failure it
avoids is someone attaching a screenshot, getting a confident answer, and
never learning it was answered without looking.

### A note takes you to what it points at

Clicking a note in the conversation goes to the part of the document it is
about. Without this you re-read the document hunting for where an annotation
happened, which is the thing the product exists to stop.

The rule has three cases and the first one is the one designs usually get
wrong:

- The target is **already on screen** — light it in place and do not scroll.
  Never move the page under a reader who is already looking at the thing.
- The target is **off screen** — scroll it to the vertical centre and light
  it.
- The target is **lost** — light the note itself and do not move the document
  at all. There is nothing to go to.

This is the same rule that governs new material arriving: *already visible*
means show it in place, *off screen* means offer to travel. The design should
treat them as one idea, not two.

### The transcript

Four kinds of row: what you said, what the agent said, a tool the agent used,
and something lucid recorded (a version saved, a note sent).

**A refusal is a fifth kind and does not currently look like one.** See §7.

### Waiting

| | |
|---|---|
| the agent is working | a turn is in flight |
| working, with a count | the elapsed time, shown only past 8 seconds |
| **stalled** | past 3 minutes for a turn, or 45 seconds for undelivered notes |
| notes queued | written and not sent |
| a newer version arrived | the agent got ahead of you |

Five of these are progress. **Only "stalled" is a warning**, and the
thresholds behind it are measured from real sessions, not chosen — a count
that appears too early teaches people to stop reading it.

### Empty, and broken

- **No artifact yet** — an invitation, naming the next action. Not an error.
- **No artifact by that name** — the address named something this
  conversation does not hold, so it offers the one it does.
- **The connection is dead** — everything stops, and there is exactly one
  action: reload.

---

## 6. Committing and discarding an edit

When you change the document, the top bar **becomes the question** and
nothing else: unsaved changes, discard, save. The name, version and mode
controls are hidden until you answer. (This is the Shopify App Bridge
contextual save bar, and it is deliberate.)

Consequences the design should know:

- **You cannot switch mode while an edit is pending**, because the control is
  not there. This is a cost the pattern imposes, not a hazard it prevents.
- **Discard confirms.** It is the only control here that destroys work.
- Closing the page with an unsaved edit asks first.

### The case that needs the most care

The agent can write a new version **while you are editing**. It happens
often — you are reading, the agent is working.

lucid holds your document where it is rather than replacing it under you, and
offers both ways forward: **save mine first**, or **discard mine and show
it**. Saving works and is not a conflict: your edit becomes the next version,
recording which version you were working from, and the agent reconciles.
Nothing is lost either way, because every version is kept.

**The wording here must not read as an error, because it is not one.**

---

## 7. Defects the design must fix, not preserve

Four things on the behaviour reference are marked as defects. They are
current behaviour, and a design that reproduces them faithfully would be
wrong.

1. **An annotated element gives no feedback when hovered.** The annotated
   treatment covers it completely.
2. **An annotated element gives no feedback when selected.** Same cause. This
   is the worst of the four, because going back to something you already
   annotated is the most likely thing to do.
3. **Edited-and-selected renders as neither state** — one state's outline
   with another's fill.
4. **A refusal is indistinguishable from the agent talking.** lucid refuses
   the agent often and on purpose: a change it would not make, an instruction
   it could not follow. That is the substrate saying no, and it explains why
   the document did not change. It currently looks exactly like the agent
   speaking.

The first three are all the same underlying problem, and §5's rule fixes
them.

---

## 8. Small screens

Tablet and phone are in scope. The current surface does not survive them and
the numbers say why.

On a phone the two panes stack, and the document — the primary surface — gets
**86 pixels of height**, while the conversation gets 574. lucid's own
furniture around the document takes 132 pixels, which is more than the
document itself. One line of title is visible and nothing else.

Decided:

- **Wherever both surfaces are shown, the document gets the majority.** The
  product's own priority; the current layout inverts it.
- **A phone shows one surface at a time** — one primary, the other summoned.
  Not a corrected split: a phone screen divided two ways gives neither enough.
- **Tablet portrait keeps the stack** with the ratio corrected. There is
  genuinely room for both.
- **Hover has no touch equivalent and must not be simulated.** On touch the
  confirmation moves after the tap, which the selected state already gives.

The document's top bar also does not fit a phone: three controls, one of
which is a sentence (`v24 · by the agent · current`), totalling more than the
width available. The mode control currently clips mid-word.

Untested and needing a real device: dragging over text to select it is half
of annotating, and on touch that raises the operating system's own selection
handles. Those plausibly collide with lucid's.

---

## 9. What is decided, and what is yours

**Decided, and the design must honour it:**

- The document is the primary surface; the conversation is the margin note.
- The sheet carries the mode signal.
- Two visual channels, so persistent and transient states can show at once.
- The editable cue reveals on approach with a pointer, persists on touch.
- The save bar replaces the top bar's contents while an edit is pending.
- Three bands of anchoring confidence, plus lost, plus not-on-this-version.
- Five treatments for things that did not happen, grouped by what the person
  can do: *now you know why nothing changed* · *fix what you just did* ·
  *here is the way in* · *wait* · *reload*.
- A phone shows one surface at a time.
- Light and dark, authored light first.
- Tailwind, with the theme declared in CSS.

**Yours:**

- Every colour, typeface, spacing scale — the entire visual system. Nothing
  in the current appearance is an argument for anything; it is a prototype
  that was never designed.
- How the two visual channels are separated.
- The cursor in each mode.
- Whether an icon set is needed, and which.
- A motion vocabulary: a version arriving, a note landing, the mode changing.
  One motion already exists and should be kept — when new material appears
  **inside the reader's viewport** it pulses once in place over about 2.6
  seconds and offers no jump; when it is off screen it offers a jump and does
  not pulse. **lucid never scrolls a reader who is already looking at what
  changed.**
- The light and dark token structure.
- What the guidance line is for, once the sheet carries the mode.
- What the version control becomes when it cannot be a sentence.

---

## 10. Two things to know about the markup

**The conversation's structure is fixed; its appearance is not.** The
transcript is built on a component library that ships no styling at all — it
contributes behaviour (auto-scroll, submit, scroll-to-bottom) and one
unstyled wrapper element per message. Every visual decision is free. What
cannot change is that extra wrapper and those behaviours.

**The document is inside an isolated frame.** The agent's HTML is sandboxed
and cannot be styled from outside. lucid's marks are injected into that frame
as their own stylesheet, sharing the same design tokens as everything else,
so light and dark hold inside the document as well as around it.

---

## 11. Built since this brief was written

These existed only as decisions when the brief was first drafted. They are
built now, and the design has to account for them like anything else.

- **The pulse**, described in §9, and its other half in §5 — clicking a note
  to go to what it points at. Both halves of one rule.
- **Comparing two versions** side by side, over the stored bytes. Read-only:
  it never reaches the agent, never appends, and neither side can be edited.
  Two columns where each would have 360 pixels, one column below that.
- **Seeing what a version changed**, which is what lets the pulse know which
  parts are new.
- **Attaching a file**, in the composer and on a note, described above.
- **Keeping the reader's place** when a version arrives. Before this, every
  revision threw the reader back to the top of the document, which also made
  the pulse meaningless — nothing can be "already in view" if the view
  resets.

---

*Ships with this brief: `behaviour-reference.html` — 47 states on one page,
self-contained, openable in any browser.*

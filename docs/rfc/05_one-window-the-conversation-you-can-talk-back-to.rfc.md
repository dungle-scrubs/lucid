---
number: 05
title: "One window: the conversation you can talk back to"
type: protocol
status: Draft
author: Kevin Frilot
date: 2026-08-24
---

# RFC-05: One window: the conversation you can talk back to

> **Revision 2.** Answers
> `05_one-window-the-conversation-you-can-talk-back-to.review-draft-2026-08-24.md`,
> two independent cross-family reviews (`muse-spark-1.2-contributor@muse`,
> `gpt-5.6-sol@codex`). Five blocking findings between them, barely
> overlapping. What changed:
>
> - **B1** "Asking turn retired" was undefined, and both readings of it fail.
>   Replaced with hcn's own signal: `done { cause: "awaiting-input" }`.
> - **B2** An answer inherited the turn-boundary rule, which is wrong for the
>   one input that exists to unblock a turn. An answer is immediate.
> - **B3** `turnId` was "REQUIRED for `mode: answer`" with no codec rule to
>   enforce it. Now a cross-field check with its own issue.
> - **B4** The compatibility claim was checked on the frame codec and the
>   **fold does not go through it**. A reviewer ran it: an old reader accepts
>   `mode: "answer"` silently. Validation moves to where both paths meet.
> - **B5** `answer` exists only on a persistent session, so half the harnesses
>   had no route. Now profile-gated, like `steer`.
> - **B6** Attach replay bypasses the staleness rule entirely.
>
> Six majors folded in below and marked where they land.
>
> First of the two things `CONTEXT.md` names as next. This one makes the
> conversation usable; RFC-06 will put an artifact in it.
>
> Written after watching a live conversation fail at the last inch: the
> harness asked a question, the viewer rendered it, the input box sat
> underneath with a cursor in it, and nothing read the keyboard.

## Abstract

lucid can drive a conversation and lucid can render one, in two processes
that never meet. Using it means a driver in one terminal, a viewer in
another, and a third to send from - and the viewer's input box is painted
scenery. This RFC puts the driver and the viewer in one process, wires the
keyboard to the box, and adds the one protocol notion that makes talking back
work: an **outstanding question**, so that what you type when the harness
asked something is delivered as an answer rather than as a new turn.

## Introduction

### The problem, exactly

Everything below is current behaviour, checked rather than remembered.

- `lucid run` drives a conversation and holds the terminal until Ctrl-C.
- `lucid watch` renders the conversation and paints `>` with a cursor.
- **Nothing reads the keyboard.** The box is decorative. `render.ts` says so
  in its own comment: "NOT responsible for input reading (the driver owns the
  keypress loop)", and there is no driver that owns one. stdin IS read
  elsewhere - `readStdin` in the hook path - but that is a hook payload
  arriving on a pipe, not a person typing, and it shares nothing with this.
- `lucid send` appends an input from a third process.

So the loop closes only by leaving the window. That is the whole of it.

### The sharper half: a question with no way to answer

A harness can ask. hcn parses an `hcn-question` block out of a turn and emits
a `question` event beside the message that carried it. lucid renders it
(RFC-05's predecessor fix) and records it.

An answer is a different thing from an input. hcn knows this: its session
takes an `answer` command, composes the wrapper itself, and refuses
`no-open-question` when nothing is pending. lucid's own seam already exposes
it - `HarnessSession.answer(id, text)` in `src/harness/runner.ts`, implemented
in `hcn-runner.ts`, covered by one unit test, and **called by nothing**.

What is missing is above the seam: lucid's protocol has no idea a question is
outstanding, so it cannot route what you type to the right place.

### Scope

In scope:

- One command that drives and renders in the same process.
- A keypress loop that fills the input box and submits it.
- An outstanding-question notion in `ChannelState`.
- An input mode that means "this answers the question".
- The degradation when the question is gone by the time the answer lands.

Out of scope:

- **Artifacts and annotation.** RFC-06. This RFC must not shape the view in
  a way that assumes text is all a conversation holds, and Implementation
  Notes says how.
- **A browser.** Still a terminal.
- **Multi-pane layout, scrollback, mouse.** A conversation, a rule, a status
  line and a box. Anything more is chrome, and chrome is deferred by the
  same constraint that deferred artifacts.
- **Editing history, deleting inputs, retry.** Not now.
- **`watch` gaining the ability to drive.** It stays read-only, for the
  reason in State Machine below.

### What already exists

More than it looks. This RFC is mostly wiring.

| Piece | Where | State |
|---|---|---|
| Drive a conversation | `startHeadless`, `src/cli/runtime.ts` | Works, has an `onStart` seam |
| Render a conversation | `buildView` / `renderLines`, `src/tui/` | Works, pure, fixture-tested |
| Follow a record | `followRecord`, `src/store/tailer.ts` | Works, shared by viewer and driver |
| Send an input | `enqueueInput`, the `input` frame | Works, idempotent ids, replay |
| Answer a question | `HarnessSession.answer` | Implemented, unused |
| Know a question is open | — | **Does not exist** |
| Read a keypress | — | **Does not exist** |

## Terminology

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be
interpreted as described in RFC 2119. Nouns are from `CONTEXT.md`.

- **chat** - the new command. One process that holds the executor lease,
  drives the harness, renders the conversation, and reads the keyboard.
- **outstanding question** - a `question` event that has been accepted into
  the log and not yet answered or retired.
- **answer** - an input that responds to the outstanding question. Carries
  the question it answers, so a late one can be recognised as late.
- **draft** - what the human has typed and not yet submitted. Never durable.

## Protocol Overview

### One process, three jobs

```
  lucid chat demo --harness claude
  ────────────────────────────────
   holds the presence lock (= executor lease)
   drives the harness            ── events ──►  the log
   follows the log               ◄─────────────────┘
   renders                       ──►  the terminal
   reads the keyboard            ──►  input / answer frames
```

`chat` is `run` and `watch` in one process. It is not a new subsystem: it
composes `startHeadless` and the view, both of which already exist, and adds
the keypress loop that neither has.

### The question, and the answer

```
  harness                lucid                     human
  ───────                ─────                     ─────
  emits question ──► accepted into the log
                     questionOpen = { turnId, text }
                     rendered as a question ──────►  reads it
                                                     types
                     ◄── input { mode: "answer" } ── submits
                     routes to session.answer()
                     questionOpen = null
```

**R1 - a question opens on `question` and is confirmed by `awaiting-input`.**
`ChannelState` gains `questionOpen: { turnId, text } | null`. It is set when a
`question` event is accepted.

*(B1.)* Revision 1 said it clears when "the asking turn is retired" and never
said what retires a turn. Both readings fail. Keying on `done` clears every
question before a human can see it. Keying on any new `turnId` cannot express
the replace rule below.

hcn already answers this. A turn that ends by asking emits
`done { cause: "awaiting-input" }`, and hcn's own reference says that cause
"ends the ASKING TURN while the session stays ready". So the asking turn
ending is not the question closing - it is the question being *ready to
answer*. lucid MUST NOT clear `questionOpen` on a `done` whose cause is
`awaiting-input`. `HarnessCause` is typed `string` in lucid today; this RFC
names `awaiting-input` the way RFC-05's predecessor named the `question`
kind, for the same reason: a value hcn documents should not reach lucid as an
unknown.

`questionOpen` clears on exactly three things, and nothing else:

1. an answer to it reaching an `applied` disposition,
2. the first accepted event of a turn that is neither the asking turn nor the
   answer's turn - a conversation that moved on,
3. `detach`.

A second `question` while one is open REPLACES it. The older question's
`turnId` then fails R4, which is correct: an answer to a superseded question
is stale.

**R2 - an answer is an input, not a new frame.** `input.mode` gains `answer`.
That reuses the idempotent id, the disposition lifecycle, the input bound and
the replay discipline. A new frame kind would need every one of them again.

**R3 - an answer is delivered immediately, never held to a boundary.**
*(B2.)* RFC-04's boundary rule holds a `queue` input until the running turn
produces its terminal event. Revision 1 said an answer inherits that. It must
not. An answer exists to unblock a turn; holding it until that turn ends is
either a deadlock or, once `awaiting-input` has already fired, a delivery
into a conversation that has moved past the question. An answer follows
`steer`'s path - straight through - and for the same reason `steer` has one.

**R4 - an answer names the question it answers.** The frame carries the
`turnId` of the question. An answer whose `turnId` is not the currently open
question's is refused `stale-answer`.

**R5 - one answer at a time.** *(gpt M4.)* `questionOpen` gains an
`answering` reservation: the id of an answer accepted and not yet dispositioned.
While it is set, a second answer-mode input is refused `stale-answer`. Without
it, two submissions both satisfy "a question is open", the first consumes
hcn's question and the second is demoted into a turn nobody asked for.

**R6 - answering is a session-mode capability.** *(B5.)* `session.answer`
exists only on a persistent session. `headless-turn` - one process per turn,
today codex and muse - has no session to answer into. An answer-mode input at
a `headless-turn` attachment is refused `answer-unsupported`, exactly as
`steer` is refused `steer-unsupported` there, and by the same reducer check.
The chat window MUST show this before the human types, not after they submit:
the status line already carries the profile.

**R7 - a source MUST NOT invent the answer wrapper.** hcn composes it
(`The user answered the question: "..." with: ...`). lucid passes raw text to
`session.answer`, the same discipline as never mirroring hcn's event kinds.

## Message Formats

No new frame kinds. Two additions, three refusals, and one validation rule
that matters more than any of them.

### `input.mode` gains `answer`

```json
{ "kind": "input", "seq": 41, "id": "ans-1", "text": "Draft the RFC",
  "mode": "answer", "turnId": "turn-7" }
```

`turnId` is already optional on `input`. For `mode: "answer"` it is REQUIRED.

*(B3.)* Revision 1 asserted that requirement and specified nothing to enforce
it. The codec validates `mode` with `enumOf` and `turnId` with `optStr`,
independently, with no cross-field rule - so an answer with no `turnId` would
decode fine, reach `enqueueInput` with `turnId` undefined, and be refused
`stale-answer`, reporting a staleness problem for what is a malformed frame.

The codec MUST reject `mode: "answer"` without a wire-valid `turnId`, with its
own issue:

```
"answer-needs-turn"
```

### Validation lives where both paths meet

*(B4. This is the finding that changed the most.)*

Revision 1's compatibility story was: an older reader refuses `mode: "answer"`
at `enumOf` with `wrong-type`, so an answer can never be silently
reinterpreted as an ordinary send.

That is true of the frame codec and **false of the log**. A durable input is
not a stored frame. It is a `src: "input"` log entry whose payload goes
straight to `enqueueInput` during a fold, never through `decodeFrame`.
`validEntry` checks the envelope only. A reviewer folded an entry carrying
`mode: "answer"` through the current reader and it was accepted, mode and
`turnId` intact, ready to be delivered as an ordinary send.

So the guarantee has to move to where both paths meet. `enqueueInput` MUST
validate `mode` against the modes this build knows and refuse an unknown one
with `wrong-type`. The codec keeps its check - failing early is still better -
but the reducer's check is the one that makes the claim true, because every
input reaches it, whether it arrived on a wire or out of a file.

This is the second time an RFC in this repo has checked the frame path and
not the fold path. RFC-04 did it with the delivery cursor. Worth stating as a
rule for the next one: **a claim about what an older reader does is a claim
about `foldLog`, not about `decodeFrame`.**

### `attach-ok` is unchanged

An attaching source learns about an outstanding question by folding the log,
like everything else. Putting it in `attach-ok` would create a second source
of truth beside the fold.

### Three new refusal issues

```
"stale-answer"        the answer names a turn that is not the open question,
                      or no question is open, or another answer is pending
"answer-needs-turn"   mode is answer and turnId is missing or not a wire id
"answer-unsupported"  the attachment's profile has no session to answer into
```

All three are ordinary `REFUSAL_ISSUES` values. An older reader decoding one
fails closed at `enumOf` with `wrong-type`.

### Refusal order is specified, not incidental

*(muse M4.)* `input-id-reused`, `input-queue-full`, `answer-needs-turn`,
`answer-unsupported` and `stale-answer` can be true of one frame at once, and
which one is reported decides what the human is told. The order is:

1. wire validity - `invalid-input`, `answer-needs-turn`
2. identity - `input-id-reused`
3. profile capability - `steer-unsupported`, `answer-unsupported`
4. conversation state - `stale-answer`
5. capacity - `input-queue-full`

Malformed beats duplicated beats impossible beats stale beats full. Capacity
is last because it is the only one that becomes false on its own.

## State Machine

### The question

```
   none ───── question event accepted ─────►  open { turnId, text }
    ▲                                              │        ▲
    │                                    answer accepted    │ done{awaiting-input}
    │                                              ▼        │ does NOT clear
    │                                    open + answering { inputId }
    │                                              │
    │◄── answer applied ───────────────────────────┘
    │◄── first event of an unrelated turn accepted
    │◄── detach
```

Three things and only three clear it: an answer reaching `applied`, the first
accepted event of a turn that is neither the asking turn nor the answer's, and
`detach`.

**`done { cause: "awaiting-input" }` does not clear it.** That `done` ends the
asking turn, which is what makes the question answerable rather than what ends
it. Any other `done` cause ends a turn that was not asking, and leaves an open
question alone.

**A second question replaces the first**, and takes its own `answering`
reservation with it - a reservation belongs to the question it was made
against. *(gpt M4.)* Revision 1's unqualified "clear when an answer is
applied" would have let a late disposition for the old question clear the new
one.

### A question hcn still holds after lucid replaced it

*(muse M6.)* lucid replacing a question is lucid's view. hcn's session holds
its own notion of what was asked, and an answer to lucid's newer question can
come back `no-open-question` because hcn wanted the older one.

lucid does not try to reconcile this. The demotion path below handles it: the
text is delivered as an ordinary send and the divergence is recorded. A
harness that asks twice without waiting has made the first question
unanswerable, and pretending otherwise would mean lucid keeping a queue of
questions that hcn does not have.

### Text typed before a question arrived

*(muse M6, gpt M7.)* A human submits while nothing is asked; a `question`
event lands one entry later. That input is already appended and dispositioned.
It MUST NOT become an answer retroactively. The view renders both in `seq`
order, so the question appears below the input - which is what happened, and
the transcript's job is what happened.

### The chat process

```
   start
     │
     ├── controller says await-reattach ──► exit, reporting why
     ├── presence unavailable ────────────► exit, naming the holder
     ▼
   LEADING ── keypress ──► draft
     │  ▲                    │
     │  │                    └── submit ──► input / answer
     │  └── log grew ──► fold ──► render
     │
     ├── lease lost ──► FOLLOWING (render only, say so, keep the draft)
     └── Ctrl-C ──► detach, release, restore the terminal, exit
```

**`FOLLOWING` is new.** *(muse M7.)* Revision 1 said `chat` refuses to start
without the lease and said nothing about losing it while running. A keypress
loop that stays alive after the lease is gone would keep appending inputs
nobody will dispatch until a new leader appears. On lease loss `chat` MUST
stop accepting submissions, keep rendering, and say the conversation moved.
It does not exit: the record is still worth reading, and the draft is still
worth keeping.

`watch` does not gain the ability to drive, for the same reason: a viewer
that sometimes drives has to tell the human which it is, and the answer
changes under it.

### Submitting

| Condition | What is sent |
|---|---|
| A question is open, profile is `headless-session`, no answer pending | `input { mode: "answer", turnId }` |
| A question is open, profile is `headless-turn` | Nothing. The box says answering needs a session profile |
| A question is open and an answer is pending | Nothing. The box says one is in flight |
| No question, no turn running | `input { mode: "queue" }`, delivered at once |
| No question, a turn running | `input { mode: "queue" }`, held to the boundary |
| No question, a turn running, interrupt requested | `input { mode: "steer" }` |

Refusing in the window beats submitting a frame that will be refused: the
human learns before they lose the shape of what they typed.

### Replay, and why an answer is not replayed as one

*(B6.)* Attach replays every input still awaiting an applied disposition,
straight from `state.inputs` through `receive` - it does not call
`enqueueInput` again, so no staleness check runs. An answer valid when it was
appended can be replayed long after its question is gone, and hcn's `answer`
carries no lucid `turnId` to catch it.

So R4 and replay cannot both hold as revision 1 wrote them. The rule:

**An answer-mode input is replayed as `queue`, never as `answer`.** The
replay path rewrites the mode. Its text is what the human meant; its
answer-ness was true of a moment that has passed. Delivering it as an ordinary
input keeps the words and drops a claim that can no longer be checked.

## Error Handling

### The demotion, specified

*(muse M5, gpt M6.)* Revision 1 said: on `no-open-question`, deliver as an
ordinary send, record the demotion, clear `questionOpen`. Both reviewers
found the same hole - that produces two dispositions for one input id, and
`rejected` arms the input for boundary redelivery, so the demoted answer can
be delivered a second time.

Exactly one disposition is written per input id, and it is the outcome of the
whole attempt:

1. The host calls `session.answer`. It comes back rejected `no-open-question`.
2. The host does **not** record that rejection. It is an internal step, not
   an outcome.
3. The host calls `session.send` with the same id and text.
4. The disposition it records is that send's - `applied` or `rejected` - and
   nothing else.
5. `questionOpen` is cleared, because hcn has told lucid its view was wrong.

The divergence is recorded as an `error` event on the current turn, non-terminal,
naming what happened. That is the same shape RFC-03's R002 used when a resume
id was refused, and for the same reason: the log MUST say why lucid did
something other than what it was asked to.

*(gpt M6.)* `disposition.note` is not the place: it reaches the durable frame
but is absent from `TransitionRecord` and from the transcript projection, so
recording it there would be recording it where nobody looks.

### The table

| Code | Condition | Handling |
|---|---|---|
| **`answer-needs-turn`** | `mode: "answer"` with no wire-valid `turnId` | Refuse at the codec. A malformed frame, not a stale one. |
| **`answer-unsupported`** | Answer at a `headless-turn` attachment | Refuse. The window should have prevented it; the reducer refuses anyway, because a source is not the window. |
| **`stale-answer`** | Names a turn that is not the open question, or none is open, or one is already pending | Refuse. **The draft is kept.** Losing typing to a race is the worst outcome here, and a race is exactly what this is. |
| **Resending a kept draft** | The human resends after `stale-answer` | The window MUST mint a **new** input id. *(muse M4.)* Reusing the refused id draws `input-id-reused`, which would refuse the same keystrokes twice for two different reasons. |
| **`no-open-question` from hcn** | lucid's view and hcn's session diverged | The demotion above. One disposition, an `error` event, `questionOpen` cleared. The turn still happens. |
| **`input-queue-full`** | RFC-04's bound | Refuse, keep the draft, show the count. A person who cannot send should be told in the window they are typing in. |
| **Presence unavailable at start** | Another process drives this conversation | Do not start. Name the holder and say `watch` works read-only. |
| **Lease lost while running** | Taken over, or released | `FOLLOWING`. Stop accepting submissions, keep rendering, keep the draft, say the conversation moved. |
| **The terminal is not a TTY** | Piped or redirected | Render once and exit non-zero rather than painting escape codes into a file. |
| **A throw anywhere in the loop** | Any | Restore raw mode first, then propagate. A terminal left raw after a crash is the worst small bug in this RFC. |
| **Ctrl-C with a non-empty draft** | The human typed and quit | The draft is lost. It was never durable, and persisting unsent text is a decision this RFC does not make. |

## Security Considerations

The trust boundary does not move. One user, one machine, filesystem
permissions on the record.

- **A keypress is not a frame.** The draft lives in process memory and
  becomes an `input` frame only on submit, through the same validated codec
  as every other input. There is no path from a keystroke to the log that
  skips validation.
- **An answer is bounded like any input.** `isWireText` and the input bound
  from RFC-04 apply unchanged. A long paste into the box is refused at the
  same place a long `lucid send` is.
- **lucid does not compose the answer wrapper.** hcn does. lucid passing raw
  text means a human cannot craft text that lucid then formats into
  something the harness reads as instruction from elsewhere.
- **The question text is harness output.** It is rendered, never executed,
  and never interpreted as a command by lucid. It is data in a projection,
  the same as a message.
- **Holding the lease is still a kernel fact.** `chat` acquires the presence
  lock the same way `run` does, so two chats cannot drive one conversation
  even if both are started.

## Versioning

`PROTOCOL_VERSION` MUST NOT be bumped. RFC-03 established why by running it:
the fold refuses a frame whose version it does not know, so a bump does not
degrade old records, it makes every one of them unopenable.

Compatibility comes from the shape of the additions:

- `answer` is a new value in an existing enum. An older reader fails closed
  at `enumOf` with `wrong-type` - it refuses an input it cannot interpret
  rather than delivering it as a `queue`, which is the right failure.
- `stale-answer` is a new refusal issue, same treatment.
- `questionOpen` is derived state, not a stored field. An older reader folds
  the same log and simply does not track it.

A record written with answers in it is readable by a build without this RFC:
the answers fold as unknown-mode inputs and are refused, which is visible and
correct rather than silent.

## Implementation Notes

Order, each step green on its own. The first four touch no terminal.

1. **`awaiting-input` as a named cause, and `questionOpen` in the reducer.**
   Set on `question`, preserved across `done { awaiting-input }`, cleared on
   the three things R1 names. Pure and testable without a terminal.
2. **Mode validation in `enqueueInput`.** *(B4.)* Before any new mode exists,
   make the reducer refuse an unknown mode with `wrong-type`. This is the
   step that makes the compatibility claim true, and it is worth landing on
   its own so the fix is reviewable apart from the feature.
3. **`answer` mode, its three refusals, and the refusal order.** Codec cross-field
   rule, profile gate, staleness, reservation.
4. **`session.answer` gets its first caller**, with the demotion path. The
   step that makes an existing seam load-bearing.
5. **The keypress loop.** Its own module, owning raw mode and its restoration.
   MUST be injectable: tests drive it with a synthetic key source, not a pty.
6. **`lucid chat`.** Assembly of `startHeadless`, the view, the tailer and the
   loop.

Notes:

- **Use the tailer's locking read, not the viewer's.** *(muse M8.)* `watch` is
  a pure reader and tolerates a torn tail without repairing it. `chat` holds
  the lease and acts on what it reads, so it MUST take the lock-taking path.
  RFC-04's review raised this against sharing `watch.ts`; the split already
  exists in `src/store/tailer.ts` as `peek` and `read`, and `chat` uses
  `read`.
- **The draft lives in the chat process and nowhere else.** Passed into
  `buildView` on every paint, which is what the existing `draft` field is
  for. It survives a repaint and does not survive the process.
- **Do not widen `TuiView` for artifacts here.** RFC-06 will add a line kind
  that is not text. Leaving `ConversationLine` as it is keeps that a widening
  rather than a rewrite.
- **`run` and `watch` stay.** `run` is what a script uses, `watch` is what a
  second pair of eyes uses, `chat` is what a person uses.

## Open Questions

1. **Does `chat` replace `run` in the docs, or sit beside it?**
   `CONTEXT.md` teaches `run` + `watch` + `send`, which is three terminals.
   Recommend `chat` becomes the documented way in, with the others documented
   as the pieces, for scripting and for a second viewer.
   Decider: this RFC's next review.

2. **Which key interrupts a running turn?**
   `steer` exists and nothing in the terminal reaches it. Recommend a modifier
   on submit rather than a mode toggle: interrupting is a property of this
   message, not a state the human has to remember being in.
   Decider: this RFC's next review.

3. **What does answering mean for a turn-mode harness?** *(New, from B5,
   and its premise is now checked.)*
   Revision 2 first wrote this as "if hcn cannot emit `question` outside a
   session, this is moot". It can. `stream-turn.ts` emits `kind: "question"`
   the same way the session path does, so codex and muse can ask - and
   neither hcn nor lucid has anywhere to route an answer, because the process
   that asked is gone the moment the turn ends.

   So `answer-unsupported` is correct rather than merely convenient: there is
   nothing to answer *into*. What is left is a product gap this RFC should
   name rather than hide. In session mode hcn composes the wrapper, so the
   harness sees "the user answered X with Y". In turn mode the human's reply
   is an ordinary input to a fresh process that has no memory of asking, so
   the question's text has to reach the harness some other way or the reply
   is context-free.

   Options: lucid composes the wrapper for turn mode only, breaking R7 in a
   bounded way; hcn grows a way to carry an answer into a fresh turn; or the
   window simply shows the question and the human quotes what they are
   answering. The third costs nothing and is honest about who is doing the
   work.
   Criterion: whether lucid composing a prompt fragment is a line worth
   crossing for two of four harnesses.
   Decider: this RFC's next review.

4. **Should an answer render as an answer?**
   It is an input with a mode, so today it renders like any input. Recommend
   leaving it and revisiting with RFC-06, which changes what a conversation
   line can be anyway.
   Decider: RFC-06.

5. **Is `stale-answer` the right response to a pending answer?** *(New, from
   gpt M4.)* R5 refuses a second answer with `stale-answer`, but the second
   one is not stale - it is early. A distinct issue would say so. Against
   that: a fourth issue for a case the window already prevents may be
   vocabulary for its own sake.
   Decider: this RFC's next review.

## References

### Normative

- `CONTEXT.md` - what lucid is, and the two things named next.
- `docs/rfc/04_live-delivery-a-running-host-follows-its-own-log.rfc.md` -
  the executor lease, the input bound, and the boundary rule an answer
  inherits.
- `docs/rfc/03_resume-the-record-remembers-which-harness-held-the-session.rfc.md`
  - R002's hint-not-promise discipline, which `no-open-question` follows, and
  the finding that `PROTOCOL_VERSION` must not be bumped.
- `src/harness/runner.ts` - `HarnessSession.answer`, the seam this RFC gives
  its first caller.
- `src/protocol/frames.ts` - `InputMode`, `REFUSAL_ISSUES`, the codec.
- `src/protocol/reducer.ts` - `enqueueInput`, where `questionOpen` is set and
  cleared.
- `src/tui/view.ts`, `src/tui/render.ts` - `buildView`, `renderLines`, and
  the `draft` field that already exists for this.
- `src/cli/runtime.ts` - `startHeadless` and its `onStart` seam.

### Informative

- `src/protocol/events.ts` - `EventKind.question`, and why an unknown kind
  defaults to lossless.
- hcn `src/cli/session-json.ts` - the `answer` command and
  `no-open-question`; `src/interpretation/question.ts` - the block hcn parses.
- `docs/skill-chat-substrate.md` - the source contract, which this RFC
  extends and which must be updated with it.

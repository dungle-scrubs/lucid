---
number: 05
title: "One window: the conversation you can talk back to"
type: protocol
status: Draft
author: Kevin Frilot
date: 2026-08-24
---

# RFC-05: One window: the conversation you can talk back to

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

**R1 - the reducer owns whether a question is open.** `ChannelState` gains
`questionOpen`. It is set when a `question` event is accepted and cleared
when an answer is applied, when the turn that asked it is retired, or on
detach. No other component may decide this: the log is the truth and the
reducer is its only interpreter.

**R2 - an answer is an input, not a new frame.** The `input` frame's `mode`
gains `answer`. That reuses the idempotent id, the disposition lifecycle, the
replay-on-attach discipline, and the input bound - all of which an answer
needs and none of which is worth duplicating. A new frame kind would need
every one of them again.

**R3 - an answer names the question it answers.** The frame carries the
`turnId` of the question. lucid refuses an answer whose `turnId` is not the
outstanding one with `stale-answer`. Without this, an answer typed slowly and
submitted after the question was retired would be delivered as the answer to
whatever came next.

**R4 - a source MUST NOT invent the answer wrapper.** hcn composes it
(`The user answered the question: "..." with: ...`). lucid passes the raw
text to `session.answer` and lets hcn wrap it, the same discipline as never
mirroring hcn's event kinds.

## Message Formats

No new frame kinds. Two additions and one refusal.

### `input.mode` gains `answer`

```json
{ "kind": "input", "seq": 41, "id": "ans-1", "text": "Draft the RFC",
  "mode": "answer", "turnId": "turn-7" }
```

`turnId` is already an optional field on `input`. For `mode: "answer"` it is
REQUIRED and names the turn whose question is being answered.

### `attach-ok` is unchanged

An attaching source learns about an outstanding question the same way it
learns everything else: by folding the log. Adding it to `attach-ok` would
put a second source of truth beside the one the fold already gives.

### One new refusal issue

```
"stale-answer"
```

Returned when `mode: "answer"` names a turn that is not the outstanding
question, including when no question is open at all. An older reader fails
closed at `enumOf` with `wrong-type`, as with every other issue.

## State Machine

### The question

```
   none ──── question event accepted ────► open { turnId, text }
    ▲                                            │
    │  answer applied                            │
    │  asking turn retired                       │
    │  detach                                    │
    └────────────────────────────────────────────┘
```

A second `question` event while one is open REPLACES it. That is not a
merge: a harness that asks twice has changed its mind, and the newer question
is the live one. The older question's turnId then fails R3, which is correct -
an answer to a superseded question is stale.

### The chat process

```
   start
     │
     ├── controller says await-reattach ──► exit, reporting why
     │
     ├── presence lock unavailable ───────► exit, reporting who holds it
     │
     ▼
   RUNNING ── keypress ──► draft
     │  ▲                    │
     │  │                    └── submit ──► input or answer
     │  │
     │  └── log grew ──► fold ──► render
     │
     └── Ctrl-C ──► detach, release, exit
```

`chat` MUST refuse to start rather than take over a conversation another
process is driving. `watch` remains available in that case, read-only, which
is the whole reason `watch` does not gain the ability to drive: a viewer that
sometimes drives has to explain to the human which mode it is in, and the
answer changes under it when another process starts or stops.

### Submitting

| Condition | What is sent |
|---|---|
| A question is open | `input { mode: "answer", turnId }` |
| No question, no turn running | `input { mode: "queue" }`, delivered at once |
| No question, a turn running | `input { mode: "queue" }`, held to the boundary |
| No question, a turn running, and the human asked to interrupt | `input { mode: "steer" }` |

The last row needs a keybinding, not a mode change: the mode already exists.
Open Question 2 covers which key.

## Error Handling

| Code | Condition | Handling |
|---|---|---|
| **`stale-answer`** | An answer names a turn that is not the open question | Refuse. The draft is NOT lost: the box keeps the text so the human can resend it as an ordinary input. Losing typing to a race is the worst possible outcome here. |
| **`no-open-question` from hcn** | lucid thought a question was open; hcn disagrees | lucid's view of the log and hcn's view of its own session have diverged. Deliver the text as an ordinary send instead, record that it was demoted, and clear `questionOpen`. The turn still happens - the same discipline as RFC-03's R002, where a stale resume id costs context and never the turn. |
| **`input-queue-full`** | The bound from RFC-04 | Refuse, keep the draft, show the count. A person who cannot send should be told why in the window they are typing in, not by an exit code they never see. |
| **Presence unavailable at start** | Another process drives this conversation | Do not start. Say who holds it and that `watch` works read-only. |
| **Lease lost while running** | Taken over, or the lock was released | Stop driving, keep rendering, tell the human the conversation moved. Do not exit: the record is still worth reading. |
| **The terminal is not a TTY** | Piped or redirected | Render once and exit non-zero rather than painting escape codes into a file. |
| **Ctrl-C with a non-empty draft** | The human typed and quit | The draft is lost. It was never durable, and RFC-04's Open Question 4 territory - persisting it would mean writing something the human did not submit. |

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

Order, each step green on its own.

1. **`questionOpen` in the reducer.** Set on an accepted `question` event,
   cleared on answer / turn retirement / detach. No consumer yet. Pure, and
   testable without a terminal.
2. **`mode: "answer"` and `stale-answer`.** The codec, the reducer's routing,
   and the refusal. Still no terminal.
3. **`session.answer` gets its first caller.** The host routes an answer-mode
   input to `answer` instead of `send`, with the `no-open-question`
   demotion. This is the step that makes the existing seam load-bearing.
4. **The keypress loop.** A driver module that owns raw mode, assembles a
   draft, and calls back on submit. It MUST be injectable: the tests drive it
   with a synthetic key source, not a pty.
5. **`lucid chat`.** Compose `startHeadless`, the view, the tailer and the
   keypress loop. Mostly assembly.

Notes:

- **Do not widen `TuiView` for artifacts here.** RFC-06 will add a line kind
  that is not text. Leaving `ConversationLine` as it is - a kind, a text, a
  mark - keeps that a widening rather than a rewrite. Resist the temptation
  to generalise it now for a shape not yet specified.
- **Raw mode is a process-global.** Restore it on every exit path, including
  a throw. A terminal left in raw mode after a crash is the worst small bug
  in this whole RFC.
- **The paint already clears the screen** (`\x1b[2J\x1b[H`). With a live
  keypress loop it will need to not fight the cursor. This is the one place
  a live-pty check earns its cost; the deterministic tests cover `buildView`
  and `renderLines`, which is where the logic is.
- **`run` and `watch` stay.** `run` is what a script uses; `watch` is what a
  second pair of eyes uses. `chat` is what a person uses.

## Open Questions

1. **Does `chat` replace `run` in the docs, or sit beside it?**
   `CONTEXT.md` currently teaches `run` + `watch` + `send`, which is three
   terminals. Once `chat` exists that is the wrong first thing to show.
   Recommend: `chat` becomes the documented way in, and `run`/`watch`/`send`
   are documented as the pieces, for scripting and for a second viewer.
   Decider: this RFC's review.

2. **Which key interrupts a running turn?**
   `steer` exists in the protocol and nothing in the terminal reaches it.
   Options: a modifier on submit, a dedicated key, or a mode toggle shown in
   the status line. Recommend a modifier on submit, because interrupting is
   a property of *this* message rather than a mode the human has to remember
   they are in.
   Decider: this RFC's review.

3. **What happens to the draft when the view repaints?**
   The log can grow while the human is typing, and the paint clears the
   screen. The draft must survive that, which is a rendering ordering
   question rather than a protocol one. Recommend: the draft lives in the
   chat process and is passed into `buildView` on every paint, which is
   already what the `draft` field is for.
   Decider: implementation.

4. **Should an answer be visible as an answer in the transcript?**
   It is an input with a mode, so today it renders like any other input.
   Options: render it under the question it answers, mark it, or leave it.
   Recommend leaving it for now and revisiting with RFC-06, which changes
   what a conversation line can be anyway.
   Decider: RFC-06.

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

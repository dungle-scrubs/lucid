# lucid

The front door. What lucid is, the words it uses, what works today, and what
is next. Read this before `PLAN.md`, which is the delivered substrate RFC and
is now history.

## What lucid is

lucid routes a live agent conversation into a durable record, and back out to
whatever is looking at it.

An agent runs somewhere - a headless process lucid started, or a terminal
session a human owns. lucid owns the **record** of the conversation, not the
process. So the conversation outlives the process: kill the agent, reopen the
record, and the conversation is intact. Hand it to a different agent and it
continues.

That is the substrate. The product on top of it is a place to **read what an
agent produced, and mark it up** - an artifact rendered in the conversation,
annotated in the same view.

## Who it is for

One person, on one machine, working with coding agents. Not a team tool, not
a hosted service, not multi-user. That scope is a decision, not an accident:
it is what lets the filesystem be the whole transport, with no daemon, no
socket, and no server.

## The words

Take nouns from here. One name per thing.

**The record and its parts**

| Term | What it is |
|---|---|
| **conversation** | One exchange, identified by a `conversationId`, living in one directory |
| **record** | That directory: `log.ndjson`, `meta.json`, `secret`, the two locks |
| **log** | The append-only NDJSON file. The single source of truth |
| **append lock** | A `flock(2)` on the log, held for one append transaction |
| **presence lock** | A separate `flock(2)`, held for a source's whole participation. Also the executor lease |
| **executor lease** | The right to act on effects. Exactly one process holds it, kernel-elected, kernel-released on death |
| **delivery cursor** | How far a driver has got in acting on the log. Durable, written after the work |
| **transcript** | The rendered projection of the log: what a human reads |

**The protocol**

| Term | What it is |
|---|---|
| **frame** | One typed message between a source and lucid. Six go up, seven come down |
| **source** | Whatever drives a conversation: it attaches and speaks frames |
| **host** | lucid's side. Owns the log, the sequencing, and the refusals |
| **epoch** | The fencing token. A takeover increments it; frames on a dead epoch are refused `stale-epoch` |
| **lease** | Time-bounded right to be the writer. Lapses if not renewed |
| **turn** | One agent answer, identified by a `turnId` |
| **input** | Something a human said, delivered to the agent. Carries an idempotent `id` and a `mode` |
| **disposition** | What actually happened to an input: `applied`, `queued`, `rejected` |
| **event** | Agent output. `droppable` (`token`, `progress`, `context`) or `lossless` (everything else) |
| **credit** | Flow control for the droppable class only |

**The modes**

| Term | What it is |
|---|---|
| **profile** | How a source is attached: `interactive`, `headless-session`, `headless-turn` |
| **harness** | The agent CLI being driven: `claude`, `codex`, `pi`, `muse` |
| **hcn** | `harness-cli-normalizer`. One CLI over all four harnesses. A separate repo, consumed as a subprocess |
| **rung** | How much lucid can do with a session it does not own: `hooks`, `cooperative`, `observe`, in that order of preference |
| **channel status** | The derived state: `interactive-attached`, `interactive-unattached`, `agent-gone`, `headless-session`, `headless-turn` |

**The document, and marking it up**

| Term | What it is |
|---|---|
| **artifact** | A document an agent emitted, identified by an `artifactId` and kept as an ordered list of versions |
| **version** | One artifact entry: its bytes, its author (`agent` or `human`), and its hash. Never rewritten |
| **save** | A version authored by a person, recording the version it was working from. Not an input, and starts no turn |
| **annotation batch** | One or more notes, sent as a single input. Rides in the input text behind a fence, like an artifact block |
| **note** | What a person wrote, against one or more spots |
| **spot** | One place a note points: an element id, the snippet that was there, who wrote it, and how to find it again |
| **selector** | One of three ways of finding a spot after a rewrite: quote, position, path. Tried in that order |
| **orphan** | A spot whose target is gone. Shown with its note and snippet, never re-pointed |
| **document mode** | What a click in the document means: `use` operates it, `markup` selects an element to write about. Not a `profile` - that word is taken, and these are unrelated |
| **note box** | Where a note is written. Opens beside what was selected |
| **browser surface** | `lucid2 serve`: one loopback server, every record, a record chosen by URL |

**Not lucid's words.** `hcn` owns harness descriptors, capability claims, and
the shape of a harness invocation. lucid never mirrors them.

## What works today

**The substrate**, proven through every integration mode.

- A conversation survives losing its process. Reopen the record and it folds
  back intact.
- A harness recalls **its own** session across a restart. All four.
- One record can be handed between two different harnesses mid-conversation.
- A send into an already-running conversation is answered without a restart,
  however long it has been idle.
- A terminal session lucid does not own can be attached to and interjected,
  through project-scope hooks.

**The artifact layer** (RFC-06), on the browser surface.

- An agent emits a document; it renders beside the conversation, in a frame
  the page cannot reach into.
- **Two modes, because two things wanted the same click.** In *use* mode the
  document behaves as the agent built it: tick a box, fill a field, edit a
  sentence or a line of a code block. In *mark up* mode a click selects an
  element to write about and does nothing else. `⌥⌫` switches, from anywhere
  including a caret in the document.
- Click to select, command-click to select several as one selection. The note
  box opens beside what you clicked. `⌘⏎` adds the note; with no note box
  open, `⌘⏎` sends the queue.
- Notes accumulate and go as one request. They sit in the conversation in the
  order you wrote them, so a note written between two messages stays between
  them. Each carries what was on screen where it points and who wrote it.
- The agent answers by producing a new version, deciding for itself where
  the change belongs.
- Any version stays viewable, with the marks made on it and nowhere else.
- Fill in what the agent gave you and save. That is a new version authored by
  you, not a turn - and the agent is told about it on the next thing you say,
  along with the values you left in the controls.
- A note follows the document across a rewrite where it can, saying how
  confidently it re-attached; where it cannot, it says it lost its target
  and is never re-pointed at whatever took that place.
- The window says what is happening: whether a turn is running, what is
  queued, and - if the harness has answered nothing for ninety seconds -
  that it may be wedged, written into the record rather than only on screen.


Proof lives in two places: `bun run check` for the deterministic gate, and
`scripts/smoke-*.ts` for the live lanes, one per thing that can only be shown
against a real process. `AGENTS.md` lists them.

## How to use it

Build the binary once. It installs as **`lucid2`**, not `lucid` - `lucid` is
the v1 project, which is still in use and is not being retired.

```sh
bun run build          # produces dist/lucid2
```

Records live under `~/.lucid2/records`. Set `LUCID_ROOT` to put them
somewhere else. Not `~/.lucid` - that is v1's live state directory, and v1
is still in use.

One window, which is the way in:

```sh
./dist/lucid2 chat demo --harness claude
```

It drives the conversation, renders it, and reads the keyboard. Enter sends.
Alt+Enter interrupts a running turn. Ctrl+C leaves the terminal as it found
it. When the harness asks a question, answering it here sends an answer rather
than a new turn.

The document surface, which is the other way in:

```sh
./dist/lucid2 serve                        # one server, every record
```

Then open `http://127.0.0.1:17454/c/demo`. It shows the conversation, the
document beside it, and lets you mark it up. Run it beside a `chat` or a
`run` on the same record: the server never drives, it only appends.

The pieces are still separate commands, for scripting and for a second pair of
eyes:

```sh
./dist/lucid2 run demo --harness claude    # drive only; holds the terminal
./dist/lucid2 watch demo                   # render only; read-only
./dist/lucid2 send demo "your question"    # append an input from anywhere
```

`run` does not return - it drives for as long as it lives, so it is not a
command to paste in a block with others.

Two hook commands exist for a session lucid does not own - `announce` for
SessionStart and `inject` for Stop. A harness invokes them, not a person.

Without a build, every command works as `bun src/cli/main.ts <command>`.

## What is not built

- **A published package.** There is a `bin` and a build, but nothing is
  published; `bun run build` is the install.
- **A document in the terminal.** The transcript names an artifact and its
  version; it does not render one. The browser is where a document is read.
- **More than one document at a time.** The newest artifact in a record is
  the one shown.

## What is known, and deliberate

- A paragraph rewritten heavily enough is reported as having lost its
  target rather than matched. The approximate search is
  `dom-anchor-text-quote` and its threshold is not reachable through its
  API. Guessing would be worse: a wrong anchor is worse than an absent one.
- A saved version appears in the conversation in version order, not
  interleaved by time. An artifact entry carries no `seq` to interleave by,
  because the fold does not reduce artifact entries into state.

### The interface is a prototype, not a design

Nothing on the browser surface has been designed. Every layout, colour,
spacing and interaction in it was arrived at by building the behaviour and
then correcting what looked wrong, one report at a time. It works, and it is
not the design.

**Read it that way.** A future session must not defend the current
appearance as intentional, reason from it about what the product should look
like, or treat "it already looks like this" as an argument. Fix what is
broken; do not build on the styling as though it were decided.

A design pass from scratch is expected. Two things are likely to survive it:

- **assistant-ui** for the conversation. Its primitives are what the thread
  is built on, and the styled layer is this project's own because 0.10 ships
  primitives rather than a `Thread` component.
- **shadcn** for what assistant-ui does not cover. The note box is already
  Radix Popover, which is what shadcn's Popover is; the styling is this
  repo's own CSS because there is no Tailwind here to hang shadcn's classes
  on. A design pass would settle that.

Neither is a decision about how the product should look. They are the
component layer the look will be built on.

## What is next

**A design pass on the browser surface**, from scratch. See "The interface is
a prototype, not a design" above for what that means and what is expected to
survive it. Nothing about it is specified yet.

Everything RFC-06 named is delivered, and the tracker is empty. The work
since then has been correction rather than specification: defects found by
using the thing, and interaction the RFC did not cover. Two of those changed
what the agent is told, which is protocol and not decoration - a running
session now hears about a save, and every prompt carries the current version
of each artifact.

Anything larger than a correction needs an RFC before code, per the pipeline
below.

## Where authority lives

| Question | Answer |
|---|---|
| What lucid is, and what the words mean | This file |
| How to work in this repo, and how to verify | `AGENTS.md` |
| Why a thing is the way it is | `docs/decisions.md`, then the RFC that changed it |
| What is being built next | `docs/rfc/`, highest number wins |
| How a source drives a conversation | `docs/skill-chat-substrate.md` |
| What the substrate was specified to be | `PLAN.md` - delivered, kept as the RFC of record |

The pipeline is: draft-rfc, review-rfc (cross-family, excluding the family
that wrote it), draft-tickets, implement. RFCs are numbered in `docs/rfc/`.

## The constraint that shaped all of this

v1 was built outside-in: browser surface first, harness layer last, and the
harness layer carried the scars of being bolted on. v2 inverted it and held
one rule:

> No artifact, no annotation, no chrome, no browser review surface until the
> chat-routing substrate is fully tested through every integration mode. And
> "fully tested" means against failure oracles and invariants, not happy-path
> demos.

That gate is now met. It is recorded here because the reason it existed
outlives it: the substrate must never be forced to change shape to suit the
surface.

# lucid

Product scope and shared vocabulary. For commands, read [README.md](README.md).
For current contracts and active work, read [docs/README.md](docs/README.md).

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
it lets the filesystem carry the conversation without a coordinating daemon
or socket. The optional browser server reads and appends records and can
request independent local workers for accepted prompts. Workers use the
record's executor lease; the server does not drive conversations itself.

## The words

Take nouns from here. One name per thing.

**The record and its parts**

| Term | What it is |
|---|---|
| **conversation** | One exchange, identified by a `conversationId`, living in one directory |
| **record** | That directory: `log.ndjson`, `meta.json`, `driver.json`, `secret`, `files/`, the two runtime locks, and delivery state |
| **log** | The append-only NDJSON file. The truth of what happened; preferences and attachment bytes live beside it |
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
| **credit** | Flow control for the droppable class only. Shipped drivers grant none; live deltas remain unrecorded |

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
| **artifact** | The document an agent emitted, identified by an `artifactId` and kept as an ordered list of versions. One per conversation |
| **artifactId** | The name the agent gave the document. Chosen on the first emission and immutable after: annotations and revisions both point at it |
| **title** | The name a person gave the document. Displayed instead of the `artifactId` when one has been written |
| **version** | One artifact entry: its bytes, its author (`agent` or `human`), and its hash. Never rewritten |
| **save** | A version authored by a person, recording the version it was working from. Not an input, and starts no turn |
| **annotation batch** | One or more notes, sent as a single input. Rides in the input text behind a fence, like an artifact block |
| **note** | What a person wrote, against one or more spots |
| **spot** | One place a note points: an element id, the snippet that was there, who wrote it, and how to find it again. A click takes a whole element, a drag takes the words dragged over |
| **selector** | One of three ways of finding a spot after a rewrite: quote, position, path. Tried in that order |
| **orphan** | A spot whose target is gone. Shown with its note and snippet, never re-pointed |
| **document mode** | What a click in the document means: `use` operates it, `markup` selects an element to write about. Not a `profile` - that word is taken, and these are unrelated |
| **note box** | Where a note is written. Opens beside what was selected |
| **browser surface** | `lucid2 serve`: one loopback server, every record, a record chosen by URL |
| **driver preference** | `driver.json`, beside `meta.json`. The harness, provider, model and effort a person chose in the browser. Written by the server; honored at the next queue-input boundary. An idle steer or answer stays on the driver in force. Never in the log |

**Not lucid's words.** `hcn` owns harness descriptors, capability claims, and
the shape of a harness invocation. lucid never mirrors them.

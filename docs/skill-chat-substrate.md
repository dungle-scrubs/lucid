# Skill: driving a lucid chat conversation

You are a **source** attaching to a lucid conversation. lucid owns the
durable log and is the single sequencing authority; you speak a small,
typed frame protocol to it. This skill is the whole contract - an agent
that reads only this can drive a conversation correctly.

## The one rule: exactly one writer

A conversation has **exactly one active writer at a time**, enforced by an
`epoch` fencing token, not by convention. Everything else follows from
this.

- lucid assigns you an `epoch` when you attach. Every post-attach frame
  you send carries it.
- A takeover (someone else attaching after your lease lapses) **increments
  the epoch**. From that instant, every frame you send on your old epoch is
  refused `stale-epoch` - you have been fenced. Stop writing and re-attach.
- You cannot take over a live writer. Attaching while another writer's
  lease is valid is refused `lease-held`.

## Attaching

Send `attach { conversationId, profile, secret, version, resumeFrom? }`:

- `secret` - read it from the conversation record's `secret` file (mode
  0600). Possession of read access IS your authorization. A wrong secret
  is refused `auth-failed`; a wrong conversation `wrong-conversation`; an
  unsupported `version` `version-unsupported`.
- `profile` - `interactive` (a human-owned process), `headless-session`
  (a lucid-owned persistent process), or `headless-turn` (one process per
  turn).
- `resumeFrom` - the last lucid `seq` you durably applied. lucid replies
  `attach-ok { epoch, lease, replayFrom, version }`; `replayFrom` is the
  exclusive watermark - lucid re-delivers everything after it, so you
  never double-apply. Claiming a `resumeFrom` ahead of the log is refused
  `resume-ahead-of-log`.

A headless source may not steal an interactively-held conversation while
the human process is alive: that attach is refused `presence-holds`. Wait
for a re-attach or for the process to exit.

## Sending events

Stream the harness's output as `event { epoch, n, turnId, event }`:

- `n` - your **per-epoch** monotonic counter, starting at 1, +1 per event.
  A gap is refused `gap-n`; a repeat `dupe-n`. Resend in order.
- `turnId` - unique within the conversation; a reused id is refused
  `turn-id-reused`. Mint a fresh one per turn.
- Event **classes** decide flow control. `token`, `progress`, `context`
  are **droppable** - lucid grants `credit { tokens }` for them, and a
  droppable event sent with no credit is refused `no-credit`. Under
  starvation, **coalesce** droppables latest-wins per turn and resend when
  credit arrives. `identity`, `message`, `tool`, `limit`, `error`, `done`
  are **lossless** - never gated, never dropped.

## Receiving input

lucid delivers human input as `input { seq, id, text, mode }`. `mode` is
what lucid **requests** (`queue` or `steer`); what actually happened is
the `disposition` you send back:

- `disposition { epoch, inputId, outcome: applied | queued | rejected }`.
- `applied` - you acted on it (delivered into the turn). `queued` - held
  for a boundary. `rejected` - you could not; it returns to lucid's queue
  and is redelivered, **never dropped**.
- In `headless-turn`, a turn in flight is never interjected: input
  `queue`s between turns. `steer` is only legal where the profile allows
  it - a steer at a `headless-turn` attachment is refused.

## Leaving

- `detach { epoch, reason: yield | shutdown }` at a turn boundary. A clean
  `yield` is the polite handoff; `shutdown` says the process is done.
- `heartbeat { epoch }` while idle keeps your lease alive. Miss it long
  enough and your lease lapses, making you takeover-eligible.
- `ack { epoch, covers }` claims durable delivery through lucid `seq`
  `covers`, so lucid can trim its replay buffer. `acked` only moves
  forward.

## Capabilities - declare the source, never guess

At attach, query the active harness's capabilities and pass them through
**with their source**: `runtime-verified` (the registry confirmed the
model), `curated` (a descriptor default), or `unknown` (degrade - no
streaming/vision claims). Declaring a capability through the skill is not
verification; the `source` field is how a reader knows which it is.

## The interactive ladder (truthfully)

For a human-owned process, capability degrades in a strict order:

1. **hooks** - observe transcript messages, inject at tool boundaries,
   lucid-aware attach via SessionStart. Needs `--setting-sources project`
   and `HERDR_ENV` unset for the child.
2. **cooperative** - the agent polls a drop file (wait-poll delivery).
3. **observe** - tail only; queued input surfaces as a resume
   instruction, never injected.

Pick the highest rung the environment supports; fall back honestly.

## Refusals are the signal

Every refusal names its `issue` from a closed set and **never
half-applies** the frame. Read the issue, fix the cause, resend. The
named issues you will meet: `auth-failed`, `wrong-conversation`,
`version-unsupported`, `resume-ahead-of-log`, `lease-held`,
`presence-holds`, `not-attached`, `stale-epoch`, `future-epoch`, `gap-n`,
`dupe-n`, `turn-id-reused`, `input-id-reused`, `unknown-input`,
`no-credit`, `invalid-grant`, `invalid-input`, `steer-unsupported`,
`covers-ahead-of-log`, `wrong-direction`.

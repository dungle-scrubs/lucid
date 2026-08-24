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

Send `attach { conversationId, profile, secret, version, harness?, resumeFrom? }`:

- `secret` - read it from the conversation record's `secret` file (mode
  0600). Possession of read access IS your authorization. A wrong secret
  is refused `auth-failed`; a wrong conversation `wrong-conversation`; an
  unsupported `version` `version-unsupported`.
- `profile` - `interactive` (a human-owned process), `headless-session`
  (a lucid-owned persistent process), or `headless-turn` (one process per
  turn).
- `harness` - which harness you drive: `claude`, `codex`, `pi`, or `muse`.
  A headless profile MUST send it; omitting it is refused `invalid-grant`.
  An interactive attach SHOULD NOT send one and is not refused for it -
  lucid ignores the field there, because an interactive session is not a
  harness lucid can reopen, and storing the id would put a session in the
  record that no source may resume. A name outside the four fails at the
  codec as `wrong-type`, so a typo never reaches the reducer.
- `resumeFrom` - the last lucid `seq` you durably applied. lucid replies
  `attach-ok { epoch, lease, replayFrom, version, resumeSessionId? }`.
  `replayFrom` echoes
  your `resumeFrom` as the exclusive watermark for the **event render**:
  read the durable event stream and resume after that seq. Claiming a
  `resumeFrom` ahead of the log is refused `resume-ahead-of-log`.
- **Input replay is NOT resumeFrom-based.** lucid re-delivers every input
  it has not durably applied on attach, regardless of seq or your
  `resumeFrom` - so you MUST dedupe delivered `input.id`s durably and
  apply each at most once. `resumeFrom` scopes event rendering; the
  idempotent `id` scopes input application. Do not conflate them.

### Continuing the harness session you last held

`attach-ok` carries `resumeSessionId` when this record already holds a
session for **your** harness. Open your harness against that session
instead of a fresh one, and the conversation keeps its own memory across
your process dying.

Two things make it safe to use and safe to ignore:

- It is scoped to the harness you named on attach. A record whose newest
  session belongs to a different harness is ordinary - cross-harness
  handoff is supported - so the absence of the field means "none of
  yours", not "none at all". Never resume a session id you did not get
  back for your own harness.
- **It is a hint, not a promise.** The session may be gone, or the harness
  may refuse it. Try it once; if the harness rejects it, run the same
  input fresh and record why. A stale hint costs the harness's context,
  never the turn.

A headless source may not steal a conversation that a live human process
holds - whether it is interactively attached OR never attached (a fresh
record with a live human process) - while presence corroborates that
process alive: the attach is refused `presence-holds`. Wait for a
re-attach or for the process to exit.

## Sending events

Stream the harness's output as `event { epoch, n, turnId, event }`:

- `n` - your **per-epoch** monotonic counter, starting at 1, +1 per event.
  A gap is refused `gap-n`; a repeat `dupe-n`. Resend in order.
- `turnId` - unique within the conversation; a reused id is refused
  `turn-id-reused`. Mint a fresh one per turn.
- Event **classes** decide flow control. `token`, `progress`, `context`
  are **droppable** - lucid grants `credit { epoch, tokens }` for them,
  and a droppable event sent with no credit is refused `no-credit`.
  `identity`, `message`, `tool`, `limit`, `error`, `done` are **lossless**
  - never gated, never dropped.
- **Coalescing under starvation, exactly:** keep at most one pending
  droppable per **(turnId, kind)** - latest-wins, so a turn can hold one
  pending `token` AND one `progress` AND one `context` at once, not one
  total. When you send a **lossless** event for a turn, it **supersedes
  and clears** that turn's pending droppables (the message carries the
  whole text - a stale `token` must never land after it). Resend the
  surviving pending droppables, under their own turnId, when credit
  arrives.

## Receiving input

lucid delivers human input as `input { seq, id, text, mode }`. It may
arrive at any time, including from a process other than the one you are
talking to - a conversation can be written to while you drive it, and
lucid delivers what it finds. Nothing about that changes your side of the
contract; it only means input is not confined to the moments you expect. `mode` is
what lucid **requests** (`queue` or `steer`); what actually happened is
the `disposition` you send back:

- `disposition { epoch, inputId, outcome: applied | queued | rejected }`.
- `applied` - you acted on it (delivered into the turn). `queued` - held
  for a boundary. `rejected` - you could not; it returns to lucid's queue
  and is redelivered, **never dropped**.
- **`queue` waits for the turn boundary; `steer` and `answer` do not.** An input in
  `queue` mode that arrives while a turn is running is held and delivered
  when that turn produces its terminal event. A `steer` or `answer` goes through
  at once - an answer exists to unblock a turn, so holding it until that
  turn ends is a deadlock. With no turn running, a `queue` input is delivered straight
  away - holding it for a boundary that will never come is a hang, not a policy.
- In `headless-turn` there is nothing to interject or answer into: one process per
  turn means every input already waits for a boundary and there is no session to
  answer into. `steer` and `answer` are only legal where the profile allows it; a
  steer at a `headless-turn` attachment is refused `steer-unsupported`, an answer
  `answer-unsupported`. Fall back to `queue`.
- An `answer` MUST carry the `turnId` of the question it answers; missing or
  non-wire-valid `turnId` is refused `answer-needs-turn` at the codec as a malformed
  frame, not as `stale-answer`. A stale answer (wrong question) is refused
  `stale-answer` by the reducer when a question is no longer open.
- The boundary for a live human process is the same idea by a different
  route: the Stop hook fires at one, which is why the headless and
  interactive paths agree on when an interjection lands.

lucid bounds the input direction itself: a conversation holds at most 8
delivered-but-unfinished inputs, and a send past that is refused
`input-queue-full` at lucid's own boundary - never against a frame you
sent. Finish turns and the bound reopens. The issue is in the `refused`
vocabulary, so decode it like any other rather than crashing on it.

## Leaving

- `detach { epoch, reason: yield | shutdown }` at a turn boundary. A clean
  `yield` is the polite handoff; `shutdown` says the process is done.
- `heartbeat { epoch }` while idle keeps your lease alive. Miss it long
  enough and your lease lapses, making you takeover-eligible.
- `ack { epoch, covers }` claims durable delivery through lucid `seq`
  `covers`, so lucid can trim its replay buffer. `acked` only moves
  forward.

## The full frame set

You have now seen all six source→lucid frames: `attach`, `event`, `ack`,
`disposition`, `heartbeat`, `detach`. lucid replies with seven
lucid→source frames - you RECEIVE these, never send them (a lucid→source
kind arriving AT lucid is refused `wrong-direction`):

- `attach-ok { epoch, lease: { expires, renewEvery }, replayFrom, version, resumeSessionId? }`
- `refused { issue }` - a named refusal (below), never a half-applied frame
- `event-ack { epoch, n }` - your event `n` is durable; trim your replay buffer to it
- `input { seq, id, text, mode, turnId? }` - human input to deliver
- `control { seq, action: pause | end | switch-path }` - a conversation control
- `lease { epoch, expires }` - a lease renewal grant
- `credit { epoch, tokens }` - flow credits for the droppable class only

## Capabilities - declare the source, never guess

Capabilities are carried on the **`identity` event** you emit at the start
of a session (not an attach field): `{ sessionId, authority,
capabilities: { …, source, confidence } }`. Query the active harness and
pass them through **with their source**: `runtime-verified` (the registry
confirmed the model), `curated` (a descriptor default), or `unknown`
(degrade - no streaming/vision claims, `confidence: none`). Declaring a
capability through the skill is not verification; the `source` field is
how a reader knows which it is.

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
half-applies** the frame. The right response depends on the class - "fix
the cause and resend" is NOT universal:

- **Re-attach, do not resend** - the epoch you hold is dead:
  `stale-epoch`, `future-epoch`, `not-attached`. Re-run the attach
  handshake to get a current epoch.
- **Do not retry as-is** - the attach itself is rejected: `auth-failed`,
  `wrong-conversation`, `version-unsupported`, `presence-holds`,
  `lease-held`. Fix the identity/secret/version, or wait (lease-held,
  presence-holds) - retrying the same attach immediately just refuses
  again.
- **Fix and resend the same frame** - a sequencing/validation problem:
  `gap-n` / `dupe-n` (resend in order), `resume-ahead-of-log`,
  `covers-ahead-of-log`, `invalid-input`, `answer-needs-turn`,
  `turn-id-reused` (mint a fresh id), `input-id-reused`, `unknown-input`,
  `steer-unsupported` (fall back to `queue`), `answer-unsupported`,
  `stale-answer`.
- **Back off, then resend** - `no-credit`: coalesce and wait for a
  `credit` grant.
- **A bug, never expected** - `wrong-direction`: you sent a lucid→source
  kind; do not.

The reducer's refusal issues (above) are the ones your frames can draw.
Before a frame decodes at all, a malformed wire line draws a **decode**
issue instead - `not-json`, `not-a-frame`, `unknown-kind`,
`missing-field`, `wrong-type`, `not-serializable`, `answer-needs-turn` - both sets arrive as
`refused { issue }`, so handle either.

---
number: 04
title: "Live delivery: a running host follows its own log"
type: protocol
status: Draft
author: Kevin Frilot
date: 2026-08-23
---

# RFC-04: Live delivery: a running host follows its own log

> Renders decisions `D-006` and `D-007` of the `01-piping` plan, which were
> ratified and then deferred by `D-011` of that same plan. Their text and
> reasoning are in `docs/decisions.md`. This RFC does not re-open them. It
> specifies what they left unspecified, reconciles them with three changes
> that landed after they were written, and adds one bound they never had.

## Abstract

`lucid send` reaches a record. It does not reach a running host. A host folds
its log once at start and never looks again, so an input appended by another
process waits for the next `lucid run` - "you have new mail, restart to see
it". This RFC makes a live host follow its own log: it tails the record, folds
new bytes under the append lock, and delivers newly accepted inputs through the
same path an attach replay takes. Delivery ownership moves with it, because a
durable log converges state but does not elect who runs the side effects: the
presence lock becomes the executor lease, and only its holder dispatches. The
guarantee is durable at-least-once with idempotent dedup, not exactly-once.
Finally it bounds the input direction, which today has no bound at all.

## Introduction

### The problem

A conversation record is a durable append-only log with a single append lock.
Any process may append to it. Exactly one process at a time drives a harness
against it, holding the presence lock.

Those two facts do not currently meet. `src/store/conversation-host.ts:172`
dispatches a reduce result's effects in whichever process produced them:

```ts
const result = log.append((s) => { ... });
for (const effect of result.effects) deps.onEffect(effect);
```

When `lucid send` appends an input, it produces a `send` effect for that input
and hands it to its own `onEffect`, which is `() => {}` in
`src/cli/send.ts`. The frame is durable. The effect is dropped on the floor of
a process that exits a millisecond later. The running host, which owns the
harness and could act on it, never learns the frame exists.

This is the delivery-ownership gap `D-007` names: byte ordering is not
side-effect ownership.

### What this is worth

Three of the four things lucid does already work across processes. A record
survives its host dying. A successor folds it and takes over. A different
harness can take over. The gap is the fourth: talking to a conversation that is
already running. That is the difference between a batch tool - queue, run, read
- and a chat.

Live delivery into a **human's** interactive session already works, through the
Stop hook (`lucid inject`), which blocks the harness into continuing with the
pending input. This RFC is about the headless case only.

### Scope

In scope:

- A live host follows its own log and delivers newly accepted inputs.
- Only the presence-lock holder dispatches effects.
- A persisted delivery cursor, giving at-least-once with dedup.
- A bound on the input direction.

Out of scope, and each for a reason already recorded:

- **A socket or FIFO transport.** Rejected permanently by `D-006`, not
  deferred. It creates a second source of truth - durability in the log,
  liveness in the socket, free to disagree on death - and smuggles back the
  daemon lifecycle question. The log is the one channel.
- **A long-running daemon.** A later layer. Because the log is the single
  channel and every process folds it, a daemon is "just a participant that is
  always on", and nothing here depends on it.
- **Remote attach.** Needs out-of-band secret provisioning and a transport.
  Nothing in this RFC precludes it; the frames are transport-neutral.
- **Multi-user access.** One user, one machine, as `01-piping` scoped it.
- **Exactly-once delivery.** `D-006` settles this: the crash-between-deliver-
  and-ack window is unclosable. At-least-once with idempotent dedup is the
  guarantee, and the reducer's input ids already carry the idempotency.

### What changed since D-006 and D-007 were written

Those decisions describe a codebase that has since moved three times, and each
move makes this easier rather than harder.

1. **The harness seam** (RFC-02). lucid drives `hcn` as a subprocess through
   `HarnessRunner`. Effect dispatch no longer has to know what a harness is.
2. **Harness attribution and resume** (RFC-03). `ChannelState.harnessSessions`
   records which harness held which session, and attach reports it. A host
   that reattaches mid-conversation resumes the right session.
3. **The attach-replay drain.** `src/modes/host.ts` now drains
   `sequencer.attachReplay` through `receive` at attach. Live delivery is that
   same hop made continuous, so this RFC adds a caller to an existing path
   rather than a new path.

`D-007` sized itself at "~40 lines against the reducer, no new
conversation-state machine". That estimate predates all three. It still looks
close for the dispatch rule, and understates the tailer.

## Terminology

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be
interpreted as described in RFC 2119.

- **Record.** A conversation's directory: `log.ndjson`, `meta.json`, the
  append lock, the presence lock.
- **Append lock.** The `flock(2)` on the log, held for the duration of one
  append transaction. Serializes writers.
- **Presence lock.** A separate `flock(2)`, held for the lifetime of a source's
  participation. Today a liveness signal. This RFC makes it also the executor
  lease.
- **Executor lease.** The right to dispatch effects. Held by exactly one
  process, kernel-elected on acquire, revoked on death.
- **Live host.** A process holding the presence lock and driving a harness.
- **Tailer.** The part of a live host that watches its own log for growth.
- **Catch-up fold.** Reducing log bytes after the last folded offset into
  current state. Already implemented, under the lock, in
  `ConversationLog.append`.
- **Delivery cursor.** The offset up to which a live host has dispatched
  effects. Distinct from the fold offset, which says what it has *read*.
- **Outstanding input.** An input accepted into the log and not yet answered
  with an applied disposition.

## Protocol Overview

Two processes, one record.

```
  lucid send                          lucid run (live host)
  ----------                          ---------------------
                                      holds presence lock
                                      folded to offset F, cursor at C
  take append lock
  catch-up fold
  reduce: input accepted
  append line at offset F
  produce effects
  DO NOT dispatch  <--- new           tailer sees log grow
  release append lock                 take append lock
                                      catch-up fold to F'
                                      collect effects for entries in (C, F']
                                      advance cursor to F'
                                      release append lock
                                      dispatch collected effects
                                        -> receive(inputFrame)
                                        -> strategy.onInput(id, text)
                                        -> harness turn
```

Three rules carry it.

**R1 - the host follows its own log.** A live host MUST tail its record and
perform a catch-up fold when the log grows. It MUST NOT rely on another
process to push to it. `fs.watch` with a polling fallback is the mechanism;
`src/cli/watch.ts` already implements exactly this and MUST be the shared
implementation rather than a second copy.

**R2 - only the lease holder dispatches.** A process that does not hold the
presence lock MUST NOT dispatch effects. It still appends, and its reduce still
produces effects; those effects are discarded by the producer and rediscovered
by the holder during its catch-up fold. A process holding the presence lock
MUST dispatch effects for every entry between its delivery cursor and its fold
offset, in log order.

**R3 - the cursor is persisted and advances under the lock.** The delivery
cursor MUST be advanced inside the same append-lock section that performed the
fold, and it MUST be durable. A host that dies after dispatching but before
advancing redelivers on restart. That is the at-least-once window, and it is
intentional.

### Why dedup already works

Redelivery is safe because the reducer already made input delivery idempotent
for the attach-replay case, and it is the same case:

- Every input carries a caller-minted id.
- `enqueueInput` refuses a reused id with `input-id-reused`.
- An applied input leaves `ChannelState.inputs` for `appliedInputs`, and a
  disposition against an applied input is a no-op
  (`src/protocol/reducer.ts:615`).

So a redelivered input either finds itself already applied and does nothing, or
was never applied and is delivered. No new dedup machinery is required. This is
the single largest reason `D-007` could size itself at 40 lines.

## Message Formats

This RFC adds no new frame kinds and changes no existing frame's meaning. Two
additions:

### The cursor record

The delivery cursor MUST be durable. It is written as a log entry rather than a
sidecar file, so that it is ordered against the frames it describes and cannot
disagree with them after a crash.

```json
{ "src": "cursor", "offset": 20481, "conversationId": "chat", "at": 1755950400000 }
```

`src` is a new value in the log entry union (`LogEntry`, `src/store/log.ts:48`),
not a new frame. A fold MUST treat a `cursor` entry as state for the tailer and
MUST NOT feed it to `reduce`. An older lucid reading a newer log skips it: the
fold already carries unknown entries rather than throwing, the same discipline
`decodeHarnessLine` applies to unknown hcn event kinds.

Recording the cursor as a log line means the log grows on every dispatch batch.
Open question 3 covers whether that is acceptable or wants compaction.

### The input-queue refusal

One new value in `REFUSAL_ISSUES` (`src/protocol/frames.ts:65`):

```
"input-queue-full"
```

Returned by `enqueueInput` when the outstanding-input count is at the bound.
See State Machine below.

## State Machine

### The live host

```
   start
     |
     v
  FOLDING ---- controller says await-reattach ----> AWAITING (exit, no lease)
     |
     | acquires presence lock (= executor lease)
     v
  LEADING <-------------------+
     |  ^                      |
     |  | log grew             | dispatch complete
     |  |                      |
     |  +-- CATCHING-UP -------+
     |         (append lock held: fold, collect, advance cursor)
     |
     | presence lock lost / released / process dies
     v
  RELEASED (kernel-released on death)
```

`FOLDING` and `AWAITING` exist today. `LEADING` is today's steady state with a
tailer added. `CATCHING-UP` is new and is the only state that holds the append
lock.

A host MUST NOT dispatch while in `CATCHING-UP`. Collect under the lock,
dispatch after releasing it. Dispatching under the append lock would let a
harness write - which appends - deadlock against the lock its own dispatch
holds.

### The input bound

This is the part `D-006` and `D-007` do not cover, because it did not exist
when they were written.

`enqueueInput` today validates the id, refuses a reuse, and refuses a steer on
a profile that cannot take one. It never consults depth
(`src/protocol/reducer.ts:700`). `InputLedger.queueDepth` counts outstanding
inputs and is written into `TransitionRecord` for the log; nothing reads it to
refuse anything.

That was harmless while hcn held a queue: hcn answered `queued` and held the
input until the turn boundary, so a backlog sat visible in `state.inputs`. hcn
ADR 0007 removed that queue. A send is now written to the harness's stdin
immediately and answered `started`, the input moves to `appliedInputs`, and
`queueDepth` drains to zero and stays there. The backlog moved to hcn's
unbounded `pendingIds` array and the harness process's stdin buffer, where
lucid cannot see it. Detail in `docs/reports/hcn-adr-0007-and-the-input-bound.md`.

Today only lucid's own pump writes, one input per turn, so the gap is not
reachable. Live delivery introduces the first writer that can outrun a harness,
which is why the bound belongs in this RFC and not a later one.

Proposed:

- `INPUT_QUEUE_MAX` bounds outstanding inputs per conversation, named beside
  `DROPPABLE_QUEUE_MAX` in `src/protocol/events.ts`.
- `enqueueInput` MUST refuse with `input-queue-full` when accepting would
  exceed it.
- `lucid send` MUST report the refusal and exit non-zero. A send that cannot be
  taken must fail loudly at the sender, not silently at the log.

The bound is refusal, not blocking. A blocking `lucid send` would hold the
append lock while waiting on a harness, which stalls every other writer
including the host trying to drain the queue. Refusal keeps the lock hot and
pushes the decision to the caller.

The value is Open Question 1.

## Error Handling

| Code | Condition | Handling |
|---|---|---|
| **E006 double-or-zero-dispatch** | Two processes dispatch the same effect, or neither does | Prevented by R2. Only the presence-lock holder dispatches; the lock is kernel-elected, so it cannot be held twice, and it is kernel-released on death, so it cannot be held by a corpse. This is the error `01-piping` recorded as returning with live delivery. |
| **Redelivery after a crash** | Host dies between dispatch and cursor advance | Expected, not an error. Dedup by input id makes it a no-op. This is the at-least-once window `D-006` declares unclosable. |
| **`input-queue-full`** | Outstanding inputs at `INPUT_QUEUE_MAX` | `enqueueInput` refuses. `lucid send` reports it and exits non-zero. The record is unchanged. |
| **Torn tail during a tail read** | Tailer reads while another process is mid-append | Already handled. `ConversationLog.view()` tolerates a torn trailing line without repairing; the catch-up fold under the lock sees the repaired file. The tailer MUST use the lock-taking path for anything it acts on, and MAY use `view()` only to decide whether to bother. |
| **Cursor ahead of fold offset** | A cursor entry names an offset past the log's good bytes | Corrupt. The host MUST refuse to lead and MUST report it, rather than reset the cursor and risk re-running side effects from an unknown point. |
| **Presence lock lost while leading** | Another process took over, or the lock was released | The host MUST stop dispatching immediately and MUST NOT advance the cursor. It transitions to `RELEASED`. |
| **Tailer starvation** | Log grows faster than the host can fold | Bounded by `INPUT_QUEUE_MAX` on the input side. Events are already bounded by the credit ledger on the output side. |

Two existing refusals now become reachable across processes rather than only
within one, and their handling is unchanged: `presence-holds` and `lease-held`.

## Security Considerations

The trust boundary does not move. Everything here is same-machine, same-user,
and mediated by filesystem permissions on the record directory - the model
`01-piping` established and this RFC inherits.

- **The record secret** still authenticates attach. A tailing host does not
  weaken it: the tailer reads frames that were already accepted into the log by
  a process that presented the secret. Acceptance is the authentication point,
  and it is unchanged.
- **The executor lease is a kernel object, not a claim.** `flock(2)` cannot be
  forged by writing a file, cannot be held by two processes, and is released by
  the kernel when the holder dies. This is why `D-007` chose it and why
  `01-piping` rejected an O_EXCL pid-liveness lockfile: that reimplements
  process lifetime in userspace and inherits pid reuse and stale-steal unlink
  races that corrupt the source of truth.
- **A tailer widens what one process reads.** A live host now reads log lines
  written by other processes at arbitrary times, where before it read only its
  own attach fold. The frames were already validated at append. The tailer MUST
  NOT trust an entry's contents any further than the fold already does, and
  MUST NOT dispatch an effect derived from an entry the reducer refused.
- **The cursor is not a trust boundary.** It says how far this host has
  dispatched. A wrong cursor causes redelivery, which dedup absorbs, or a
  refusal to lead. It never grants anything.
- **No new process is spawned and no new port, socket, or file descriptor is
  exposed.** The rejection of the socket transport keeps the attack surface at
  the filesystem.

## Versioning

`PROTOCOL_VERSION` MUST NOT be bumped.

This was tested rather than assumed, during RFC-03: the fold refuses a frame
whose version it does not know, so a bump does not degrade old records - it
makes every existing record unopenable. That finding is recorded in RFC-03 and
holds here.

Compatibility comes from the shape of the additions instead:

- The `cursor` log entry is a new `src` value. A fold that does not know it
  skips it, the way `decodeHarnessLine` carries an unknown hcn event kind.
- `input-queue-full` is a new refusal issue. An older reader decoding it fails
  closed at `enumOf` with `wrong-type`, which is a refusal to act on a value it
  does not understand - the correct behaviour for a refusal it cannot interpret.
- No frame gains a required field.

A record written by a host with live delivery is readable by one without it.
The reverse is also true: a host with live delivery reading a record that has
no cursor entry starts its cursor at zero and redelivers outstanding inputs,
which dedup absorbs.

## Implementation Notes

Suggested order, each step independently green.

1. **Extract the tailer from `src/cli/watch.ts`.** It already does `fs.watch`
   plus a poll fallback plus re-fold. Lift it to a shared module so `watch` and
   `run` use one implementation. No behaviour change; `watch` is the regression
   test.
2. **Split effect production from effect dispatch** in
   `src/store/conversation-host.ts:172`. Introduce the lease check. A process
   without the lease produces and discards. This step alone is observable:
   `lucid send` stops dispatching into a no-op sink, which changes nothing
   today and is the precondition for everything after.
3. **Add the cursor entry and advance it under the lock.** Still no tailing -
   the cursor just tracks what the existing single-shot dispatch already did.
4. **Wire the tailer into `startHeadless`** (`src/cli/runtime.ts`), which today
   folds once and does not tail. Dispatch collected effects through the
   `receive` path that `src/modes/host.ts` already drains at attach.
5. **Add `INPUT_QUEUE_MAX` and the refusal.** Independent of 1-4 and could land
   first.

Notes:

- **The two locks must not nest in both orders.** A host in `CATCHING-UP` holds
  the append lock; it must not wait on the presence lock there. Acquire
  presence first, for the process lifetime, then take the append lock per
  transaction. That is already the order `startHeadless` uses.
- **Latency is a non-issue and should not be engineered for.** `D-006` records
  the reasoning: same-machine, single-user, so `fs.watch` and poll latency do
  not matter. `watch.ts` uses a 500ms poll fallback. Reuse it. Do not add a
  tighter loop.
- **The deterministic test surface is the oracle.** Two in-process hosts on one
  temp record, an injected clock, and the fake hcn process prove ordering,
  dedup, and the lease rule without a live model. The live lanes confirm
  afterward; they do not gate. This is `AGENTS.md`'s standing rule.
- **A two-process integration test already exists in shape.**
  `test/store/m13-writer-child.ts` drives a real second process against a real
  `flock`. The lease rule wants the same treatment.

## Open Questions

1. **What is `INPUT_QUEUE_MAX`?**
   Options: (a) 256, matching `DROPPABLE_QUEUE_MAX`, on the grounds that one
   named bound is easier to reason about than two; (b) something much smaller,
   say 8, on the grounds that outstanding *inputs* are a human-scale quantity
   and 256 queued prompts is never a state anyone wanted; (c) configurable per
   conversation.
   Criterion: the bound exists to make backpressure visible before a harness
   stalls, not to maximise throughput. Recommend (b) with a low value. A source
   that hits it has a bug or a runaway loop, and finding that out at 8 is
   better than at 256.
   Decider: this RFC's review.

2. **Does a non-leader ever need to know its effects were discarded?**
   Today `lucid send` produces a `send` effect and drops it, and after R2 it
   drops it deliberately. If a send should report "queued, and a live host will
   pick it up" versus "queued, nothing is running", it needs to read the
   presence lock. That is a read-only probe and cheap.
   Criterion: whether the CLI's output is meant to be actionable. Recommend
   yes - the difference between "it will be answered" and "run `lucid run` to
   get an answer" is the whole of what a user wants to know.
   Decider: this RFC's review.

3. **Does the cursor entry need compaction?**
   Writing a cursor line per dispatch batch grows the log in proportion to
   traffic, not to conversation content. Options: (a) accept it, log growth is
   already unbounded by design; (b) write the cursor only when it advances past
   a threshold, accepting more redelivery after a crash; (c) keep the cursor in
   `meta.json` instead, accepting that it can then disagree with the log after
   a crash.
   Criterion: (c) reintroduces the two-sources-of-truth problem `D-006`
   rejected the socket for, so it should lose on the same grounds. Recommend
   (a) until a record gets large enough to measure.
   Decider: this RFC's review.

4. **Should the tailer deliver mid-turn, or only at a turn boundary?**
   hcn writes a mid-turn send straight to the harness's stdin and answers
   `started`, so mid-turn delivery is possible. Whether it is wanted is a
   product question: an input arriving mid-turn interrupts a running answer.
   `lucid inject` on the interactive path delivers at a boundary because the
   Stop hook fires there, not by choice.
   Criterion: consistency between the two paths matters more than either
   answer. Recommend boundary-only for a first landing, with mid-turn behind
   the existing `mode: "steer"` input mode, which already exists and already
   means exactly this.
   Decider: this RFC's review.

## References

### Normative

- `docs/decisions.md` - `01-piping` `D-006` (host follows its own log),
  `D-007` (the flock is the executor lease), `D-011` (the deferral this RFC
  ends). Their full text and reasoning.
- `docs/rfc/02_consume-the-normalizer-through-hcn.rfc.md` - the harness seam
  effects are dispatched into.
- `docs/rfc/03_resume-the-record-remembers-which-harness-held-the-session.rfc.md`
  - harness attribution, and the finding that `PROTOCOL_VERSION` must not be
  bumped.
- `src/store/conversation-host.ts:160-174` - `transact`, where effect dispatch
  happens today.
- `src/store/log.ts` - `ConversationLog.append`, the catch-up fold under the
  lock; `goodBytes()`; the `LogEntry` union.
- `src/protocol/reducer.ts` - `enqueueInput`, `appliedInputs`, the
  idempotent-id discipline dedup rests on.
- `src/cli/watch.ts` - the tailer to extract.

### Informative

- `docs/reports/hcn-adr-0007-and-the-input-bound.md` - why the input direction
  has no bound, and why `queueDepth` no longer measures what its name says.
- hcn ADR 0007 - hcn normalizes interfaces and supervises one process;
  anything across a process boundary is the caller's job. The reason the queue
  removal is lucid's problem to absorb.
- `git log -- .plans/` - the superseded planning artifacts, including the
  `01-piping` RFC whose Alternatives section holds the rejected forks in full.

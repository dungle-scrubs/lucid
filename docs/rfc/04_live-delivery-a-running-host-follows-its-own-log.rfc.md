---
number: 04
title: "Live delivery: a running host follows its own log"
type: protocol
status: Draft
author: Kevin Frilot
date: 2026-08-23
---

# RFC-04: Live delivery: a running host follows its own log

> **Revision 2.** Answers
> `04_live-delivery-a-running-host-follows-its-own-log.review-draft-2026-08-23.md`,
> two independent cross-family reviews (`muse-spark-1.2-contributor@muse`,
> `gpt-5.6-sol@codex`). Four blocking findings, all accepted, all verified
> before acceptance. What changed, one line each:
>
> - **B1** The cursor cannot be a new log-entry `src`: the fold rejects an
>   unknown source as `corrupt-log`, it does not skip it. The fold is widened
>   first, as a prerequisite step, and the compatibility claim is corrected to
>   one-way.
> - **B2** Dedup by input id does not cover redelivery, because redelivery
>   goes through `receive`, not `enqueueInput`. `D-007`'s effect-id at the
>   harness boundary is restored - revision 1 had silently dropped it.
> - **B3** The overview advanced the cursor before dispatch, which is
>   at-most-once, contradicting R3. Dispatch now precedes the advance, in a
>   second lock section.
> - **B4** `INPUT_QUEUE_MAX` bounded `queueDepth`, which reads zero however
>   deep the real backlog is. The quantity to bound is redefined, and the
>   metric fix is a prerequisite rather than an open question.
>
> Six majors and five minors are folded in below and marked where they land.
>
> Renders decisions `D-006` and `D-007` of the `01-piping` plan, ratified and
> then deferred by `D-011` of that same plan. Their text is in
> `docs/decisions.md`. This RFC does not re-open them; revision 2 restores one
> requirement of `D-007` that revision 1 lost.

## Abstract

`lucid send` reaches a record. It does not reach a running host. A host folds
its log once at start and never looks again, so an input appended by another
process waits for the next `lucid run`. This RFC makes a live host follow its
own log: it tails the record, folds new bytes under the append lock, and
delivers newly accepted inputs. Delivery ownership moves with it, because a
durable log converges state but does not elect who runs the side effects: the
presence lock becomes the executor lease, and only its holder dispatches. The
guarantee is durable at-least-once with dedup at the harness boundary, not
exactly-once. It also bounds the input direction, which today has no bound,
and fixes the gauge that was supposed to measure it.

## Introduction

### The problem

A conversation record is a durable append-only log with a single append lock.
Any process may append. Exactly one process at a time drives a harness against
it, holding the presence lock.

Those two facts do not meet. `src/store/conversation-host.ts:172` dispatches a
reduce result's effects in whichever process produced them:

```ts
const result = log.append((s) => { ... });
for (const effect of result.effects) deps.onEffect(effect);
```

When `lucid send` appends an input, it produces a `send` effect and hands it to
its own `onEffect`, which is `() => {}` in `src/cli/send.ts`. The frame is
durable. The effect is dropped in a process that exits a millisecond later. The
running host, which owns the harness, never learns the frame exists.

This is the delivery-ownership gap `D-007` names: byte ordering is not
side-effect ownership.

### What this is worth

Three of the four things lucid does already work across processes: a record
survives its host dying, a successor folds it and takes over, and a different
harness can take over. The gap is the fourth - talking to a conversation that
is already running. That is the difference between a batch tool and a chat.

Live delivery into a **human's** interactive session already works, through the
Stop hook (`lucid inject`). This RFC is the headless case only.

### Scope

In scope:

- A live host follows its own log and delivers newly accepted inputs.
- Only the presence-lock holder dispatches effects.
- A persisted delivery cursor, giving at-least-once with dedup.
- A bound on the input direction, and a gauge that measures it.

Out of scope, each for a recorded reason:

- **A socket or FIFO transport.** Rejected permanently by `D-006`, not
  deferred. It creates a second source of truth - durability in the log,
  liveness in the socket, free to disagree on death - and smuggles back the
  daemon lifecycle question. The log is the one channel.
- **A long-running daemon.** A later layer. Because the log is the single
  channel and every process folds it, a daemon is a participant that is always
  on, and nothing here depends on it.
- **Remote attach.** Needs out-of-band secret provisioning and a transport.
  Nothing here precludes it; the frames are transport-neutral.
- **Multi-user access.** One user, one machine, as `01-piping` scoped it.
- **Exactly-once delivery.** `D-006` settles it: the
  crash-between-deliver-and-ack window is unclosable.

### What changed since D-006 and D-007 were written

Those decisions describe a codebase that has moved three times.

1. **The harness seam** (RFC-02). lucid drives `hcn` through `HarnessRunner`.
   Effect dispatch no longer has to know what a harness is.
2. **Harness attribution and resume** (RFC-03). A host that reattaches
   mid-conversation resumes the right session.
3. **The attach-replay drain.** `src/modes/host.ts` drains
   `sequencer.attachReplay` through `receive` at attach.

`D-007` sized itself at "~40 lines against the reducer, no new
conversation-state machine". Revision 1 repeated that estimate. The review
showed why it is wrong: there is no seam that folds a byte range and returns
its effects, so the estimate omits the operation this RFC is mostly about.
Treat it as retired, not as a target.

## Terminology

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be
interpreted as described in RFC 2119.

- **Record.** A conversation's directory: `log.ndjson`, `meta.json`, the
  append lock, the presence lock.
- **Append lock.** The `flock(2)` on the log, held for one append transaction.
- **Presence lock.** A separate `flock(2)`, held for the lifetime of a
  source's participation. Today a liveness signal; this RFC also makes it the
  executor lease.
- **Executor lease.** The right to dispatch effects. Held by one process,
  kernel-elected on acquire, kernel-released on death.
- **Live host.** A process holding the presence lock and driving a harness.
- **Tailer.** The part of a live host that watches its own log for growth.
- **Catch-up fold.** Reducing log bytes after the last folded offset.
- **Delivery cursor.** The offset up to which a live host has *finished*
  dispatching. Distinct from the fold offset, which says what it has read.
- **Effect id.** A stable identifier for one side effect, derived from the
  entry that produced it, used to dedup at the harness boundary. Required by
  `D-007`.
- **In-flight input.** An input delivered to a harness whose turn has not
  produced a terminal event. The quantity the input bound bounds.

## Protocol Overview

Two processes, one record.

```
  lucid send                          lucid run (live host)
  ----------                          ---------------------
                                      holds presence lock
                                      folded to F, cursor at C
  take append lock
  catch-up fold
  reduce: input accepted
  append line at offset F
  produce effects
  DO NOT dispatch  <--- R2            tailer sees log grow
  release append lock
                                      LOCK: catch-up fold to F'
                                      LOCK: collect effects for (C, F']
                                      LOCK: release
                                      dispatch, deduped by effect id
                                      LOCK: advance cursor to F'
                                      LOCK: release
```

Three rules.

**R1 - the host follows its own log.** A live host MUST tail its record and
catch-up fold when the log grows. It MUST NOT rely on another process to push
to it. `fs.watch` with a polling fallback is the mechanism;
`src/cli/watch.ts` already implements it and SHOULD be extracted rather than
copied. The extraction MUST NOT hand the leader `watch.ts`'s lock-free
`view()` path for anything it acts on: `view()` tolerates a torn tail without
repairing it. A tailer MAY use `view()` only to decide whether to take the
lock, and MUST revalidate under the lock before dispatching. *(review M-minor,
muse F7.)*

**R2 - only the lease holder dispatches.** A process that does not hold the
presence lock MUST NOT dispatch effects. It still appends, and its reduce still
produces effects; the producer discards them and the holder rediscovers them
during its catch-up fold. A process holding the presence lock MUST dispatch
effects for every entry between its delivery cursor and its fold offset, in log
order.

**R3 - the cursor advances after dispatch, never before.** *(B3.)* The cursor
MUST be advanced only after every effect in the batch has been dispatched, in a
second append-lock section. A host that dies mid-batch redelivers the whole
batch on restart. That is the at-least-once window, and it is the reason R4
exists.

Revision 1 had the cursor advance inside the fold's lock section, before
dispatch. That is at-most-once: a crash in the gap loses effects permanently
and the successor's cursor says they ran. It contradicted this same rule's
prose. The diagram above is the corrected order.

**R4 - dedup happens at the harness boundary, by effect id.** *(B2, restoring
`D-007`.)* Every dispatched effect MUST carry an effect id derived from the
log entry that produced it - the entry's byte offset is sufficient and is
already unique and ordered. A live host MUST record dispatched effect ids
durably and MUST NOT re-dispatch an id it has already recorded.

### Why input-id idempotency is not enough

Revision 1 claimed dedup needed no new machinery, on two grounds: `enqueueInput`
refuses a reused id, and an applied input moves to `appliedInputs` where a
further disposition is a no-op. Both are true and neither applies.

Redelivery does not call `enqueueInput`. It calls `receive`
(`src/modes/host.ts:388`), which hands `id` and `text` to `strategy.onInput`
with no id check. And an id reaches `appliedInputs` only when the `applied`
disposition becomes durable (`src/protocol/reducer.ts:636`).

So the exact crash this RFC names as its window - input delivered, turn opened,
disposition not yet durable - leaves the input `outstanding` in `ChannelState`.
The successor folds it, sees it outstanding, and sends it to the harness again.
The session strategy's `applied` bookkeeping lives in `HostContext.expected`,
which is process memory and dies with the process. A reviewer ran the real host
through this path twice with the same input and got two turns.

`D-007` required an effect-id at the harness boundary for exactly this reason.
Revision 1 replaced it with reducer-level idempotency, which is a strictly
later boundary, and then claimed to render the decision faithfully. R4 puts it
back.

## Message Formats

This RFC adds no new frame kinds and changes no existing frame's meaning.

### The cursor entry, and why it needs a prerequisite

*(B1.)* The delivery cursor MUST be durable and MUST be ordered against the
frames it describes, so it is a log entry rather than a sidecar file. A sidecar
reintroduces the two-sources-of-truth problem `D-006` rejected the socket for.

```json
{ "v": 1, "at": 1755950400000, "src": "cursor", "offset": 20481 }
```

Revision 1 claimed an older reader would skip this, "because the fold already
carries unknown entries rather than throwing". **That is false.** That
discipline lives in `src/harness/events.ts`, for hcn's event kinds. The log
fold does not have it: `ENTRY_SOURCES` is `["frame", "input", "credit"]`
(`src/store/log.ts:69`), `validEntry` returns false for anything else, and
`foldLog` throws `corrupt-log`. Run against both entries:

```
cursor entry: FOLD THREW -> malformed log entry at byte 0
credit entry: FOLD THREW -> log entry at byte 0 refused on fold (not-attached)
```

The control is the point. A known entry reaches the reducer and is refused for
a protocol reason. The cursor entry never reaches it - it fails structurally,
as corruption. Revision 1's example also omitted `v: 1`, so it did not even
satisfy the envelope.

Two consequences, both normative.

**Prerequisite P1.** The fold MUST tolerate an unrecognised `src` before any
cursor is ever written. `validEntry` accepts the envelope (`v`, `at`, `src`)
and `applyEntry` skips a source it does not know, counting its bytes as good.
This is the discipline `decodeHarnessLine` already applies, moved to the place
that needed it. It ships as its own change, with its own test, and no cursor
is written until it has.

**The compatibility claim is one-way, not bidirectional.** Even with P1, a
reader built *before* P1 still throws on a cursor line. There is no way to make
an additive log vocabulary readable by a reader that predates the tolerance -
that is the same lesson RFC-03 learned about `PROTOCOL_VERSION`, in a different
place. Revision 1 claimed bidirectional compatibility; it is unobtainable.

Accepting it is a judgment about deployment, and it should be stated rather
than hidden: lucid is a single-user local tool with no released versions and no
deployed old readers. The cost of the one-way break is a stale checkout, fixed
by pulling. If that ever stops being true, the cursor needs a different home.

**Torn cursor lines.** A torn trailing cursor sits *behind* `goodBytes` and is
truncated by the repair path (`src/store/log.ts:317-323`). A lost cursor
reads as a cursor further back, which redelivers, which R4 absorbs. Losing a
cursor is safe; the Error Handling table covers the unsafe direction.
*(review minor, muse F9.)*

### The dispatched-effect record

R4 needs dispatched ids to be durable. They are the same entry:

```json
{ "v": 1, "at": 1755950400000, "src": "cursor", "offset": 20481 }
```

The cursor *is* the dedup record. Every effect from an entry at or before
`offset` has been dispatched. An effect id is the producing entry's offset, so
"have I dispatched this id" is "is its offset at or below my cursor". No second
structure is needed, which is what makes R4 cheap.

The residual duplicate window is one batch: effects dispatched after the last
cursor write and before the crash. That window is bounded by how often the
cursor advances, which is Open Question 2.

### The input-queue refusal

One new value in `REFUSAL_ISSUES` (`src/protocol/frames.ts:65`):

```
"input-queue-full"
```

An older reader decoding it fails closed at `enumOf` with `wrong-type`, which
is the correct behaviour for a refusal it cannot interpret.

## State Machine

### The live host

```
   start
     |
     v
  FOLDING --- controller says await-reattach --> AWAITING (exit, no lease)
     |
     | acquirePresence (blocks, up to 30s)
     |
     +--- LockError / timeout ------------------> CONTENDING (exit, reports)
     |
     v
  ATTACHING --- sequencer throws lease-held ----> CONTENDING (release presence)
     |
     | attach accepted
     v
  LEADING <----------------------+
     |  ^                         |
     |  | log grew                | cursor advanced
     |  |                         |
     |  +-- CATCHING-UP --> DISPATCHING
     |        (lock held)      (no lock held)
     |
     | presence lost / released / death
     v
  RELEASED (kernel-released on death)
```

*(M3.)* `CONTENDING` and `ATTACHING` are new. Revision 1 went straight from
acquiring presence to `LEADING`, which assumed presence ownership proves attach
succeeded. It does not. A second host blocks in `acquirePresence` for up to 30s
and can fail with `LockError` (`src/store/flock.ts:111-160`) before any reducer
attach happens. If it acquires presence after a release while the protocol lease
is still live, `createSequencer` throws `lease-held`
(`src/modes/sequencer.ts:89-103`). A host that reaches `CONTENDING` from
`ATTACHING` MUST release the presence lock before exiting; holding a lease it
cannot attach behind blocks the rightful leader.

`CATCHING-UP` is the only state holding the append lock. A host MUST NOT
dispatch there: a harness write appends, and it would deadlock against the lock
its own dispatch holds. Collect under the lock, dispatch outside it, then
retake the lock to advance the cursor.

### Losing the lease mid-dispatch

*(M2.)* `DISPATCHING` holds no lock, so the lease can be lost inside it. A host
MUST check `held()` between effects and MUST stop before the next one. It MUST
NOT advance the cursor after a loss; the successor redelivers the batch and R4
dedups it.

What this cannot promise: an effect already handed to the harness is not
recallable. Session delivery schedules `opening.then(session.send)` and returns
(`src/modes/host.ts:117-138`); releasing the presence lock cancels nothing, and
`PresenceHandle.held()` is a local boolean flipped by `release()`
(`src/store/presence.ts:27-48`), not a kernel notification. So the guarantee is
**no new dispatch after the lease is lost**, not "no dispatch in flight".

Revision 1's E006 row claimed double dispatch was prevented outright. That was
stronger than the mechanism. R4 is what makes the residual overlap harmless.

*(M2, second half.)* R2 cannot be enforced by reading `HostDeps.presence`,
which today means the ps-level interactive-process probe, not flock ownership.
The lease check MUST read the presence handle the runtime holds. Decode
refusals dispatched outside `transact`
(`src/store/conversation-host.ts:204-217`) are local answers to a malformed
frame, not conversation effects, and are exempt.

### The input bound

*(B4.)* Revision 1 proposed bounding `InputLedger.queueDepth`. That gauge
counts inputs whose status is exactly `outstanding`
(`src/protocol/ledgers/input.ts:17`). Since hcn ADR 0007, an accepted send is
answered `started` at once and the input leaves `inputs` for `appliedInputs`,
so the gauge reads zero however deep the real backlog is. A reviewer pushed 100
inputs through and got `queueDepth: 0` with all 100 applied. A bound on a gauge
that is always zero never trips.

My own report already said `queueDepth` "no longer measures what its name
says", and revision 1 proposed bounding on it anyway.

**Prerequisite P2.** Name and measure the right quantity first. The backlog
that matters is **in-flight inputs**: delivered to a harness, no terminal event
for their turn yet. lucid can see both ends - it dispatches the input and it
folds the `done` event - so this is measurable in the reducer without hcn
telling it anything. `InputLedger` gains that count. `queueDepth` keeps its
current meaning and its current name, because it is still the right number for
"awaiting a disposition"; it is simply not the backlog.

Then:

- `INPUT_QUEUE_MAX` bounds in-flight inputs per conversation, named beside
  `DROPPABLE_QUEUE_MAX` in `src/protocol/events.ts`.
- `enqueueInput` MUST refuse with `input-queue-full` when accepting would
  exceed it.
- `lucid send` MUST report the refusal and exit non-zero.

Refusal, not blocking. *(M5.)* Revision 1 justified this by claiming a blocking
send would hold the append lock while waiting on a harness. That is false:
`log.append` releases before `enqueueInput` returns
(`src/store/log.ts:428-433`), so a blocking send would wait outside the lock.
The real argument is simpler. `INPUT_QUEUE_MAX` is a policy on durable state,
and a blocking `lucid send` has no caller to wait on - it is a short-lived
process invoked from a shell, and a shell that hangs is worse than one that
says no.

## Error Handling

| Code | Condition | Handling |
|---|---|---|
| **E006 double-or-zero-dispatch** | Two processes dispatch the same effect, or neither does | Zero-dispatch is prevented: the lease is kernel-elected and kernel-released, so it cannot be held by a corpse. Double-dispatch is *bounded*, not prevented - an in-flight async send survives lease loss (see State Machine). R4's effect-id dedup makes the overlap harmless. |
| **Redelivery after a crash** | Host dies between dispatch and cursor advance | Expected. Bounded to one batch. Deduped by effect id under R4. This is the at-least-once window `D-006` declares unclosable. |
| **`input-queue-full`** | In-flight inputs at `INPUT_QUEUE_MAX` | `enqueueInput` refuses. `lucid send` reports and exits non-zero. The record is unchanged. |
| **Torn tail during a tail read** | Tailer reads while another process is mid-append | `view()` tolerates a torn trailing line without repairing; the fold under the lock sees the repaired file. The tailer MUST revalidate under the lock before dispatching (R1). |
| **Torn cursor line** | A cursor entry is truncated by repair | Safe. Reads as an earlier cursor, redelivers, R4 dedups. |
| **Cursor ahead of fold offset** | A cursor names an offset past `goodBytes` | Corrupt. The host MUST refuse to lead and MUST report it, rather than reset and re-run side effects from an unknown point. |
| **Presence lock lost while leading** | Another process took over, or it was released | Stop before the next effect. MUST NOT advance the cursor. Transition to `RELEASED`. In-flight sends are not recallable. |
| **`LockError` acquiring presence** | Another host holds it past the retry window | Transition to `CONTENDING` and exit reporting it. Do not force. |
| **`lease-held` on attach** | Presence acquired but the protocol lease is still live | Transition to `CONTENDING`, release the presence lock, exit reporting it. |
| **Tailer starvation** | Log grows faster than the host folds | Bounded on the input side by `INPUT_QUEUE_MAX`, and for droppable events by the credit ledger. *(M6.)* **Not bounded** for lossless events, which are never gated by design, nor for cursor traffic. Revision 1 claimed the two ledgers covered it; they do not. Left unbounded knowingly: a lossless event is produced by a turn lucid itself started, so its rate is bounded by the harness, not by a remote writer. |

## Security Considerations

The trust boundary does not move. Same-machine, same-user, mediated by
filesystem permissions on the record directory.

- **The record secret** still authenticates attach. A tailing host reads frames
  already accepted into the log by a process that presented the secret.
  Acceptance is the authentication point and is unchanged.
- **The executor lease is a kernel object, not a claim.** `flock(2)` cannot be
  forged by writing a file, cannot be held twice, and is released by the kernel
  when the holder dies. This is why `D-007` chose it, and why `01-piping`
  rejected an O_EXCL pid-liveness lockfile, which reimplements process lifetime
  in userspace and inherits pid reuse and stale-steal unlink races.
- **A tailer widens what one process reads.** A live host now reads lines
  written by other processes at arbitrary times. Those frames were validated at
  append. The tailer MUST NOT trust an entry further than the fold does, and
  MUST NOT dispatch an effect derived from an entry the reducer refused.
- **An unknown log entry is skipped, not executed.** P1 makes the fold tolerant
  of an unrecognised `src`. Tolerant means ignored: it counts the bytes and
  moves on. It MUST NOT dispatch anything for an entry it does not understand.
- **The cursor is not a trust boundary.** A wrong cursor causes redelivery,
  which R4 absorbs, or a refusal to lead. It grants nothing.
- **No new process, port, socket, or descriptor.** Rejecting the socket
  transport keeps the surface at the filesystem.

## Versioning

`PROTOCOL_VERSION` MUST NOT be bumped. RFC-03 tested this rather than assuming
it: the fold refuses a frame whose version it does not know, so a bump does not
degrade old records, it makes every one of them unopenable.

Frame-level compatibility holds. No frame gains a required field, and
`input-queue-full` is a new refusal issue that an older reader fails closed on.

**Log-entry compatibility does not hold, and revision 1 was wrong to claim it
did.** See Message Formats: even with P1, a reader predating P1 throws on a
cursor line. The break is one-way and accepted, because there are no released
versions and no deployed old readers. Ordering matters: P1 ships first, and no
cursor is written until it has.

## Implementation Notes

Suggested order. P1 and P2 are prerequisites and are independent of each other.

1. **P1 - make the fold tolerant of an unknown entry source.** `validEntry`
   checks the envelope; `applyEntry` skips an unrecognised `src` and counts its
   bytes good. Its own change, its own test. No cursor exists yet.
2. **P2 - measure in-flight inputs.** Add the count to `InputLedger`. Leave
   `queueDepth` alone. Its own change.
3. **Add `INPUT_QUEUE_MAX` and the refusal**, on top of P2. Independent of
   everything below.
4. **Extract the tailer from `src/cli/watch.ts`** so `watch` and `run` share
   one implementation. No behaviour change; `watch` is the regression test.
5. **Add the log seam the RFC actually needs.** *(M1.)* This is the step
   revision 1 omitted. `foldLog` computes each entry's `ReduceResult`, uses it
   for state and transcript, and discards the effects
   (`src/store/log.ts:213-252`). `ConversationLog.append` returns only its own
   new-entry closure's result, with no per-entry offsets. So "split effect
   production from dispatch in `conversation-host.ts`" is not sufficient -
   there is nowhere to split. `ConversationLog` needs a method that folds a
   byte range under the lock and returns the batch with each effect's producing
   offset. Everything else here is small; this is not.
6. **Gate dispatch on the lease** in `src/store/conversation-host.ts`, reading
   the runtime's presence handle rather than `HostDeps.presence`.
7. **Add the cursor entry**, on top of P1 and step 5.
8. **Wire the tailer into `startHeadless`** (`src/cli/runtime.ts`), dispatching
   through the `receive` path `src/modes/host.ts` already drains at attach.
   *(review minor.)* Note that drain runs once at construction, after
   `strategy` exists; continuous delivery needs the construction order restated,
   not just an extra caller.
9. **Carry `mode` through `receive`.** *(M4.)* `receive` passes only `id` and
   `text` to the strategy (`src/modes/host.ts:387-391`), and the session
   strategy calls `session.send` immediately for every input. Boundary-only
   delivery needs the mode carried and a drain event defined. See Open
   Question 3.

Notes:

- **Lock order.** Acquire presence first, for the process lifetime; take the
  append lock per transaction. A host in `CATCHING-UP` holds the append lock
  and MUST NOT wait on presence there. `startHeadless` already uses this order.
- **Latency is a non-issue.** `D-006` records why: same-machine, single-user.
  `watch.ts` uses a 500ms poll fallback. Reuse it; do not add a tighter loop.
- **The deterministic surface is the oracle.** Two in-process hosts on one temp
  record, an injected clock, the fake hcn process. Live lanes confirm
  afterward and do not gate. `test/store/m13-writer-child.ts` already drives a
  real second process against a real `flock`; the lease rule wants the same.

## Open Questions

1. **What is `INPUT_QUEUE_MAX`, once P2 defines the quantity?**
   Options: (a) 256, matching `DROPPABLE_QUEUE_MAX`; (b) small, around 8;
   (c) configurable per conversation.
   Revision 1 recommended (b) and both reviewers said the number cannot be
   chosen before the metric exists - which P2 now provides. With in-flight
   inputs as the quantity, (b) is defensible on its own terms: in-flight means
   sent to a harness and not yet finished, and a human never has 8 of those.
   Recommend (b), decided after P2 lands and can be measured.
   Decider: implementation, once P2 is real.

2. **How often does the cursor advance?**
   It bounds the duplicate window: everything dispatched since the last cursor
   write is redelivered after a crash. Per batch is simplest and makes the
   window one batch. Less often means fewer log lines and a wider window.
   Criterion: R4 makes duplicates harmless, so this trades log growth against
   redundant work after a crash, not against correctness. Recommend per batch
   until a record grows large enough to measure.
   Decider: this RFC's next review.

3. **Mid-turn or boundary-only delivery?**
   hcn writes a mid-turn send straight to the harness's stdin, so mid-turn is
   possible. Revision 1 recommended boundary-only with mid-turn behind
   `mode: "steer"`, on the grounds the mode already exists. It exists in the
   frame and never reaches the strategy (M4), so either answer costs the same
   plumbing.
   Criterion: consistency with the interactive path, which delivers at a
   boundary because the Stop hook fires there. Recommend boundary-only, with
   `steer` carried through as the mid-turn escape.
   Decider: this RFC's next review.

4. **Should a non-leader report that nothing is running?**
   `lucid send` could probe the presence lock and tell the user whether a live
   host will pick the input up. Both reviewers noted the probe is racy: the
   lock may be held by a dying process whose harness is still draining.
   Recommend yes, stated as informational only - the difference between "it
   will be answered" and "run `lucid run` to get an answer" is most of what a
   user wants - and never as a delivery guarantee. The durable log remains the
   source of truth.
   Decider: this RFC's next review.

5. **What triggers a fold?** *(review minor, muse F8.)* An `fs.watch` event, a
   poll tick, or an explicit signal on `append.ok`. Revision 1 named the
   mechanism but not the trigger. Recommend event-or-poll only, with no
   cross-process signalling, since a signal is the socket argument again in a
   smaller form.
   Decider: this RFC's next review.

## References

### Normative

- `docs/rfc/04_...review-draft-2026-08-23.md` - the two cross-family reviews
  this revision answers.
- `docs/decisions.md` - `01-piping` `D-006`, `D-007`, `D-011`.
- `docs/rfc/02_consume-the-normalizer-through-hcn.rfc.md` - the harness seam.
- `docs/rfc/03_resume-the-record-remembers-which-harness-held-the-session.rfc.md`
  - harness attribution, and the finding that `PROTOCOL_VERSION` must not be
  bumped.
- `src/store/log.ts` - `LogEntry`, `ENTRY_SOURCES`, `validEntry`, `applyEntry`,
  `foldLog`, `ConversationLog.append`, the repair path at 317-323.
- `src/store/conversation-host.ts:160-174` - `transact`, where dispatch happens.
- `src/store/presence.ts` - `acquirePresence`, `PresenceHandle.held`.
- `src/store/flock.ts:111-160` - the retry window and `LockError`.
- `src/protocol/reducer.ts` - `enqueueInput`, `appliedInputs`, disposition.
- `src/protocol/ledgers/input.ts` - `queueDepth`, and where P2 lands.
- `src/modes/host.ts:387-391` - `receive`, and the mode it drops.
- `src/modes/sequencer.ts:89-115` - attach effects read off the reduce result.
- `src/cli/watch.ts` - the tailer to extract.

### Informative

- `docs/reports/hcn-adr-0007-and-the-input-bound.md` - why the input direction
  has no bound, and why `queueDepth` no longer measures what its name says.
- hcn ADR 0007 - hcn supervises one process; anything across a process
  boundary is the caller's job.
- `git log -- .plans/` - the superseded planning artifacts, including the
  `01-piping` RFC whose Alternatives section holds the rejected forks in full.

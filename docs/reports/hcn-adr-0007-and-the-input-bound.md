# hcn ADR 0007: what lucid had to change, and the one thing it exposed

Date: 2026-08-23. Against hcn 0.5.6, lucid at `chore/follow-hcn-queue-removal`.

ADR 0007 settles what hcn is: it normalizes harness interfaces and supervises
**one** process. Anything that spans process boundaries is the caller's job.
Its queue was the last thing in it that spanned one, and it is gone.

## The three items verified

### 1. hcn no longer has a queued disposition

Confirmed. `SessionSendResult.disposition` is `"started" | "rejected"`
(`src/execution/open-session.ts:51`). No occurrence of `"queued"` survives in
hcn's `src`. Evidence rung 2, read at the type.

### 2. What a mid-turn send does now

This is the part that matters, and it is not "hcn refuses it".

`send` writes the text to the harness's stdin **immediately**, whether or not
a turn is open (`open-session.ts:696-723`). When a turn was already running it
pushes the id onto `pendingIds` and still answers `started`. So:

- the input reaches the harness at once, not at the turn boundary
- hcn tags a later turn with that id when the boundary comes
- lucid is told `started` either way

Evidence rung 3, traced through `send` into `writeUser` and `pendingIds`.

### 3. lucid's change was one line, and one line more

The line predicted at `host.ts:118` was real: the `started ? "applied" :
"queued"` ternary had a dead arm. Removing it is the whole behavioural change.

What the prediction missed is that `hcn-runner.ts` was **casting** the wire
value into lucid's `Disposition` (`e.disposition as Disposition`). Narrowing
the type without touching the cast would have left a future third disposition
being read as one of the two lucid knows - marking a turn started that never
opened, and stranding the pump on events that never arrive. The cast is now a
narrow that refuses the unknown value and names it in the reason.

Two tests also encoded the old sequence and were rewritten to the real one.

## The read that was asked for: does the credit ledger bound suffice?

**No, and it was never the bound in question.** The two things are in
different directions.

- The **credit ledger** bounds droppable events flowing **out** of the
  harness toward a source, clamped at `DROPPABLE_QUEUE_MAX`
  (`src/protocol/ledgers/credit.ts`). It is a render-drain gate. It has
  nothing to say about inputs.
- **Inputs flowing in have no gate at all.** `enqueueInput`
  (`reducer.ts:~700`) validates the id, refuses a reuse, and refuses a steer
  on a profile that cannot take one. It never consults depth.
  `InputLedger.queueDepth` counts inputs still `outstanding` and is written
  into `TransitionRecord` for the log. Nothing reads it to refuse anything.

Evidence rung 2 for both: read at every call site of `queueDepth` in `src`.

### What ADR 0007 changed about that

Before, the gauge accidentally worked. hcn answered `queued` and held the
input until the boundary, so a backlog sat visible in lucid's `inputs` list
as queued entries, and `queueDepth` reported something real.

Now hcn answers `started` as fast as it can write a line. The input moves
straight to `appliedInputs` and leaves `inputs`. `queueDepth` drains to zero
and stays there. It no longer measures harness backlog; it measures the
round-trip latency of a disposition, which is microseconds.

The backlog did not disappear. It moved to two places lucid cannot see:

1. hcn's `pendingIds` array, which has no bound
2. the harness process's own stdin buffer, which has an OS bound and blocks
   the writer when it fills

So the failure mode is not a queue overflowing. It is an unbounded array in
hcn plus a `write()` that eventually blocks, with lucid's gauge reading zero
throughout.

### Whose problem this is

lucid's, by the ADR 0007 scope test. hcn supervises one process and answers
for one send; deciding whether a caller should be sending at all is a
cross-boundary policy, which is exactly what the ADR pushes to the caller.
Filing it against hcn would be asking for the queue back.

It is also **not urgent**, and this report is not a request to fix it now.
The only writer today is lucid's own headless pump, which sends one input per
turn. The gap is reachable when Workstream B lands live delivery into a
running host and a source can send faster than a harness consumes. That is
the moment an input-side bound has to exist, and it should be specified with
Workstream B rather than bolted on before there is a writer that needs it.

What should not happen in the meantime is anyone reading `queueDepth` off a
transition record and believing it. It reports a real number about a
quantity that no longer means what its name suggests.

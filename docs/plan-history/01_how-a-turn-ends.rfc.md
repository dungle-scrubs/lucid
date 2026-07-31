---
number: 01
title: "How a turn ends"
type: protocol
status: Draft
author: Kevin Frilot
date: 2026-07-31
---

# RFC-01: How a turn ends

## Abstract

A **turn** begins when feedback reaches an agent, and the log records that: the
agent appends an **ack**. Nothing records the turn stopping. `foldLog` opens the
working window on any ack and closes it only on a **version**, an `agent_reply`,
or a `question` - so a turn that produces none of the three never closes its
window. The viewer already softens the wording after ten minutes, to "agent
picked up your feedback Nm ago · no response yet", but softening is not
closing: an approved, finished review keeps saying "no response yet" for the
life of the session, beside a header that reads `approved`.

This RFC specifies a turn's end as a recorded fact. It adds one log event,
`agent_turn_ended`, and - because Lucid permits two agents on one artifact - a
**turn identity** the fold can match terminators against. It makes the next
`wait` the primary way a cooperative turn ends, since that costs an agent
nothing to remember, and demotes an explicit verb to optional annotation. It
does not attempt to make the uncooperative case disappear: an agent that is
killed appends nothing, and the existing stale state remains the answer to that.

## Introduction

### Problem

`foldLog` derives the working window from four events
(`src/core/fold.ts:400-421`):

```
agent_ack                   -> workingSince ??= e.at
version | agent_reply |
question                    -> workingSince = null
```

Every other way a turn can finish leaves the window open:

| How the turn ended | Log shows | Viewer shows |
|---|---|---|
| Produced a version or a reply | a closer | window closes - correct |
| Read the feedback, decided nothing was needed | last ack | working, then "no response yet", forever |
| Answered in its own terminal, never touching Lucid | last ack | working, then "no response yet", forever |
| Hit its usage limit and stood down | last ack | working, then "no response yet", forever |
| Crashed, was killed, or the machine slept | last ack | working, then "no response yet", forever |

Five of six rows are identical, which is the tell: the viewer is not reading a
signal, it is failing to find one.

### What already exists

Three mechanisms already cover parts of this, and the RFC builds on them rather
than around them:

- **The viewer already degrades.** `WORKING_STALE_MS` is ten minutes
  (`client/chrome/Thread.tsx:186`); past it the line becomes "agent picked up
  your feedback Nm ago · no response yet". Its own comment names the case: "it
  can miss work by a crashed agent, which is exactly what the stale state is
  for." This RFC does not add a degrade. It makes the degrade terminal-aware.
- **The hub already knows.** `attend.ts:771` computes
  `ourDeadClaim = !inFlight && ownClaimSeq !== 0 && deliveredThroughSeq === ownClaimSeq`.
  The fact exists; it is confined to the attend engine's spawn decision, never
  reaches the fold, and does not survive a hub restart.
- **Harnesses already publish liveness.** `presence.ts` carries idle/busy, and
  the session host polls and broadcasts it (`session-host.ts:1280`).

### Scope

**In scope.** One new log event and its meaning; a turn identity the fold can
match against; who ends a turn in each of the two ways turns are driven; how
`foldLog` consumes the event without disturbing delivery accounting or `wait`;
the migration for logs written before this RFC.

**Out of scope.** Killing or timing out a running turn - a turn genuinely still
working MUST NOT be interrupted by this mechanism. Changing what an ack means.
Changing `wait`'s blocking semantics beyond excluding one event from the wake
set. Plan 07 #18 (which `intent` a turn claims) - that is about the label, not
about stopping.

## Terminology

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY in this document are
to be interpreted as described in RFC 2119.

- **Turn** - one agent invocation against an artifact, from the moment feedback
  reaches the agent to the moment it stops (CONTEXT.md).
- **Turn id** - an opaque identifier for one turn, minted by whoever starts it.
- **Ack** - an `agent_ack` event; the agent saying it has this feedback.
- **Working window** - the interval the viewer paints as "the agent is
  working", derived by `foldLog`.
- **Terminator** - an event that closes a working window.
- **Hub-spawned turn** - a turn the hub started in attend mode and whose child
  process it holds.
- **Interactive turn** - a turn a human drives in a terminal; Lucid observes it
  and does not own it.

## Protocol Overview

```
HUB-SPAWNED (attend)                 INTERACTIVE (human's terminal)
--------------------                 -----------------------------
hub spawns the harness               human runs the harness
hub holds the child                  nobody holds anything
     |                                    |
     | proc.exited                        | the agent's NEXT wait
     v                                    v
hub appends agent_turn_ended         wait implicitly ends the
  turnId, reason                     previous turn for that turnId
  (authoritative)                         |
                                          | agent stops without
                                          | ever calling wait again
                                          v
                                     no terminator - the existing
                                     stale state is the answer
```

The interactive path leans on `wait` because an agent already calls it in the
loop; nothing new has to be remembered. An explicit verb exists only to say
*why* a turn stopped when `wait` cannot (OQ-2).

## Message Formats

### `agent_turn_ended`

```jsonc
{
  "t": "agent_turn_ended",
  "seq": 43,
  "at": "2026-07-31T05:12:44.108Z",
  // Which turn stopped. MUST match the turnId on the acks it is ending.
  "turnId": "01J...",
  // Why. A CLOSED set - the viewer owns the wording for each.
  "reason": "done" | "exited" | "failed" | "usage_limit",
  // Optional, and CLOSED: an identifier the viewer can look up, never prose.
  "code": "string (optional, matches /^[a-z][a-z0-9_]{0,39}$/)",
  "attendant": { "harness": "...", "sessionId": "...", "cwd": "..." }
}
```

There is deliberately **no free-text field**. An earlier draft carried a
`detail` string, bounded and control-stripped; that is not a redaction. A CLI
cannot tell a pattern name from copied harness output, and
`detectUsageLimit` returns the matched source line today
(`src/launch/limits.ts:25,36`), so `reason: "usage_limit"` would invite the
exact leak plan 07 #13 is still open for. `code` carries an identifier the
viewer resolves to wording it owns.

Field rules:

- `turnId` MUST be present. An event without one MUST be ignored by the fold
  (see Versioning for legacy acks).
- `reason` MUST be one of the four values. An unknown value MUST fold as
  `done`, so a newer writer cannot make an older reader hang.
- `code` MUST match the closed charset above. `detectUsageLimit` MUST be
  changed to return such an identifier rather than the matched line - a change
  this RFC shares with plan 07 #13.
- The event MUST NOT carry `covers` and MUST NOT move `deliveredThroughSeq`.

### `turnId` on `agent_ack`

`agent_ack` gains an optional `turnId`. Additive: an ack without one belongs to
the **anonymous turn**, which is how every existing log folds.

## State Machine

The fold MUST key working state by turn id rather than keeping one scalar
(`fold.ts:393` keeps `workingSince: string | null` today):

```
open turns: Map<turnId, {since, intent?, progress?}>

  agent_ack(turnId)              -> open turns[turnId] if absent;
                                    refine intent/progress; do NOT restart its clock
  version | agent_reply |
    question   (turnId)          -> close turns[turnId]
  agent_turn_ended(turnId)       -> close turns[turnId]
  session_ended                  -> close ALL
  review_resolved                -> close NONE
```

The viewer paints the oldest open turn, so a single-turn artifact renders
exactly as it does today.

Normative rules:

1. An ack MUST open its turn if absent and MUST NOT restart an open turn's
   clock.
2. `version`, `agent_reply` and `question` MUST close the turn they belong to.
3. `agent_turn_ended` MUST close the turn it names, and nothing else.
4. `session_ended` MUST close every open turn. A session that is over has no
   turn running, and today it closes none.
5. `review_resolved` MUST NOT close anything. Approval is a statement about the
   review, not about the agent; a turn may legitimately still be writing.
6. `session_suspended` MUST NOT close anything. Suspension means "nobody is
   subscribed and the status is active" (`session-host.ts:1321`) - it never
   inspects the working window or the harness. A human closing the viewer while
   an agent works triggers it, and `session_resumed` stays in the same segment,
   so treating it as a closer would erase a live turn permanently.

Rules 3 and 6 are the corrections an earlier draft got wrong: it had no turn
identity, and it treated suspension as evidence a turn had ended.

### Delivery accounting is separate

Closing a window MUST NOT touch delivery accounting. Today the closer branch
also sets `lastAgentOutputSeq = e.seq` (`fold.ts:416`), and `payload.ts:55`
derives an item's **answered** state from it. If a terminator joined that
branch, a turn that explicitly produced *nothing* would mark its feedback
answered. Implementations MUST split window closure from output accounting:
terminators and lifecycle events close windows and advance neither
`lastAgentOutputSeq` nor `deliveredThroughSeq`.

### `wait` must not wake on a terminator

`wait` blocks past ack-only deltas using `lastNonAckSeq`, computed as every
event that is *not* an ack (`fold.ts:205`), and `runWait` returns as soon as it
advances (`wait.ts:269`). A terminator would therefore wake every blocked
waiter - agent B, blocked at cursor 42, returns `waiting` because agent A's turn
ended at 43.

The negative classification MUST be replaced by an explicit wake-relevant set
that excludes both `agent_ack` and `agent_turn_ended`. This is the one place
this RFC touches `wait`, and it is required for the RFC's own "MUST NOT release
`wait`" rule to hold.

### When no terminator arrives

An agent that is killed appends nothing. The existing stale state
(`Thread.tsx:186`) is the answer and MUST be kept: after ten minutes the viewer
stops asserting work and states what it knows - a turn started, when, and
nothing has been heard since.

This RFC does not tighten that interval and MUST NOT derive one from ack
cadence. A turn may ack once and then spend twenty minutes compiling or waiting
on subagents; a turn that narrated every two seconds and then entered such a
phase is indistinguishable from a dead one by cadence alone. The fold keeps
only the *first* ack time (`fold.ts:407`) and `AgentWorking` exposes only
`since` (`wire.ts:20`), so the viewer could not implement a cadence rule from
current state in any case.

## Error Handling

| Situation | Behaviour |
|---|---|
| Terminator names an unknown turn | Ignored. With turn identity this is safe; without it, it would close someone else's window. |
| Two terminators for one turn | Second is a no-op - the turn is already closed. |
| A late ack arrives after its turn ended | MUST NOT reopen the turn. A closed turn id stays closed for the segment. |
| A turn writes output after its terminator | Legal. It closes an already-closed turn, and MUST NOT reopen anything. |
| Terminator arrives in a later segment than its turn | Ignored - turn ids are segment-scoped (see Versioning). |
| `lucid end-turn` against an ended session | Refused like any append to an ended log, with the existing typed error. |
| Hub cannot append (log locked, disk full) | The turn is over regardless; the hub MUST record the failure in the hub log and MUST NOT retry indefinitely. |
| Agent dies mid-turn | No terminator. The stale state covers it. |

## Security Considerations

**Trust boundary.** The event is appended by the hub (trusted, in process) or by
an agent through the CLI (untrusted, like every other append). The CLI path MUST
validate `reason` against the closed set and `code` against its charset, and
MUST reject anything else rather than truncating it.

**D-005.** Removing free text is the whole mitigation. A bounded, stripped
string is still content; a closed identifier cannot be. This also closes the
`usage_limit` path that would otherwise re-leak what plan 07 #13 leaks today.

**Blast radius.** The event is advisory: it changes what the viewer paints. It
MUST NOT gate delivery, move a cursor, or release `wait`. A forged terminator
makes a viewer stop claiming an agent is working - a cosmetic lie, bounded to
one artifact, on a loopback surface behind the existing Host/Origin gate.

## Versioning

**Turn ids are segment-scoped.** They MUST be treated as meaningful only within
the segment that minted them, so a delayed terminator from a turn in a previous
segment cannot close a turn in the current one.

**Legacy logs migrate silently for the window, and explicitly for suspension.**
Acks without a `turnId` belong to the anonymous turn, which folds exactly as
today. But rule 4 (`session_ended` closes) *does* change historical replay: a
log of `session_opened → agent_ack → session_ended` folds open today and closed
after this RFC. That is an intended migration and MUST carry compatibility
tests over recorded logs, not only synthetic ones. (An earlier draft claimed no
log changes meaning; that was wrong.)

**Older readers.** A reader predating this RFC ignores the unknown event type -
its window stays open, which is today's behaviour and the correct degradation.
Its `wait` will wake on the terminator until the wake-set change ships, which is
why that change is normative here and not an optimisation.

## Implementation Notes

- Rule 4 (`session_ended` closes) needs no writer, no CLI surface and no new
  event. It SHOULD land first and alone, with the replay tests above.
- The wake-set change and the output-accounting split are both prerequisites for
  the new event and are independently testable. They SHOULD land before it.
- The hub-spawned half publishes a fact the hub already derives
  (`attend.ts:771`), at a point that already exists (`launcher.ts:252`). Plan 07
  #16 (no timeout on that await) lives at the same line and is separable.
- Turn identity is the largest piece and the one the rest depends on.

## Open Questions

**OQ-1. Who mints the turn id, and does an interactive agent have to?**
Options: (a) the hub mints it and hands it to a spawned turn, while an
interactive agent's first ack mints its own; (b) `wait` returns one with the
feedback, so any agent gets it for free; (c) derive it from the ack's seq, so
nothing is minted at all.
Leaning (b): `wait` is the one call every turn already makes, and a
`wait`-issued id needs no agent to generate anything. (c) is tempting but a
turn's first ack is not always its first event.

**OQ-2. Does the explicit verb exist at all?**
The next `wait` covers every cooperative turn. A verb adds `reason` and `code`
for the cases `wait` cannot express - a turn standing down on a usage limit,
say. Options: (a) `lucid end-turn`, optional, annotation only; (b) no verb, and
`usage_limit` is inferred by the hub for spawned turns and simply unavailable
for interactive ones.
Decision criteria: whether an interactive agent hitting a usage wall can
usefully say so before it dies. If it cannot, the verb earns nothing.

**OQ-3. Does the stale state change wording once a terminator exists?**
"No response yet" is right for silence and wrong for a turn that ended saying it
had nothing to add. A closed turn with `reason: "done"` and no output is a
different fact from an agent that vanished, and the viewer can now tell them
apart.

## References

### Normative

- `CONTEXT.md` - Turn, Ack, Delivered; the flagged ambiguity "A turn has no
  representable end"
- `src/core/fold.ts:200-210, 235-245, 393-425` - the wake set, segmentation, and
  the working-window derivation
- `src/core/wait.ts:269` - the return-on-advance this RFC must not trip
- `src/core/payload.ts:55` - where `lastAgentOutputSeq` becomes "answered"
- `src/server/session-host.ts:1321` - what suspension actually checks
- D-005 (plan 07) - records carry identifiers and outcomes, never content

### Informative

- Plan 08 findings #1 and #4 - the observation, and the correction to it
- Plan 08 findings #5-#12 - the adversarial review that reshaped this draft
- `client/chrome/Thread.tsx:186, 305-311` - the stale state this RFC keeps
- `src/server/attend.ts:771` - the deadness the hub already computes
- `src/core/presence.ts:17` - harness idle/busy, already broadcast

---
number: 31
title: "Idle headless-session release"
type: feature
status: Draft
author: Kevin
date: 2026-09-23
version: v1
---

# RFC-31: Idle headless-session release

## Abstract

A `lucid run` in `headless-session` profile holds the record presence
lock for its whole process lifetime, even after its turn finished and no
further work is scheduled. A browser prompt queued behind that attachment
holds forever: the managed worker reconciler skips records with presence
held, and the parked run never exits on its own. This RFC proposes a
release rule for an idle session source, so queued work dispatches
without a person killing the parked process by hand. Scope holds: one
release rule, one lock, no change to turn dispatch or the managed
worker.

## Introduction

Problem: an idle `headless-session` run blocks its own record. The
person's prompt is saved, the page says to wait, and nothing the system
does will ever release it.

Scope: this RFC covers when an idle `headless-session` source releases
presence (and whether the process then exits), restricted to the case
where no turn is running and queued managed work waits. Out of scope: the
held-prompt card text (shipped separately: a held request behind an idle
session now says the session is idle), turn dispatch, managed worker
selection, and any change to `headless-turn` or interactive profiles.

Motivation: observed on 2026-09-23. A `lucid run 2026-09-23` attached at
09:00, emitted artifact v1, received `done`, and sat idle holding
presence for over 90 minutes. A 10:26 browser prompt held with "Wait for
it to exit." No system step schedules that exit. The person must find the
pid and kill it by hand.

Context: the substrate contract (`docs/skill-chat-substrate.md`) says
queue inputs wait under `headless-session`. Waiting presumes the session
still works. A session whose turn finished and whose process idles is not
working; holding the lock past that point converts "wait" into "never."

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD
NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted
as described in RFC 2119. Idle means an attached source with no running
turn: the newest turn produced a terminal event and `inFlightInputs` is 0
(the same reading the browser `activity.turn` already serves). Parked
means idle plus a live process still holding presence. Release means the
source detaches and frees the presence lock so a managed worker or a new
run can take the queued work.

## Motivation

The record already distinguishes the two states. `activity.turn` is false
while presence is held. The managed worker reconciler already refuses to
touch held records (`src/server/managed-launch.ts`). `runHeadless` awaits
`handle.done`, which resolves only on source close or abort
(`src/cli/runtime.ts`). Nothing connects "turn finished" to "release."
That missing link is the whole defect.

## Design

The proposed rule: a `headless-session` source whose turn finished, with
no queued legacy work deliverable to it and managed work waiting that it
cannot consume (no `managed-input-v1` capability), SHALL detach and
release presence after a short grace period. The grace period covers the
gap between `done` and a person's next send in the terminal case, where
the run still owns the conversation.

The detach MUST write a record-visible marker (a frame or a transcript
line) stating why the session ended, following the precedent in
`src/modes/host.ts`: a driver holding presence with nothing in the record
to say why is the failure this project already fixed once.

Open design point: whether the process exits after release or stays alive
detached for terminal inspection. Exiting frees the hcn child too (a naive
kill of the parent orphans pid supervision). Staying alive detached keeps
terminal scrollback but leaves a process the person must still reap. The
proposal leans toward exit-with-marker: the record carries the reason, so
the process has nothing left to say.

## State Machine

No new execution states. The transition is source-level: attached-idle to
detached, gated on turn-finished plus managed-work-waiting plus
capability-mismatch. A source that CAN consume the queued work (managed
capability present) never trips the rule; its normal dispatch path owns
the input.

## Error Handling

A release that races a new turn start MUST lose: re-check turn state under
the same discipline that guards dispatch, and abort the release if a turn
began. A release that fails to detach MUST NOT drop the queued input; the
input stays held with the idle text the card now shows.

## Security Considerations

Release hands execution authority to the next worker. The next worker is
selected through the existing managed path with its existing locks, so no
new authority is created. The detach marker MUST NOT carry prompt text or
record bytes beyond identifiers.

## Alternatives Considered

Promotion instead of release: upgrade the parked source in place to a
managed source when managed work arrives. Rejected: the source's
capability set is an attach-time declaration, and changing what a live
source may consume mid-session widens the trust boundary the attach
handshake exists to fix.

 reconciler takeover: let the managed worker take presence from a parked
source. Rejected: presence is kernel-elected and kernel-released for a
reason (ADR-0003). Taking it by policy reintroduces two drivers for one
record, the exact state the lock exists to prevent.

Do nothing (card text only): the shipped card fix already tells the
person the session is idle and names the release step. Viable as a
standing position if the lifecycle change proves riskier than the manual
kill it leaves behind.

## Implementation Plan

1. Gate the idle reading on the server's existing `turnActive`
   computation, so release and display share one answer.
2. Add the detach-with-marker path in the headless host, behind the
   capability-mismatch plus managed-waiting condition.
3. Cover with a regression test at the runtime seam: parked source plus
   queued managed input yields detach and a free lock; a source that can
   consume the input never detaches.
4. Measure Blast radius against the smoke set (`docs/smoke-seven.md`).

## Open Questions

Grace period length: long enough to cover terminal think time between
`done` and the next send, short enough that a queued browser prompt does
not visibly stall. Needs measurement, not a guess.

Terminal-owned runs: `lucid run` holds the person's terminal. Exiting
that process closes their foreground command. The marker must reach the
terminal on exit, or the exit must apply only to detached/background
runs. Unresolved in this draft.

## References

- `src/cli/runtime.ts` (`runHeadless` awaits `handle.done`)
- `src/server/managed-launch.ts` (reconciler skips held presence)
- `src/protocol/execution-view.ts` (held text; idle variant shipped)
- `src/modes/host.ts` (pump-ending commentary on silent drivers)
- `docs/adr/0003-kernel-locks-divide-append-authority-from-execution.md`
- `docs/smoke-seven.md` (verification gate)

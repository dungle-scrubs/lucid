# Learnings from plan 08 - deferred work and gate closure

Extracted 2026-07-31, before the plan was deleted. 39 decisions, 21 findings,
49 gate records. Plan 08 discharged the open work of plans 02-07 and closed
their gates; the learnings from those six are in
[`learnings-02-07.md`](learnings-02-07.md).

The code carries the *how* in its comments. What a ledger holds that code
cannot is the **why**, and the alternatives that were rejected. Recorded here
are the decisions a future reader would otherwise have to rediscover, plus the
four defects that only measuring found - which is the part of this plan most
worth remembering.

## What measuring found that reading did not

Plan 08 existed because plans 02-07 had all marked themselves complete with
**empty gate tables**: 50 unchecked criteria and no recorded evidence anywhere.
The lesson is not that the gates were skipped. It is what turned up when they
were finally run.

### A "flake" was a product race (D-037)

`concurrent.e2e.ts:147` was measured at 2/20 in a full suite and **0/20 in
isolation**. That gap is the whole diagnosis: it said load-dependent, not
random. Two `lucid open` processes both read an absent server descriptor and
both spawned, so two servers ran for one artifact - two appenders on one log,
which is exactly what the append lock exists to prevent - and the loser's
descriptor overwrote the winner's, so the two callers disagreed about the URL
they had just opened.

It had been deferred as test timing (D-029). It was not.

**The transferable part:** an intermittent failure that reproduces only under
load is evidence *about the product*, not noise. And a fix for one cannot be
A/B validated at n=20 through a 12-minute suite - it has to be pinned
deterministically instead (`test/open-race.test.ts` races 2 callers, and 10).

### The 8-minute create found the wrong bug first (D-038)

The stub harness slept, wrote the artifact, exited 0 - and the dialog sat at
"authoring... 1:21". That was recorded as a product defect: a successful create
never finishing. **It was wrong.** The create prompt's last instruction is
`lucid open <artifact>`, and the stub never ran it, so no session existed and
no tab could appear. The agent opens the artifact, not the hub.

Making the stub do what a real harness does exposed the actual defect: the hub
never told the turns it spawned which port it was on, so a turn's `lucid open`
went to the default 17428. In production a hub on any other port cannot
complete a create at all. In the test suite, the spawned turn **escaped into
the developer's own running hub** - the contamination class
`test/e2e/harness-env.ts` exists to prevent, and the one its policy table
cannot catch, since `LUCID_HUB_PORT` is per-suite by design.

**The transferable part:** a stub that omits a step the real thing always takes
does not simplify the test, it changes what is being tested. And when a
measurement disagrees with the product, suspect the measurement first - the
gate criterion here was met all along.

### A deferral pointed away from the case that mattered (D-034)

Plan 04 deferred "deep-DOM O(n^2) via textContent". Measured: depth is cheap -
2000 nested elements fingerprint in 6.5ms. **Breadth** was quadratic, through
`indexAmongSiblings` re-walking the sibling list per element: 2000 blocks
39.6ms, 8000 blocks 630ms - 4x the elements for 16x the time, on `diffHtml`,
which runs on every saved version. Wide is also the shape a real artifact has.

Fixed with the one-pass `sibIndexMapOf` anchor resolution already used;
re-measured linear at 86.6ms for 8000 blocks. Guarded by a **complexity test,
not a timing budget** - a budget fails on a slow machine and passes on a fast
one while the shape silently regresses.

### Three layers of green unit tests missed a one-line gap

`agent_turn_ended` broadcast correctly, `foldLog` derived from it correctly,
the payload carried it correctly. Every layer passed in isolation. But
`onLogEvent` did not know the event type, so the frame hit `default:` and the
viewer never asked for the new state. The server was right; nothing requested
it. Only the e2e caught it.

## Decisions worth carrying forward

### On honesty in the ledger

- **D-002** - a gate-closure phase measures what was never measured, ticks what
  a real run genuinely satisfies, and **waives the rest with a stated reason**.
  Everything present-tense. Backdating would be fiction; a waiver is honest and
  cheap. Of 39 criteria: 36 pass, 3 waived, 1 recorded failed and then
  superseded when the measurement behind it turned out to be wrong.
- **D-004** - measure a flake at >=20 runs per arm *before* fixing it. A 0/20
  result is a recorded fact that closes a finding as not-reproducible-at-that-
  sample; a fix with no before/after cannot be told from a coincidence.
- **D-039** - findings are cleared for retirement in two groups on *different*
  terms: those carried into a milestone, and those re-checked against the tree.
  Process notes and review verdicts ("safe to merge", "all fixed") carry no
  code claim and are closed as historical record, **not** as verified fixes.
  The distinction is the point.
- Three criteria were waived rather than ticked because they were not
  measurable by the party asking: discovery parity (a property of a machine),
  whether a doc stands alone (a question about a reader), and one naming a plan
  that no longer exists.

### On turn identity and the working window

- **D-013** - a turn carries an opaque, segment-scoped `turnId`; the fold keys
  working state by turn instead of one scalar. Lucid permits two agents on one
  artifact, and with a single scalar A's terminator closes B's window, A's
  delayed ack reopens a window after A ended, and A's late output closes B.
- **D-014** - `session_ended` closes every open turn; `session_suspended`
  closes none. Suspension only checks "no subscribers and status active", which
  a human closing the viewer triggers while an agent legitimately works.
- **D-015** - the terminator carries a closed `reason` plus an optional closed
  `code`, and **no free-text field**. Bounding and control-stripping a string is
  not redaction: a CLI cannot tell a pattern name from copied harness output.
- **D-018** - closing a window and accounting for delivery are separate. The
  pre-existing closer branch also advanced `lastAgentOutputSeq`, which derives
  an item's *answered* state - so folding the terminator into it would have
  marked the feedback of a turn that explicitly produced nothing as answered.
- **D-027** - closing the window silently loses the outcome. A turn that read
  the feedback and correctly decided nothing was needed became
  indistinguishable from one that never happened - the same class of defect as
  the original bug, reached from the opposite direction.
- **D-016 / D-026** - an explicit "I am done" verb is ceremonial exactly where
  it is needed: an agent that forgets, crashes, or is killed appends nothing.
  The hub owns both ends of every turn it spawns; the ten-minute stale state
  remains the answer for a turn Lucid does not own.

### On where a rule lives

- **D-033** - the trace header is stamped inside `loopbackFetch`, not at each
  call site. Three callers remembering it by hand made an untraced fourth
  caller something you could add with nothing noticing. Making it a property of
  the seam **removes the need for a guard** instead of adding a second one.
  (`wait` keeps its own stamp on purpose: it resolves one trace outside the
  reconnect loop, so deferring to the seam would mint a fresh id per attempt.)
- **D-030** - the server ships a *code*; the viewer owns the English. Importing
  the wording table from a launch module would have satisfied the data flow
  while pulling that module into the browser bundle - which the bundle-sources
  guard caught. Duplicating four short strings client-side is the cheaper
  trade: the layout now says what the contract says.
- **D-031** - a dedicated server writes records to its own per-session log with
  no stdout mirror, and attaches identity **at the wrapper**: it serves exactly
  one artifact, so identity is a property of the server, not of the request.
- **D-011** - a bare "log" means the review's event log; the hub's operational
  output is always qualified as the hub log, and one line in it is a record.
  The code hit this collision before the glossary did.

### On attendance — the single-attendant headache (D-068)

- **D-068** - one artifact, one writer. **Spawn mode** (no interactive `sessionId` open per `harnessPresence`) lets the hub drive headless turns (`muse exec --session-id {id} --yolo`, `claude --resume`, `codex exec resume`) via the harness's declared `spawn`/`resume` + `sessionIdentity`. **Interactive mode** (presence true) yields — hub spawns nothing. Two substates: **waiting** (`lucid wait` running → `Delivered to {harness} in the terminal`) vs **not waiting** (queued → `Tell {harness} to participate` + copyable `interactiveResumeCommand` with yolo). The hub's attempt on `b78de416…` while the TUI held it (`already in use`) is what happens when a harness lacks `harnessSupportsPresence` — the mode switch is blind. Biggest headache because every new harness must implement six surfaces (`harnessKind`, store, resume parser, interactive command, `NOT_FOUND`, presence) or the invariant breaks.

### On scope

- **D-001** - carry only the genuinely-open findings; close the already-fixed
  ones as bookkeeping with the verifying evidence recorded in the *new* plan's
  ledger, because the old plans get deleted.
- **D-009** - `delete-plan` removes the whole directory. Extract the learnings
  and preserve the operational artifacts first, or retirement is lossy. (This
  file exists because of that rule, applied to plan 08 itself.)
- **D-024** - the same classifier serves two consumers with different rules: a
  stable code for anything reaching a *record*, the matched line for anything
  reaching the *dialog*. `reportFailure` already ships a raw tail on that event,
  so the dialog is an existing deliberate channel for harness output; D-005
  governs the retained hub log, not this transient event.
- **D-023 / D-029** - two recorded deviations from the plan's own landing
  cadence, written down rather than taken silently.

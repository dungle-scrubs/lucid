# Live harness matrix - all four, through the hcn seam

Run: `bun scripts/smoke-live.ts --harness <claude|pi|codex|muse>`
Date: 2026-08-22. hcn 0.5.5, pinned.

Each run drives a real harness through a real `hcn --json` subprocess, folds
every event into a durable conversation record, kills the source, and reopens
the log to check the fold matches what was live.

| harness | sessionMode | profile lucid chose | result |
|---|---|---|---|
| claude | present | headless-session | PASS |
| pi | present | headless-session | PASS |
| codex | null | headless-turn | PASS |
| muse | null | headless-turn | PASS |

## What this settles

**A harness is a name.** Nothing under `src/` changed to add pi, codex, or
muse. The smoke gained a `--harness` flag; that was the whole cost. Before
the migration each harness needed its descriptor imported and its framing
understood, which is what PLAN D-003 sequenced as four separate slices.

**The profile is asked, not assumed.** The smoke calls `hcn inspect` and takes
the answer, the same runtime-verified check `lucid run` makes. claude and pi
report a session mode and get one process for the conversation; codex and
muse report none and get one process per turn.

**Both profiles hold their own invariants.** A session shows exactly one
`identity` for the whole conversation. Turn mode shows one per process, and
continuity there comes from resume - the turn strategy captures the session id
off the first turn's identity and resumes into it, so the codeword survives
into turn two even though the process did not.

## What running this found

codex and muse were the first harnesses to refuse a session open, and lucid
recorded nothing when they did. A refused open ended the source exactly like a
clean shutdown, so the durable log could not tell a refusal from a crash. The
reason is now written as a terminal error event before the pump detaches, and
a regression test pins it. The smoke also polled its full 90-second budget
waiting for a turn that could never arrive; it now stops when the channel is
released.

## Not covered here

- Resume as its own lane. Turn mode exercises it incidentally; there is no
  smoke that kills a conversation and resumes it deliberately.
- pi against a local provider (`--provider lmstudio`). The seam passes the
  flag and hcn renders it; no live run yet.
- Concurrent harnesses in one conversation. The protocol fences on epoch, but
  nothing has driven two at once.

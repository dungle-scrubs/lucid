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

## Since closed

- **Cross-harness handoff: PASS**, four pairs. One record, two harnesses; the
  successor learns the conversation from lucid's log because it cannot
  inherit a session it never had. `spikes/evidence/cross-harness-handoff.md`.
- **pi against a local provider: PASS.** `bun scripts/smoke-live.ts --harness
  pi --provider lmstudio --model qwen3.6-35b-a3b-ud-mlx --turn-budget 360000`.
  A whole conversation with no hosted model in it. The budget flag exists
  because a local model is slower than a hosted one, and reading that as a
  failure would be wrong.
- **Resume: FAILS, deliberately.** `spikes/evidence/resume.md` carries the
  diagnosis. lucid never persists the harness session id, so a reopened
  record cannot attempt a resume; and hcn's session surface cannot restore
  context even when given the id (hcn issue #86). Not in CI - it specifies
  work rather than guarding behaviour.

## Still not covered

- Two harnesses driving one conversation AT ONCE. The protocol fences one
  writer by epoch, so this is a non-goal rather than a gap; sequential
  takeover is the supported shape and it passes.

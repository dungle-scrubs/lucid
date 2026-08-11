# 01-piping - Spike Guide

> **OUTCOME (`D-014`): A-002 PASSED on claude 2.1.227** - all three contracts
> confirmed. Evidence: `spikes/evidence/A-002.md`, sandbox
> `spikes/a002b-227/`. C1 (mid-turn injection) PASS; C2 (project-hook co-run)
> PASS -> M2.3 coexistence is REQUIRED; C3 (transcript flushes at turn
> boundary, mtime froze for the whole tool-free turn) CONFIRMED -> `D-009`
> presence-lock justified. Stop-hook did not fire (best-effort only). No
> escape hatch triggered. This guide is historical from here.

One live assumption gated workstream C. The lock-backend spike (A-001) was
**cancelled** - `flock(2)` vs O_EXCL is a kernel fact, not an experiment
(`D-008`). Only A-002 remained.

## Assumptions

### A-002: The injection contract on claude 2.1.227

(plan-db handle: `A-001` - the plan's first registered assumption; the
`A-002` label is RFC/evidence-canonical, matching `spikes/evidence/A-002.md`.)

- **Claim:** On claude **2.1.227**, three things hold:
  1. A `Stop` / `PostToolUse` hook can inject queued input back into the
     session via hook **stdout** (the rung-1 cooperative-injection contract
     the `M5.3` adapter assumes).
  2. `--setting-sources project` **co-runs** pre-existing project `.claude`
     hooks alongside lucid's - it does NOT isolate lucid's hooks
     exclusively (`D-010`).
  3. The transcript is **NOT** flushed to disk during a long tool-free
     reasoning stretch - so transcript-`mtime` is not a reliable liveness
     signal, which is why liveness is a held presence lock (`D-009`).

- **Impact if false:**
  - (1) false or shape-changed -> M2.3's `inject` hook and the rung-1
    adapter wiring are reworked against the observed shape (escape hatch 1;
    regress to DECOMPOSE). Phase 1 is unaffected.
  - (2) false (hooks ARE isolated) -> M2.3's project-hook coexistence logic
    is unnecessary and is dropped; simplifies the milestone.
  - (3) false (transcript flushes mid-reasoning) -> transcript-`mtime`
    becomes a viable liveness signal; `D-009`'s presence-lock rationale
    weakens and should be revisited at CONVERGE (though the presence lock
    is still correct, it would no longer be the *only* option).

- **Experiment (Herdr-automatable):**
  1. In a Herdr pane, start a real `claude` (2.1.227) configured with
     `--setting-sources project`, a lucid `Stop`/`PostToolUse` hook, AND a
     second benign pre-existing project hook that writes a marker file.
  2. Drive a turn that queues a lucid input; confirm the hook injects it
     via stdout and the session consumes it (contract 1).
  3. Confirm the benign hook's marker file was ALSO written on the same
     event (contract 2 - co-run, not exclusive).
  4. Drive a long tool-free reasoning turn (a prompt that makes claude
     think without calling a tool); sample the transcript file's `mtime`
     and size across the reasoning window; confirm no mid-reasoning flush
     (contract 3).
  5. Log verbatim hook I/O, the marker-file result, and the `mtime`
     samples to `spikes/evidence/A-002.md` with a per-run unique marker
     (not a static verdict string - the stale-scrollback trap: match a
     fresh per-run token or poll the evidence file, never a constant like
     "PASS" that a prior run left in the pane).

- **Pass criteria:**
  - Contract 1: the queued input reaches the session via hook stdout,
    observable in the transcript, exactly once.
  - Contract 2: both lucid's hook and the pre-existing project hook fire on
    the same event (co-run confirmed).
  - Contract 3: transcript `mtime`/size does not advance during the
    tool-free reasoning window (no mid-reasoning flush).
  - Each contract records PASS/FAIL independently; a partial result updates
    the specific milestone task it gates, not the whole plan.

- **Effort:** ~half a day (Herdr pane automation + a real claude turn loop;
  the harness exists from `smoke-live.ts`).

## Recording the result

```bash
# Recorded on completion (plan-db handle A-001, status pass):
npx tsx <skill-dir>/scripts/plan-db.ts validate-assumption \
  --plan "01-piping" --code A-001 --status pass \
  --evidence "claude 2.1.227 spikes/evidence/A-002.md: C1/C2/C3 all pass ..."
```

No contract failed, so no escape hatch was taken. Had one failed, the
matching escape hatch in `implementation.md` would apply and the stage
would regress rather than proceed into M2.3 on an unproven contract.

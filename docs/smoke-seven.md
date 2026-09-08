# Smoke verification

`bun run check` is the deterministic gate: lint, both TypeScript projects,
and fake-harness tests with injected clocks. Live confirmation adds evidence
about real processes and models. It runs on demand, is nondeterministic, and
does not replace the deterministic gate or gate CI.

## The seven invariants

| # | Smoke | Deterministic oracle |
|---|---|---|
| 1 | Headless single turn reaches the durable log | [headless](../test/modes/headless.test.ts) |
| 2 | Interactive delivery and rendering | [interactive](../test/modes/interactive.test.ts), [terminal view](../test/tui/view.test.ts) |
| 3 | Continuity across integration paths | [cross-mode gates](../test/gate-5-6.test.ts) |
| 4 | Handoff preserves input and fences the old source | [controller](../test/modes/controller.test.ts) |
| 5 | Event fidelity, coalescing, and credit | [headless](../test/modes/headless.test.ts), [events](../test/protocol/events.test.ts) |
| 6 | Limit and error propagation with durable termination | [headless](../test/modes/headless.test.ts) |
| 7 | Kill, reopen, and recover before acknowledgement | [store](../test/store/store.test.ts), [controller](../test/modes/controller.test.ts), [reducer](../test/protocol/reducer.test.ts) |

## Live confirmation lanes

| Lane | Script |
|---|---|
| Harness process through hcn | [smoke-live](../scripts/smoke-live.ts) |
| Harness recalls its session after process loss | [smoke-resume](../scripts/smoke-resume.ts) |
| One record, two different harnesses | [smoke-cross-harness](../scripts/smoke-cross-harness.ts) |
| Two processes pass ownership | [smoke-handoff](../scripts/smoke-handoff.ts) |
| Human-owned session attaches through hooks | [smoke-interactive](../scripts/smoke-interactive.ts) |

Scripts write dated output under ignored `artifacts/evidence/`.

Read each script's arguments before running it. Use the workspace's standing
live model and machine guidance in [AGENTS](../AGENTS.md). A direct model call
can confirm store/protocol plumbing when a harness is unavailable, but cannot
stand in for a harness-process or hook-attachment claim.

Evidence describes the versions, model, and conditions recorded in that run.
It is not a promise that every current harness and model passes. Keep failed
observations and their causes. Generate new evidence through the scripts;
do not hand-edit old results. Historical DF-SMOKE labels mean an on-demand
lane, not that the lane has never run.

The interactive lane includes a negative control: without project hooks,
the session answers its prompt and lucid never attaches. Keep that control
when changing the integration. Deterministic proof plus applicable live
confirmation establishes the seam; live output alone does not prove it.

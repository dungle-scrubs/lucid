# Real-harness compatibility smoke - the original seven (M7.2)

"Fully tested" is the invariant suite against the deterministic fake
harness; the real-harness smoke is **necessary but no longer the proof**
(PLAN 4.7). Each of the original seven is proven deterministically by a
fake-harness oracle in this repo AND exercised against real harnesses at
the runner layer by the normalizer's `smoke:seven`. The remaining
lucid-v2 live confirmation - the seven driven through the store+protocol
against live claude - is nondeterministic, run on demand, evidence
logged; it is **deferred (DF-SMOKE)** until run against a live harness,
because it cannot execute in deterministic CI.

| # | Smoke | Deterministic proof (lucid-v2) | Real-harness runner proof |
|---|-------|--------------------------------|---------------------------|
| 1 | headless single-turn | `test/modes/headless.test.ts` session-mode turn maps event-for-event into the durable log | normalizer `smoke:seven`, `smoke:claude` (M3.3, D-026) |
| 2 | interactive single-turn | `test/modes/interactive.test.ts` hook delivery + announce; `test/tui/view.test.ts` render | spike A-002 (live claude 2.1.226) |
| 3 | session continuity across paths | `test/gate-5-6.test.ts` all-three-modes conversation | normalizer session smoke |
| 4 | path handoff | `test/modes/controller.test.ts` D-020 exactly-once handoff (both directions) | `scripts/smoke-handoff.ts` (on demand) |
| 5 | streaming fidelity | `test/modes/headless.test.ts` token coalescing + credit; `events.test.ts` | normalizer token-granularity smoke (A-001) |
| 6 | limit/error propagation | `test/modes/headless.test.ts` limit terminates turn, durable classified `done` | normalizer `smoke:seven` limit smoke |
| 7 | kill and resume | `test/store/store.test.ts` fold/reopen; death-before-ack oracle (`controller.test.ts`, `reducer.test.ts`) | normalizer kill+resume smoke |

## Running the live confirmation (DF-SMOKE)

Run the applicable `scripts/smoke-*.ts` lane through hcn, as listed in
`AGENTS.md`. Record results under `spikes/evidence/`, including failures
and their causes. Live checks confirm the deterministic oracles; they do
not gate CI. Record follow-up work in the repository's local tracker.

# Plan history

Durable records from plans that have been deleted. Plan directories live under
`.plans/`, which is **gitignored** - so anything that must outlive a plan has to
be copied here first. `delete-plan` removes the whole directory: the decisions,
the archived RFC, and any operational artifact sitting in it.

| File | What it is |
| --- | --- |
| [`learnings-02-07.md`](learnings-02-07.md) | 127 decisions from the six plans that built portable records, the tab bar, overlay hardening, anchor identity, the solo surface, and observability |
| [`learnings-08.md`](learnings-08.md) | 39 decisions from the plan that discharged 02-07's deferred work and closed their gates - including the four defects that only measuring found |
| [`01_how-a-turn-ends.rfc.md`](01_how-a-turn-ends.rfc.md) | The turn-lifecycle protocol RFC: turn identity, the terminator, and what the viewer says when a turn ends with no output |
| [`plan-02-migration/`](plan-02-migration/) | Machine inventories and reversal manifests for the `.lucid/` record migration on `pro` and `air` - the operational undo record |

These are history, not specification. Where a decision here disagrees with the
code, the code is what ships; the value of the record is the **why**, and the
alternatives that were rejected.

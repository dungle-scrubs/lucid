# Plan 02 migration: inventories and reversal manifests

Plan 02 moved every review record to the canonical layout - the artifact and
its record together under a project's `.lucid/`. These four files are that
migration's **operational undo record**, one pair per machine:

- `inventory-<host>.json` - what was found before the move
- `inventory-<host>.reversal.json` - what to do to put it back

They lived in `.plans/02-portable-review-records/` and would have been
destroyed with it when plan 08 retired that plan. They are preserved here
because a reversal manifest is only useful if it outlives the plan that
produced it: the migration it reverses is in the repository's history
permanently, so its undo record has to be too.

Nothing reads these automatically. They are evidence for a human deciding
whether, and how, to unwind that migration on a given machine.

`air` was inventoried but this session could not verify it; see plan 08's
waived gate "discovery parity on air".

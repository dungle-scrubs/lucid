# Transfer recorded context across harnesses

Status: open
Blocked by: 05
GitHub: [Transfer recorded context across harnesses](https://github.com/dungle-scrubs/lucid-v2/issues/210)

## What to build

Switch harnesses and continue with the recorded conversation, then return to a prior harness with the work it missed. An explicitly chosen fresh continuation receives the same recorded context rather than an empty conversation.

## Acceptance criteria

- [ ] One context preparation path preserves messages, decisions, current artifact version/content, annotations, relevant tool results, attachment references, and the pending prompt with roles and provenance.
- [ ] Persist offered coverage and confirmed coverage by actual native session and supplying turn, with managed-attempt identity when applicable. Session-scoped coverage does not invent an input for an interactive turn. Confirm only from durable acknowledgement evidence; do not use the executor delivery cursor as context coverage.
- [ ] Prove A-to-B-to-A continuation: B receives recorded history, and A resumes its own native session with the missed range. Imported history is quoted context with stable IDs, never new accepted inputs or commands to rerun.
- [ ] Provide bounded agent retrieval from a private offered context copy outside the record. No record path, attach secret, browser token, unrelated record, traversal, or symlink escape is exposed. The CLI reads the copy without HTTP.
- [ ] Obtain verified context accounting and resume-budget support through the public hcn seam, extending and pinning hcn if needed. Unknown budgets hold dispatch; do not mirror a model table in Lucid.
- [ ] An intentional switch can authorize a new harness session. An unexpected failed resume waits for explicit fresh continuation and preserves its input identity. Oversized mandatory context remains held until supported preparation exists.
- [ ] Demonstrate complete-history switching and explicit fresh continuation with fake harnesses, including partial/uncertain coverage and comparison current-context requirements. Update contracts and pass repository checks.

## Parent

[Connect the hub to local conversations](https://github.com/dungle-scrubs/lucid-v2/issues/199). Contract: RFC 15, local hub conversation integration.

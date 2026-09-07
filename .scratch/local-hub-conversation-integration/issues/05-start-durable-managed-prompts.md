# Start accepted prompts with durable workers

Status: open
Blocked by: 04
GitHub: [Start accepted prompts with durable workers](https://github.com/dungle-scrubs/lucid-v2/issues/209)

## What to build

Submit a prompt in the hub and have an independent worker start or resume the conversation. Accepted work survives tab closure, simultaneous sends, worker contention, and a server crash before launch.

## Acceptance criteria

- [ ] Extend repeat-safe acceptance with one managed-input log envelope containing the input and launch intent. A crash never leaves a valid accepted input without its authorization; duplicate receipts precede admission checks.
- [ ] Only a worker holding the existing executor lease can dispatch. The server schedules workers from durable intent without running a harness in the HTTP handler or changing the record transport.
- [ ] Reconciliation runs while the server is alive even with no tabs. Cover acceptance-before-launch, contender workers, worker loss, idle exit, and restart without stranding or silently repeating input.
- [ ] Worker environment and startup arguments preserve the resolved root and saved selections without inherited harness pins. Setting changes alone do not create new input or authorization.
- [ ] Folder and settings remedies update locked sidecars and release only applicable prerequisite holds; a crash after save is recoverable. Unsupported context or route capabilities remain visible holds.
- [ ] Comparison holds retain their own codes, skip rules, newer-artifact/explicit-attachment triggers, and suppression across automatic worker restart. A later eligible ordinary input can run. Explicit attachment intent uses a stable identity consumed once; automatic attaches never release suppression. An incompatible live source has visible upgrade/wait guidance.
- [ ] New attach capability and managed envelopes prevent incompatible sources from receiving managed work; old delivery cursors cannot discard it. Keep default enablement off until the remaining continuation/recovery contracts are delivered.
- [ ] Demo submit-to-answer with a deterministic process harness, tab closure, and reload. Update server, source, driver, and architecture contracts and pass the full repository gate.

## Parent

[Connect the hub to local conversations](https://github.com/dungle-scrubs/lucid-v2/issues/199). Contract: RFC 15, local hub conversation integration.

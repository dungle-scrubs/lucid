# Start accepted prompts with durable workers

Status: resolved
Blocked by: 04
GitHub: [Start accepted prompts with durable workers](https://github.com/dungle-scrubs/lucid-v2/issues/209)

## What to build

Submit a prompt in the hub and have an independent worker start or resume the conversation. Accepted work survives tab closure, simultaneous sends, worker contention, and a server crash before launch.

## Acceptance criteria

- [x] Extend repeat-safe acceptance with one managed-input log envelope containing the input and launch intent. A crash never leaves a valid accepted input without its authorization; duplicate receipts precede admission checks.
- [x] Only a worker holding the existing executor lease can dispatch. The server schedules workers from durable intent without running a harness in the HTTP handler or changing the record transport.
- [x] Reconciliation runs while the server is alive even with no tabs. Cover acceptance-before-launch, contender workers, worker loss, idle exit, and restart without stranding or silently repeating input.
- [x] Worker environment and startup arguments preserve the resolved root and saved selections without inherited harness pins. Setting changes alone do not create new input or authorization.
- [x] Folder and settings remedies update locked sidecars and release only applicable prerequisite holds; a crash after save is recoverable. Unsupported context or route capabilities remain visible holds.
- [x] Comparison holds retain their own codes, skip rules, newer-artifact/explicit-attachment triggers, and suppression across automatic worker restart. A later eligible ordinary input can run. Explicit attachment intent uses a stable identity consumed once; automatic attaches never release suppression. An incompatible live source has visible upgrade/wait guidance.
- [x] New attach capability and managed envelopes prevent incompatible sources from receiving managed work; old delivery cursors cannot discard it. Keep default enablement off until the remaining continuation/recovery contracts are delivered.
- [x] Demo submit-to-answer with a deterministic process harness, tab closure, and reload. Update server, source, driver, and architecture contracts and pass the full repository gate.

## Parent

[Connect the hub to local conversations](https://github.com/dungle-scrubs/lucid-v2/issues/199). Contract: RFC 15, local hub conversation integration.

## Verification

Final integration: 1,330 deterministic tests and 6,780 assertions pass, plus lint, both typechecks, binary build, behavior reference, and diff checks. Browser evidence covers 390, 768, and 1440 pixels, full-width pointer resizing, stable menu placeholder color, tab closure and reload, and explicit failure recovery. hcn 0.6.4 is published and pinned; Pi recordings were recaptured on mini. Installed Claude/Opus context inspection reports a verified native budget. These live observations supplement the deterministic gate. Review findings and process lifecycle regressions are resolved.

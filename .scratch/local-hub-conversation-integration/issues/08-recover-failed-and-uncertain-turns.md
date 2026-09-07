# Recover failed and interrupted turns

Status: open
Blocked by: 07
GitHub: [Recover failed and interrupted turns](https://github.com/dungle-scrubs/lucid-v2/issues/212)

## What to build

When startup or execution cannot finish, show what happened and only the recovery actions that can work. Preserve the submitted prompt, its partial results, and the selected model while the person chooses how to continue.

## Acceptance criteria

- [ ] Durable attempts distinguish completed, pre-start-failed, failed-after-start, and uncertain outcomes. A matching durable terminal event can reconcile completion without executing again. Termination between intent persistence and process launch conservatively remains uncertain unless positive durable evidence proves no execution; explain that possible effects are not confirmed effects.
- [ ] Retry and Continue in a new session carry stable action IDs and expected attempts. Stale actions and changed duplicate payloads are refused; repeated identical actions cannot start extra attempts.
- [ ] Known pre-start failures offer applicable remedies. Unknown refusal is not labelled a missing session; do not silently fall back to the prior model or automatically create a fresh native session.
- [ ] Post-start failed or uncertain execution shows partial output and requires acknowledgement of possible existing effects before fresh continuation. It carries partial context and the original request with instructions to inspect current workspace state.
- [ ] Recovery preserves the accepted input identity even when it already has an applied disposition. A new authorized attempt is not a duplicate input or another initial-applied event; uncertain native coverage is never silently resent.
- [ ] Comparison preparation keeps its accepted recovery triggers and gains no generic Retry/Resume button. Failed or unknown startup never causes a periodic retry/spawn loop.
- [ ] Apply one refusal policy across compatible terminal and hub drivers. Verify upgrade/read-only rollback boundaries, explicit old-writer limitations, and no stranded managed intents.
- [ ] Enable managed execution by default only after all required route, context, lifecycle, and recovery contracts pass. Run full checks, build, and browser flows at 390, 768, and 1440 pixels; retain live-harness confirmation as separately labelled on-demand evidence.

## Parent

[Connect the hub to local conversations](https://github.com/dungle-scrubs/lucid-v2/issues/199). Contract: RFC 15, local hub conversation integration.

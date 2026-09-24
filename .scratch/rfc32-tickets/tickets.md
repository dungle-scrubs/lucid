# RFC 32 implementation tickets (local drafts; GitHub publication held for approval)

Parent: RFC 32 docs/rfc/32_any-session-handoff-to-lucid.rfc.md (Accepted), review docs/rfc/32_any-session-handoff-to-lucid.review-v1.md.
Machine-made breakdown (no human present for granularity check).

## T1: Handoff command with payload validation and crash recovery

### What to build

`lucid handoff --request FILE [--json]` works end to end: a JSON request file with creationId, serverUrl, artifact, continuation, workingDirectory, and optional settings creates a record, appends the artifact version and the continuation input, attaches the invoker as source holding presence across creation, and prints the artifact URL. A retry with the same creation key returns the same conversation id for byte-identical requests and refuses differing ones. Crashes recover into drafted, published-unattached, or attached states. Oversize (including multibyte past the code-unit limit), bad folder, and conflicting-retry refusals observed.

### Acceptance criteria

- [ ] `bun run check` green
- [ ] Round trip against a disposable record: request file in, artifact URL out, continuation dispatches as first task
- [ ] Multibyte oversize, bad folder, and conflicting-retry refusals observed with existing vocabulary (E-HUB-01/02/03/04)
- [ ] Crash injection before artifact write and before attach recovers into the RFC's stated states
- [ ] The handoff path does not record the native-publication requirement

## T2: Review hold with projection states

Blocked by: T1.

### What to build

After publish the invoker stays attached for the configured window (default 30 minutes idle, append-based clock), the browser shows connected with time left, then detaching, then gone with reconnect instructions. Explicit detach ends the hold at a turn boundary (yield) or past the grace bound (shutdown). Timeout detaches the same way. Later input resumes under the RFC's admission rule. Heartbeats keep the lease but never reset the idle clock.

### Acceptance criteria

- [ ] `bun run check` green
- [ ] Hold keeps presence for the configured window measured against log appends, not busy-state
- [ ] Timeout detaches with `yield` at a boundary, `shutdown` past the grace bound
- [ ] Browser shows connected with time left, detaching, then gone; later input resumes per the RFC rule
- [ ] Uncertain attempts need explicit fresh authorization, never automatic replay

## T3: Handoff skill documentation

Blocked by: T1.

### What to build

The authoring skill states the marker rule, the fence shape, and the handoff command path for markerless sessions, so a plain session (or the human relaying for it) knows how to reach a Lucid record.

### Acceptance criteria

- [ ] Skill text covers marker-present publish, markerless handoff command, and the fence shape for each
- [ ] A markerless dry run reaches the handoff command docs without inventing flags

## T4: Flaky background-launch test quarantine

### What to build

Two background-launch tests failed once in a full run and passed twice on rerun with no code change. Quarantine or fix the flakiness per the repo's own rule (lint, test failures, and flakiness get fixed even when the current work did not cause them).

### Acceptance criteria

- [ ] The flaky tests identified by name with failure output captured
- [ ] `bun run check` green across three consecutive runs, or the tests quarantined with a tracking issue

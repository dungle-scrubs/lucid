# 01-piping - Progress Report

> Auto-generated from the implementation plan. This is the canonical source
> of truth for what is done and what remains. Update this file as features
> are implemented - never mark a milestone complete until every
> current-cutoff checkbox under it is checked.

> Current focus: Phase 1 - The append transaction (M1.1 done; next M1.2)

## Phase 1: The append transaction (workstream A)

### M1.1: The `flock` primitive
Source: new `src/store/lock.ts`; port from `~/dev/lucid/src/core/lock.ts` (flock path only)

- [x] `acquire(path, {timeoutMs})` returns a held exclusive lock
- [x] a second `acquire` on the same path blocks, then times out to `E001 lock-timeout`
- [x] releasing the handle frees the lock for the next acquirer
- [x] `flock(2)` acquired via `bun:ffi` with `LOCK_EX|LOCK_NB` in a bounded retry loop
- [x] the lock is kernel-released when the holding process dies (dies-with-process)
- [x] `lockBackend()` reports the live backend (`flock`)
- [x] read-only-viewer fallback path is inspectable via `lockBackend()`
- [x] no O_EXCL / lockfile / stale-steal path is reachable
- [x] module comment names the rejected pid-file/stale-steal anti-patterns and what the module is NOT

### M1.2: The append transaction
Source: `src/store/` (wraps the existing store append + catch-up-fold)

- [ ] an append re-folds from the last known byte offset under the lock
- [ ] the reduce sees current state (a second writer's committed entry is visible before this reduce)
- [ ] transaction sequence is acquire -> catch-up-fold -> reduce -> write-all -> `fsync` -> release
- [ ] the write loops on a short `writeSync` return
- [ ] a partial write is never counted complete
- [ ] a write/`fsync` failure truncates to the byte offset captured under the lock immediately before the write
- [ ] truncation never uses a stale open-time offset
- [ ] a write/`fsync` failure raises `append-failed` (E005)
- [ ] a torn-interior line seen under the lock is rejected as `corrupt-log` (E002)
- [ ] the transaction reuses the store's existing fold, not a copy
- [ ] a fold that establishes an append offset or truncates holds the append lock
- [ ] a pure read-only viewer may fold lock-free, tolerating a torn trailing line

### M1.3: Two-writer real-`flock` integration check
Source: new integration test (spawns two real processes)

- [ ] two real processes append to one log concurrently under the real `flock`
- [ ] the resulting log has no torn lines
- [ ] seqs are strictly increasing with no epoch/seq collision
- [ ] the reopened fold matches the union of both writers' entries

## Phase 2: CLI, hooks, and interactive liveness (workstream C)

### M2.1: CLI frame mapping + `lucid send` + `lucid watch`
Source: new `src/cli/`; reuse `src/tui/` view-model

- [ ] `mapSubcommand(argv) -> Frame` maps each subcommand to its protocol frame
- [ ] `lucid send <conversation> <text>` maps to a transient `input` append
- [ ] the `send` input is folded by the NEXT `lucid run` (not delivered live, `D-011`)
- [ ] `lucid watch` folds the log and emits the TUI view-model
- [ ] `watch` refreshes as the log grows
- [ ] `watch` holds no lock
- [ ] `watch` dispatches nothing
- [ ] `watch` reuses the `src/tui/` view-model shape (no duplication)

### M2.2: `lucid run` (headless orchestration)
Source: new `src/cli/run`; promotes `scripts/smoke-live.ts`

- [ ] `run` creates/opens the conversation record
- [ ] `run` folds the log ONCE at start
- [ ] `run` acquires the presence lock
- [ ] `run` opens a headless source on `nodeRunnerDeps`
- [ ] `run` drives as the single live source (no tailer)
- [ ] `run` emits a run-level boundary event keyed by `conversationId`
- [ ] the promoted live smoke passes end-to-end through `lucid run`

### M2.3: Hooks - `announce` / `inject` with identity verification
Source: new `src/cli/hooks/`; port env-stamp/self from v1; spike `spikes/evidence/A-002.md`

- [ ] `announce` reads the SessionStart payload from stdin
- [ ] `announce` resolves the record via the env-stamp
- [ ] `announce` verifies identity against `meta.json`
- [ ] `announce` appends `attach` (+ identity) on a match
- [ ] `announce` on a `meta.json` mismatch exits non-destructively (E003), never writes the wrong record
- [ ] `inject` on the PostToolUse boundary resolves + verifies the record
- [ ] `inject` reads queued input
- [ ] `inject` appends the delivery + `disposition`
- [ ] `inject` emits the injection via hook stdout (`{decision: "block", reason}`)
- [ ] `inject` on a reducer refusal reports the disposition class, no blind retry (E004)
- [ ] injected input is chunked under a cap measured in encoded UTF-8 bytes (post-JSON-escape)
- [ ] lucid detects and coexists with pre-existing project hooks; its `decision` output composes, never clobbers (`D-014` C2)
- [ ] `HERDR_ENV` is unset for the child
- [ ] the injection contract does not depend on the Stop hook firing (Stop is best-effort, `D-014`)

### M2.4: Env-stamp + self-invocation (port from v1)
Source: port `~/dev/lucid/src/launch/env-stamp.ts`, `src/cli/self.ts`

- [ ] `envStamp(record) -> env` sets the record dir + turn id
- [ ] `selfInvocation() -> argv[]` reconstructs lucid's own invocation
- [ ] hook commands use exec-form argument arrays, never interpolated shell strings
- [ ] self-invocation uses exec-form argument arrays
- [ ] a stale/reused `LUCID_RECORD_DIR` is caught by the M2.3 `meta.json` verification

### M2.5: Presence-lock lifecycle
Source: source-adapter wiring (not the reducer)

- [ ] the presence lock is acquired at attach
- [ ] the presence lock is held for the source's lifetime
- [ ] release is bound to the claude process's death via pipe-EOF reap
- [ ] killing the session process kernel-releases the presence lock
- [ ] a false-alive cannot persist after death
- [ ] "attached" tracks the held lock, not a clock
- [ ] `presence.acquire` / `presence.released` events are emitted

## Phase 3: Same-machine handoff smoke (workstream D)

### M3.1: Two-process baton-pass handoff smoke
Source: new `scripts/smoke-handoff.ts`; evidence to `spikes/evidence/`

- [ ] two real processes share one conversation (a headless `lucid run` + a second participant)
- [ ] the second participant `lucid send`s input in
- [ ] the incumbent yields (its presence lock frees)
- [ ] the successor folds the durable log and takes over
- [ ] the handoff is ordered and at-least-once (no lost input; deduped on replay, the `D-020` property)
- [ ] the reopened fold matches the live transcript across the handoff
- [ ] the run is evidence-logged to `spikes/evidence/`

## Out of scope (future plan, not tracked here)

Workstream B - **live delivery to a running host** (the follow-tailer,
executor lease, delivery cursor, at-least-once/dedup ownership machinery) -
is deferred with the scope cut (`D-011`; decisions `D-006`/`D-007` recorded
for a future live-delivery plan). It is NOT current-cutoff debt and carries
no checkboxes here.

## Summary
- Total features: 73 (current-cutoff)
- Completed: 9
- Remaining: 64
- Current cutoff blockers: 64
- Accepted/deferred follow-up: 0
- Superseded/obsolete checklist debt: 0

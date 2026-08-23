---
number: 02
title: "Consume the normalizer through hcn"
type: migration
status: Implemented
author: Kevin Frilot
date: 2026-08-22
---

# RFC-02: Consume the normalizer through hcn

## Abstract

lucid-v2 imports the normalizer's internal modules (`openSession`,
`streamTurn`, `nodeRunnerDeps`, the four descriptors, `capabilitiesOf`,
`contentEventsOf`, and the test fakes) through a `file:` alias that Bun
resolved as per-file symlinks into the neighbouring checkout. The normalizer
has since shipped 0.5.3 under decision D-001: the `hcn` binary is the only
supported surface. This RFC moves lucid-v2 onto that surface. The harness
seam that `HeadlessDeps.runner` already marks becomes a lucid-owned
`HarnessRunner` interface with one production implementation that spawns
`hcn` and decodes its NDJSON, and one test implementation driven by captured
`hcn` fixtures. The protocol reducer, the store, the hooks, and the CLI
frames do not change. The migration depends on normalizer RFC-01 (`hcn
session --json`).

## Introduction

### Problem

`package.json` declares `"@dungle-scrubs/harness-cli": "file:../harness-cli-normalizer"`.
Five source files and two test files import paths under that alias's
`src/` and `test/` trees:

| lucid-v2 file | imports |
|---|---|
| `src/modes/host.ts` | `openSession`, `streamTurn`, `RunnerDeps`, `HarnessEvent`, `HarnessDescriptor` |
| `src/modes/sequencer.ts` | `RunnerDeps`, `HarnessEvent`, `HarnessDescriptor` (types) |
| `src/modes/interactive-host.ts` | `capabilitiesOf`, `contentEventsOf`, `asRecord`, `HarnessDescriptor` |
| `src/cli/runtime.ts` | `nodeRunnerDeps`, `HarnessDescriptor` |
| `src/cli/harness.ts` | `claudeCode`, `codexCli`, `piCli`, `museCode` |
| `scripts/smoke-live.ts` | `nodeRunnerDeps`, `claudeCode` |
| `test/modes/headless.test.ts`, `test/modes/interactive.test.ts` | `claudeCode`, `FakeClock`, `FakeProcess`, `fakeSignal`, `fakeSpawner` |

`bun run check` is green (122 tests) only because the checkout is present
and unchanged at the symlink targets. The package the normalizer publishes
is named `@dungle-scrubs/harness-cli-normalizer`, ships `src/` without an
`exports` map, and does not ship `test/`. Installing it from npm breaks the
fakes import at once and the rest whenever the internals move. The
normalizer's README, AGENTS.md, and readiness audit all state that the
internals are not an install surface.

### Scope

In scope:

- Replace every normalizer import with calls to the `hcn` binary, behind a
  lucid-owned runner seam.
- Replace the `file:` dependency with the published package, pinned.
- Replace the borrowed test fakes with lucid-owned fakes that emit `hcn`
  NDJSON.
- Remove the transcript-tail decoder, which has no production caller.
- Update `AGENTS.md`, the smoke scripts, and the evidence they write.

Out of scope:

- Any change to the protocol reducer, ledgers, store, flock, presence,
  hooks, or CLI frame mapping. The migration touches the harness edge only.
- Workstream B (live delivery), the pi/codex/muse vertical slices, and the
  artifact layer. Those plans follow this one.
- Changes to the normalizer. Those are RFC-01 in that repository.

### Motivation

The dependency is unsupported today and breaks on the first internal move.
Every later plan (live delivery, more harnesses, the review surface) builds
on the harness edge; migrating first keeps those plans from re-doing this
work.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD
NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted
as described in RFC 2119.

- **normalizer**: `@dungle-scrubs/harness-cli-normalizer`, the package that
  ships `hcn`.
- **hcn**: the normalizer's CLI binary.
- **harness**: one of `claude`, `codex`, `pi`, `muse`, named as `hcn` names
  them.
- **runner**: the lucid-side object that opens sessions and streams turns.
  Today it is the normalizer's `RunnerDeps`; after this RFC it is lucid's
  `HarnessRunner`.
- **HarnessEvent**: the NDJSON event vocabulary `hcn --json` emits
  (`identity`, `token`, `message`, `progress`, `tool`, `context`, `limit`,
  `error`, `failure`, `question`, `done`).
- **control event**: the session-scoped events RFC-01 adds (`session`,
  `turn`, `disposition`, `closed`).
- **source**: lucid's term for the process that speaks protocol frames to
  the store host on a harness's behalf (`SourceChannel`).
- **fixture**: a captured `hcn --json` stdout stream kept as evidence.

## Current State

```
lucid run
  src/cli/runtime.ts ── nodeRunnerDeps() ──────────────┐
  src/cli/harness.ts ── claudeCode | codexCli | ... ───┤ normalizer src/ (symlinked)
  src/modes/host.ts  ── openSession / streamTurn ──────┤
  src/modes/interactive-host.ts ── capabilitiesOf,     │
                                   contentEventsOf ────┘
test/modes/*.test.ts ── FakeProcess, fakeSpawner ──── normalizer test/ (symlinked)
```

`HeadlessHost` (`src/modes/host.ts`) already isolates the two runner calls
in a strategy table: `sessionStrategy` calls `openSession(harness,
{sessionId}, runner)` and uses `session.send`, `session.turns`,
`session.close`; `turnStrategy` calls `streamTurn(harness, {prompt,
resume}, {...runner, turnId})` per queued input and captures the
`identity.sessionId` for the next resume. Everything above those two calls
(turnId minting, FIFO disposition, credit forwarding, detach) is lucid's
and stays.

`HarnessDescriptor` reaches lucid for two reads: `name` (spawn, logs,
`contentEventsOf` dispatch) and `sessionMode !== null &&
capabilities.session` (`supportsSession` in `src/cli/harness.ts`).

`tailTranscript` and `attachCapabilities` are exported from
`src/modes/interactive-host.ts` and re-exported through
`src/modes/interactive.ts` and `src/modes/index.ts`. Their only callers are
`test/modes/interactive.test.ts`. No CLI path, hook, or host calls them.

The fakes: `test/modes/headless.test.ts` builds a rig from the normalizer's
`FakeProcess` (scripted stdout chunks, `exited` promise, stdin capture),
`FakeClock`, `fakeSignal`, and `fakeSpawner`, and feeds raw claude
stream-json lines (`system/init`, `assistant`, `result`). The test
therefore proves the normalizer's claude decoding as a side effect, which
the normalizer's own suite already proves.

## Target State

```
lucid run
  src/cli/runtime.ts ── hcnRunner({bin, clock, spawn, signal, log}) ──┐
  src/cli/harness.ts ── name validation + `hcn inspect --json` ───────┤
  src/modes/host.ts  ── runner.openSession / runner.streamTurn ───────┤── spawns `hcn`
  src/modes/interactive-host.ts ── runner.capabilities ───────────────┘
test/modes/*.test.ts ── fakeRunner / FakeHcnProcess + fixtures (lucid-owned)
```

### The runner seam

A new deep module `src/harness/` owns every fact about `hcn`. Its public
surface:

```ts
// src/harness/runner.ts
export interface HarnessRunner {
  /** Persistent session: `hcn session <h> --json`. Throws HarnessRefusal
   *  (exit 2 before spawn) or HarnessSpawnError. */
  openSession(opts: { harness: HarnessName; sessionId: string; model?: string;
                      cwd?: string; stallMs?: number }): SessionHandle;
  /** One-shot turn: `hcn run <h> --json`. Never throws from first next();
   *  a refusal arrives as failure + done. */
  streamTurn(opts: { harness: HarnessName; prompt: string; resume?: string;
                     model?: string; cwd?: string; turnId: string }): AsyncIterable<HarnessEvent>;
  /** `hcn inspect <h> --json` projected to what lucid reads. No harness spawn. */
  inspect(harness: HarnessName): Promise<HarnessFacts>;
  /** `hcn inspect <h> --capabilities`. No harness spawn. */
  capabilities(harness: HarnessName, model: string, mode: HarnessMode): Promise<CapabilityResult>;
}

export interface SessionHandle {
  readonly turns: AsyncIterable<AsyncIterable<HarnessEvent>>;
  send(id: string, text: string): Promise<Disposition>;   // started | queued | rejected
  close(): Promise<Closed>;                               // the closed event
}

export interface HarnessFacts {
  readonly name: HarnessName;
  readonly session: boolean;       // sessionMode !== null
  readonly verifiedAgainst: string;
}
```

Rules:

- `SessionHandle.turns` MUST keep the shape `HeadlessHost` consumes today:
  one inner iterable per turn, ending in that turn's `done`. The adapter
  rebuilds it from the flat stream using RFC-01's `turn` events as
  boundaries.
- `send` returns the disposition from the matching `disposition` event. It
  is async because the answer crosses a pipe; `HeadlessHost.onInput` MUST
  keep its synchronous contract by recording `queued` immediately and
  reconciling to `applied` or `rejected` when the disposition arrives. The
  sequencer already has the `queued -> applied` flip at the turn boundary;
  the adapter's `turn.id` is what drives it now instead of position.
- `HarnessEvent` is a lucid type in `src/harness/events.ts`: the eleven
  kinds with the fields lucid reads, decoded from JSON with a shape check.
  An unknown `kind` MUST be passed through as `{kind, ...}` so the
  reducer's ledger (`src/protocol/ledgers/`) can record it, never dropped
  and never thrown on. This keeps the README's additive-kinds promise on
  lucid's side.
- `src/protocol/events.ts` keeps owning `HarnessEventKind` and the
  `EventKind` vocabulary; `src/harness/events.ts` MUST derive from it, not
  mirror literals (AGENTS.md rule).
- The `hcn` binary path resolves in this order: `LUCID_HCN` env var, the
  package-local `node_modules/.bin/hcn`, then `hcn` on `PATH`. The runner
  MUST log which one it chose in its boundary log.
- On `openSession`, the adapter MUST read the `session` event and refuse
  with `HarnessVersionError` when `session.hcn` is below `HCN_MIN_VERSION`
  (the version RFC-01 ships in). `hcn run --json` has no such event; the
  adapter checks `hcn --version` once per process and caches it.
- `HarnessDescriptor` disappears from lucid. `src/cli/harness.ts` keeps the
  alias table (`claude-code -> claude`, `opencode -> muse`, ...) and
  validates a name; it returns a `HarnessName`, not a descriptor.
  `supportsSession(name)` becomes `(await runner.inspect(name)).session`,
  called once per `lucid run` in `src/cli/runtime.ts` before the profile
  is chosen. This is the runtime-verified capability PLAN decision D-008
  asked for.

### The fakes

`test/harness/fakes.ts` owns `FakeHcnProcess`, `FakeClock`, `fakeSignal`,
and `fakeSpawner`. They are lucid's because the normalizer does not ship
them, and because what lucid must prove is its own handling of the `hcn`
process: argv, stdin command writes, stdout framing, exit codes, SIGTERM on
close. Scripts feed `hcn` NDJSON, not claude stream-json.

Fixtures live in `test/fixtures/hcn/` as captured `hcn --json` stdout
(`session-claude-two-turns.ndjson`, `run-claude-clean.ndjson`,
`run-claude-limit.ndjson`, `session-claude-stall.ndjson`, and the refusal
pair). They are evidence: captured by `scripts/capture-hcn-fixtures.ts`
against an installed `hcn`, committed, never hand-edited. A test that needs
a sequence no fixture shows MAY compose one inline and MUST say so.

### What is removed

- `tailTranscript`, `TailResult`, `attachCapabilities` as a free function,
  and the `contentEventsOf` / `asRecord` imports. `InteractiveHost.tail`
  goes with them. `InteractiveHost.capabilities` stays and calls
  `runner.capabilities`. Rationale: no production caller; the hooks rung
  delivers through `inject` on the PostToolUse boundary and never reads the
  transcript. When a caller exists, RFC-01 Open Question 3 (`hcn decode`)
  is the path back.
- The `file:` dependency and the `@dungle-scrubs/harness-cli` alias.
- The `bun.lock` entries for the alias.

### What is added to `package.json`

```json
"dependencies": {
  "@dungle-scrubs/harness-cli-normalizer": "0.6.0"
}
```

Exact pin, not a caret: `hcn` is a process contract and lucid's fixtures
are captured against one version. Bumping it is a deliberate commit that
re-captures fixtures.

## Migration Strategy

Each step is one commit, green on `bun run check` before the next starts.
No dual-write period: the cutover is per module and the old import is
deleted in the same commit that replaces it.

1. **Pin the published package beside the alias.** Add
   `@dungle-scrubs/harness-cli-normalizer` (the RFC-01 release) so
   `node_modules/.bin/hcn` exists. Nothing else changes. Verify:
   `bun run check`; `node_modules/.bin/hcn --version` prints the pin.
2. **Add `src/harness/` with the runner interface, the `hcn` adapter, the
   event decoder, and the fakes.** No caller yet. Tests: decoder shape
   checks, unknown-kind passthrough, turn regrouping from fixtures,
   disposition correlation, close -> `closed`, refusal -> exit 2, version
   floor. Verify: `bun test test/harness`.
3. **Cut `src/modes/host.ts` and `src/modes/sequencer.ts` over.**
   `HeadlessDeps.runner` becomes `HarnessRunner`; `HeadlessDeps.harness`
   becomes `HarnessName`. `test/modes/headless.test.ts` rig swaps the
   normalizer fakes for `FakeHcnProcess` fed from fixtures; every existing
   assertion on the store log (seq, turnId, disposition, credit, detach)
   MUST still pass unchanged. Verify: `bun test test/modes/headless.test.ts
   test/store/store.test.ts test/protocol/reducer.test.ts`, then the full
   suite.
4. **Cut `src/cli/runtime.ts` and `src/cli/harness.ts` over.**
   `nodeRunnerDeps()` becomes `hcnRunner(nodeDeps())`; descriptor lookup
   becomes name validation plus `runner.inspect`. `LUCID_HARNESS` keeps
   its meaning. Verify: full suite; `bun src/cli/main.ts run --harness
   codex` against a missing binary reports the spawn error through the
   runner, not a stack trace.
5. **Cut `src/modes/interactive-host.ts` over and remove the tail.**
   `capabilities` goes through the runner; `tailTranscript` and its tests
   are deleted; `src/modes/interactive.ts` and `src/modes/index.ts` drop
   the re-exports. Verify: full suite; `grep -r harness-cli src test` is
   empty except `scripts/`.
6. **Cut the smoke scripts over and drop the alias.** `scripts/smoke-live.ts`
   and `scripts/smoke-handoff.ts` use the runner; `package.json` loses the
   `file:` alias; `bun install` regenerates `bun.lock`. Verify: `bun run
   check`; `grep -r harness-cli .` finds only docs.
7. **Re-run the live lanes and refresh evidence.** DF-SMOKE through
   `lucid run` against claude; the handoff smoke; the LM Studio lane on
   `mini` once RFC-01 Open Question 1 (`--provider` on `hcn session`) is
   settled. Write to `spikes/evidence/`. Update `AGENTS.md` ("Harness-cli"
   section: the descriptor is no longer imported; `hcn` is the source;
   fixture capture replaces the fake-spawner note).

Go/no-go between steps: the full suite is green and the step's `grep`
check holds. A step that needs a normalizer change stops and files it
against RFC-01 rather than working around it in lucid.

## Backward Compatibility

- The conversation record on disk (`log.ndjson`, `meta.json`, the secret,
  the locks) does not change. A record written before the migration folds
  identically after it: the reducer and ledgers are untouched.
- `HarnessEventKind` and the `EventKind` vocabulary in
  `src/protocol/events.ts` do not change. The `event` frames in the log
  keep their shape.
- `lucid run`, `send`, `watch`, `announce`, `inject` keep their argv and
  their frames. `--harness` keeps its aliases.
- `LUCID_HARNESS` keeps its meaning. `LUCID_HCN` is new and optional.
- The `docs/skill-chat-substrate.md` contract for sources is unchanged: it
  never mentioned the normalizer's internals.
- Removed exports (`tailTranscript`, `TailResult`, free
  `attachCapabilities`) had no caller outside tests; no consumer exists
  that imports lucid-v2 as a package.

## Rollback Plan

- Steps 1-2 add code with no caller: revert the commit.
- Steps 3-6 each revert independently to the previous green state because
  each deletes the old import in the same commit that adds the new call;
  reverting restores both. The `file:` alias stays in `package.json` until
  step 6, so the old path compiles throughout steps 1-5.
- After step 6, rollback means re-adding the `file:` alias and reverting
  steps 3-6 in reverse order. `bun install` restores the symlinks.
- Evidence files under `spikes/evidence/` are append-only; a rollback
  leaves the new evidence in place with a note.

## Risk Assessment

- **Process per harness call.** `lucid run` now spawns `hcn`, which spawns
  the harness. One more process per session or per turn. Startup cost is
  Node boot, tens of milliseconds; no data risk. A stall in `hcn` itself
  is caught by `--stall` and the presence lock as a harness stall would be.
- **Disposition becomes asynchronous.** `HeadlessHost.onInput` is
  synchronous today. The adapter records `queued` at once and reconciles;
  a bug here shows as a wrong `applied` timing in the store log, which
  `test/modes/headless.test.ts` asserts line by line. Low data risk, fully
  oracle-covered.
- **Fixture drift.** A normalizer release can change event fields. The
  exact pin plus `HCN_MIN_VERSION` make the drift a deliberate bump with
  re-capture, never a silent pass.
- **Lost coverage.** Deleting the borrowed fakes drops the incidental
  proof that lucid decodes claude stream-json. That proof belongs to the
  normalizer's suite and lives there. Lucid's new fixtures prove the `hcn`
  contract instead, which is the contract lucid now depends on.
- **Blast radius.** The harness edge only. The store, reducer, hooks, and
  locks are untouched; a migration bug cannot corrupt a record, because
  every append still goes through the same transaction.
- **Downtime.** None; lucid-v2 has no deployed instance. The window is the
  branch's lifetime.

## Validation & Testing

- `bun run check` green after every step (lint, `tsc --noEmit`, 122 tests
  minus the deleted tail tests plus the new `test/harness` suite).
- Oracle preservation: every assertion in `test/modes/headless.test.ts`,
  `test/store/store.test.ts`, `test/protocol/*`, `test/gate-5-6.test.ts`
  on log content passes unchanged. The rig changes; the expected log does
  not.
- Contract proof: `test/harness/` asserts the adapter against captured
  `hcn` fixtures for: two-turn session with a queued send, turn
  regrouping, `awaiting-input` turn then `answer`, close -> `closed` ->
  exit 0, harness death -> `closed cause=crash` -> exit 1, refusal -> exit
  2, malformed event line -> error not crash, unknown kind passthrough,
  version floor.
- Evidence gates: `grep -r harness-cli src test scripts` empty; `ls
  node_modules/@dungle-scrubs/` shows only `harness-cli-normalizer`.
- Live confirmation (not gating, evidence-logged per AGENTS.md): DF-SMOKE
  via `scripts/smoke-live.ts` against claude; `scripts/smoke-handoff.ts`;
  the LM Studio lane on `mini` when RFC-01 OQ1 lands.

## Timeline

No dates. Phases and their dependencies:

| phase | depends on | go criterion |
|---|---|---|
| A. RFC-01 accepted and released in the normalizer | RFC-01 review | `hcn session claude --json` exists in a tagged release |
| B. Steps 1-2 (pin, `src/harness/`) | A | `bun test test/harness` green against fixtures captured from that release |
| C. Steps 3-5 (host, runtime, interactive) | B | full suite green, store-log oracles unchanged |
| D. Step 6 (alias removed) | C | `grep` gates hold, `bun run check` green |
| E. Step 7 (live lanes, evidence, AGENTS.md) | D; OQ1 for the LM Studio lane | evidence files written |

## Open Questions

None open. Decided 2026-08-22, recorded here so the path is visible:

1. **Session support** comes from `hcn inspect <h> --json`, once per
   `lucid run`, before the profile is chosen. It is a pure descriptor read
   with no harness spawn, so the mode is explicit before anything starts.
   Rejected: try `hcn session` and fall back on the `no-session-mode`
   refusal, because that decides the mode inside an error path and any
   other refusal would read as "no session mode."
2. **Answers to questions** go out as the `answer` op. `HeadlessHost`
   sees every `done`; when the last one has cause `awaiting-input`, the
   next input is sent as `answer` and hcn composes the preamble it owns.
   Rejected: plain `send`, which drops the preamble and leaves the model a
   reply with no link to the question.
3. **Fixtures** are captured against claude in step 2, and against pi on
   LM Studio in step 7, after RFC-01 ships `--provider` on `hcn session`.
4. **Pin** is an exact version. Fixtures are recordings of one hcn
   version; a caret range would let `bun install` move the binary under
   them. A bump is one commit that re-captures.

## What implementation changed

One line per deviation from the plan above, so the next reader sees the path
without diffing anything.

- **Steps 3 and 4 landed as one commit.** Retyping `HeadlessDeps` retypes
  `runtime.ts` in the same edit, so splitting them would have meant a commit
  with a red tree. Every-commit-green is the rule this migration runs on, and
  it wins over the step count.
- **`startHeadless` became async.** OQ1 chose `hcn inspect` for session
  support, and that answer crosses a process boundary. Its one caller was
  already async, so the ripple stopped there.
- **The `file:` alias broke at step 1, not step 6.** Pinning the published
  package changed nothing, but the alias tracks the neighbouring checkout, and
  that checkout had just gained the id-carrying send. `src/modes/host.ts`
  failed to typecheck immediately. The fragility this migration exists to
  remove demonstrated itself on the first commit.
- **The fixtures caught a live rate-limit warning.** The recorded two-turn
  session carries a real `rate-limit` failure whose turn still produced a
  message, so the regrouping test exercises a failure path that was not
  designed into it.
- **`AsyncQueue` is new and lucid-owned.** The adapter needs a queue twice
  (turns, and each turn's events) and the normalizer's is not importable. It
  deliberately has no backpressure: hcn's channel already stalls the harness
  and lucid's credit ledger already bounds the consumer, so a third bound
  would be a third opinion about one flow.
- **`test/fixtures/hcn` and `scripts/capture-hcn-fixtures.ts` were added.**
  The RFC named fixtures but not the capture path; recording them has to be
  reproducible or the next version bump cannot re-record.

## References

### Normative

- harness-cli-normalizer `docs/rfc/01_machine-session-surface-hcn-session-json.rfc.md` -
  the wire contract this migration targets.
- harness-cli-normalizer README, "CLI", "Failure taxonomy", "Status"
  (D-001: CLI-only surface).
- `src/modes/host.ts` - `HeadlessHost`, the strategy table that holds the
  two runner calls.
- `src/cli/runtime.ts`, `src/cli/harness.ts` - where the runner and the
  harness name are resolved.
- `src/protocol/events.ts` - `HarnessEventKind`, the vocabulary lucid owns.
- `AGENTS.md` - gates, verification discipline, the live lanes.

### Informative

- `PLAN.md` Part 0 and "Decisions" D-008 (runtime-verified capability),
  D-010 (package name, superseded by the normalizer's published name).
- The completed `01-piping` plan this follows. Its artifacts were removed
  with the retired plan-db tooling; read them at `git log -- .plans/`, and
  its decisions in `docs/decisions.md`.
- `docs/smoke-seven.md`, `spikes/evidence/df-smoke.md` - the live lanes
  step 7 re-runs.
- harness-cli-normalizer `docs/audits/2026-08-21-readiness/report.md` -
  the audit that names the disposition gap and the library-import finding.

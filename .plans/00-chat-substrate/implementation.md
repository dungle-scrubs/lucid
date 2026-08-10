# 00-chat-substrate - Implementation Plan

## ⚠️ Execution Protocol

A progress report exists at `.plans/00-chat-substrate/progress-report.md`. It
lists every user-facing feature for every milestone as a checkbox.

**Mandatory rules for all agents working on this plan:**

1. Before starting a milestone, run `plan-db check-progress --plan
   "00-chat-substrate"` and read its section in the progress report - those
   current-cutoff checkboxes are your spec.
2. Check each box as you complete the feature, not at the end.
3. A milestone is NOT done until every current-cutoff checkbox under it is
   checked.
4. If you find features missing from the report, add them first.
5. Never declare a phase complete without updating the current focus marker
   and Summary.
6. Deferred follow-up (DF-1 A-003, DF-2 A-004) and superseded debt must not be
   counted as current blockers.
7. Milestone 0 (SPIKE) is DONE; its evidence in `spikes/evidence/` is the
   entry gate for Phases 3 and 5.
8. **Under `HERDR_ENV=1`: never kill processes by pattern; exact captured PIDs
   only. Any nested `claude` session uses `--setting-sources project` +
   `HERDR_ENV` unset (D-025).**

Source spec: `PLAN.md` (v4, ratified 2026-08-10) <!-- D-012 -->. This plan
covers <!-- D-016 --> build-order steps 1-7 only; step 8 (artifact,
annotation, review surface) is a future plan, per the governing constraint:
nothing review-shaped until the substrate is green against the invariants.

## 0. Hard Dependencies

No upstream plans. Environment prerequisites:

- claude CLI >= 2.1.226 on PATH (spike facts verified against it)
- Bun >= 1.1 and Node >= 24 installed
- `gh` authenticated as `dungle-scrubs` (private repo creation)
- codex / pi / muse CLIs installed for phase 2+ descriptors and the
  real-harness smoke (their absence blocks only their own milestones)

---

## Architecture

Two packages, one protocol, three integration modes.

```
~/dev/harness-cli-normalizer   @dungle-scrubs/harness-cli  <!-- D-010 -->
  knowledge/        descriptors as data (argv, identity, stores, flags)
  interpretation/   pure functions over descriptors
  execution/        openSession() + streamTurn(), injected {spawn, clock, signal}
                    emits HarnessEvent; knows NOTHING of the chat protocol

~/dev/lucid-v2
  protocol/         pure reducer: (state, frame) -> state | refusal
                    frames, epoch fencing, leases, replay, injected clock
  store/            durable conversation log; mints seq; mints the
                    per-conversation secret at record creation  <!-- D-004 -->
  modes/            headless-turn, headless-session, interactive adapters
                    (claude hooks / cooperative / observe-only rungs)
  tui/              minimal test surface  <!-- D-009 -->
```

<!-- D-001 --> The chat session protocol is owned by lucid-v2: a pure
reducer hosted by the durable store, which does the enforcement. The
reducer/host seam is a module boundary, not a package; extraction waits
for a second consumer. <!-- D-002 --> lucid mints `seq` on every accepted
frame; sources mint per-epoch monotonic `n`; `epoch` is the fencing token
carried on every post-attach frame - a takeover increments it and stale
frames are refused.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| <!-- D-016 --> No review surface until the test surface is green | TUI only; no browser code anywhere in this plan |
| Normalizer never imports chat types (PLAN.md 3.2 seam) | lucid-v2 maps `HarnessEvent` into frames; dependency is one-way |
| <!-- D-005 --> Normalizer runs on Node and Bun via injected primitives (spawn, clock, **signalling**) | no direct `child_process`/`Bun.spawn`/`process.kill` calls outside the injected boundary - kill/interrupt go through injected `signal` |
| <!-- D-015 --> lucid-v2 is Bun-first, plain TypeScript, no Effect | reducer and store are plain functions + data; Biome/Lefthook/tsc toolchain |
| Streaming is a declared granularity per (harness, mode, invocation) | descriptors pin flag sets; no code path may assume deltas exist |
| <!-- D-007 --> Wire transport deferred until after the spike | protocol code is transport-neutral; liveness is heartbeat-based by design so the transport choice cannot change the state machine |
| Event classes: droppable (`token`,`progress`,`context`) vs lossless (rest) | backpressure credits gate only the droppable class; lossless is replay-covered |
| <!-- D-018 --> The harness gives ZERO single-writer protection (A-005: concurrent resume appends into a live session) | lucid's presence gate + lease/epoch fencing is the only defense; every resume path in code or dev scripts goes through the gate |

### Boundaries

- **normalizer / lucid-v2**: `HarnessEvent` + `CapabilityResult` +
  `openSession`/`streamTurn` signatures. A non-lucid consumer can use the
  runner standalone.
- **reducer / host**: reducer is pure and clock-injected (every timeout
  path deterministic under test); the store owns durability, secret
  minting, and actual enforcement.
- **adapter / harness**: per-harness adapters speak the harness's own
  surface (claude: hooks + transcript tail). <!-- D-017 --> The claude
  ladder - hooks > cooperative > observe-only > headless takeover - is
  the template for every harness; resume-forking while presence holds is
  forbidden.
- New target files carry module-level comments stating what the module
  owns and why it exists (both repos).

### Observability

Runtime, transport, and recovery behavior all change here, so
observability is part of the feature, not a follow-up:

- One structured line per protocol transition at the host boundary:
  frame kind, conversationId, epoch, seq/n, verdict (applied/refused),
  refusal issue. The reducer returns these as data; the host logs them.
- Spans/correlation: a turnId correlates runner events, frames, and
  dispositions end to end; process spawns log argv (secrets redacted)
  and exit cause (clean/limit/crash/stall).
- Liveness evidence: heartbeat receipt, grace expiry, lease grant/expiry,
  epoch increments - each a structured event, so "why did it take over?"
  is answerable from the log alone.
- User-visible inspection: `lucid-v2 log <conversation>` (or TUI pane)
  folds the durable log; the fake-harness tests assert on the same
  structured events the operator reads.

---

## Assumptions

> Validated during SPIKE (see spike-guide.md). <!-- D-013 --> Spike code
> lives in `~/dev/lucid-v2/spikes/`, throwaway but kept as evidence.
> This section is removed at CONVERGE once learnings are merged.

| Code | Assumption | Status | Impact if False |
|------|-----------|--------|-----------------|
| A-001 | claude persistent headless session works as documented: one process, multi-turn, streaming input + token deltas | **pass** (evidence/A-001.md: 3 turns one process; mid-turn send = queued; `result` delimits turns; init re-emitted per turn) | - |
| A-002 | hooks adapter profile achievable: SessionStart announce, PostToolUse boundary inject, no terminal takeover | **pass** (core) (evidence/A-002.md: announce + mid-turn boundary inject at a Write boundary of turn 1 + terminal continuity; requires `--setting-sources project` **and `HERDR_ENV` unset for the child** <!-- D-025 -->; Stop-path partial) | - |
| A-003 | bare-session tiers work: transcript tail streams mid-turn with zero config; skill-driven cooperative polling delivers at turn end | **deferred** (driver startup-timeout; 0 arrivals) - retry recipe in evidence/A-003.md | fallback rungs 2-3 only; M5.3 entry criterion self-gates on this evidence before those rungs are built |
| A-004 | constraint characterization holds: ~10k hook feedback cap, hooks captured at session start, injected text visible in terminal | **deferred** (no architectural impact; measured at M5.3) | adapter contract wording + input chunking policy only |
| A-005 | headless-turn resume semantics: `--resume <id> -p` id rotation/fork behavior is detectable and re-bindable | **fail, learnings merged** (evidence/A-005.md: no rotation at all - resume the same id, one store file; BUT concurrent resume of a LIVE session appends with no guard) <!-- D-018 --> | consequence applied: presence gate + epoch fencing are the only single-writer defense; claude descriptor drops rotation handling |

---

## Phases

### Phase 1: Repos and toolchain

**Goal:** Both repos exist, private on GitHub, with toolchain, CI-less
verification commands, and empty-but-typed package skeletons.

**Gate from previous:** SPIKE complete - every assumption pass/fail/deferred.

#### M1.1: Normalizer repo scaffold

- **Dependencies:** none
- **Effort:** S
- **Testing:** test-after (scaffolding - nothing behavior-bearing yet; verify = typecheck, lint, empty test suite runs on Node and Bun)
- **Tasks:**
  1. `git init ~/dev/harness-cli-normalizer`; private GH repo <!-- D-014 -->
  2. package.json `@dungle-scrubs/harness-cli`, tsconfig strict, Biome,
     Lefthook, vitest (Node) + `bun test` smoke lane
  3. Layout: `src/knowledge/`, `src/interpretation/`, `src/execution/`,
     module comments per Boundaries
  4. Verify: `pnpm check` (lint+typecheck+test) green on Node; `bun test` green

#### M1.2: lucid-v2 repo scaffold

- **Dependencies:** none
- **Effort:** S
- **Testing:** test-after (scaffolding; verify = typecheck, lint, empty suite)
- **Tasks:**
  1. `git init ~/dev/lucid-v2`; private GH repo; `.plans/`, `spikes/`,
     `docs/` kept; `.lucid/` run/ ignored per lucid conventions
  2. Bun-first package: bunfig, tsconfig strict, Biome, Lefthook <!-- D-015 -->
  3. Layout: `src/protocol/`, `src/store/`, `src/modes/`, `src/tui/`
  4. Verify: `bun run check` green

### Gate 1→2

- [ ] Both repos push to private GitHub remotes
- [ ] Lint + typecheck + empty test suites green in both, with the normalizer
      `bun test` lane run SEPARATELY from the Node lane (both executed, not
      just Node - MUSE F15)
- [ ] Every `src/*` module has a module-level comment stating what it owns and
      why it exists (per Boundaries)

### Phase 2: Normalizer knowledge + interpretation

**Goal:** Descriptors and pure functions for all four harnesses; every
v1 scar in the PLAN.md 3.1 table has an owner and a test.

#### M2.1: Descriptor schema + claude-code descriptor + core interpretation

- **Dependencies:** M1.1
- **Effort:** M
- **Testing:** test-first
- **Tasks:**
  1. Seams under test: descriptor type + `buildLaunchArgv`, `buildResumeArgv`,
     `buildSessionArgv`, `decodeIdentity`, `parseResumeCommand`,
     `detectLimit`, `validateModel`, `validateEffort`, `capabilitiesOf(h, model, mode)`,
     plus the remaining PLAN.md 3.1 dimensions each with an interpretation
     function + test: `storePath` (transcript path for tail), `presence`/
     `isInteractive(sid)`, `contextHook` (-> `context` HarnessEvent), `stdin`
     (pi `< /dev/null`), `provider`, `autonomy`, `tools`, `discoveryFlags`.
     All 16 dimensions of the 3.1 table have an owner here (MUSE F1)
  2. RED/GREEN per function against the claude-code descriptor, including:
     argv ordering ({prompt} before --allowedTools), streaming granularity
     pinned to the stream-json flag set (A-001 evidence), sessionMode flags,
     identity authority (<!-- D-018 --> caller-assigned, stable across
     resumes - no rotation handling; `--fork-session` only for deliberate
     branching), limit matchers
  3. RED: hostile inputs - positional prompt starting with `-`, control
     characters in selectors, empty tool grants (spawn-boundary security
     oracles from PLAN.md 4.7)
  4. REFACTOR: one descriptor validation path, prototype-free records

#### M2.2: Override file loading

- **Dependencies:** M2.1
- **Effort:** S
- **Testing:** test-first
- **Tasks:**
  1. Seams: <!-- D-006 --> code defaults + validated override file; override
     wins; malformed file throws with path
  2. RED/GREEN: merge semantics, refusal messages name the file and harness

#### M2.3: codex, pi, muse descriptors

<!-- D-003 --> Descriptor-level groundwork only. This does NOT relax the
claude-first rule: the fully-proven vertical slice (execution M3.2, adapter
M5.3, end-to-end Gate 5→6) stays claude-only; codex/pi/muse get descriptors
+ scar tests here but are not exercised through the protocol until after the
claude slice is green. Parallelizable, cheap, no ordering risk.

- **Dependencies:** M2.1
- **Effort:** M
- **Testing:** test-first
- **Tasks:**
  1. Same seams per harness: codex thread-id discovery + `--last` race
     surface, pi provider/discovery flags + stdin rule + runtime-extensible
     capability query (<!-- D-008 --> runtime-verified over curated),
     muse positional resume
  2. RED: `resumeLast` corroboration ranking (two candidates - rank, never guess)

### Gate 2→3

- [ ] Interpretation layer 100% pure (no I/O imports) - enforced by test
- [ ] Every dimension in the PLAN.md 3.1 table has an interpretation function
      + a RED test (all 16, not a subset) (MUSE F1/F12)
- [ ] Override merge (M2.2) throws with the file path on malformed input
- [ ] All four descriptors round-trip their v1 scars as passing tests

### Phase 3: Normalizer execution layer

**Goal:** `streamTurn()` and `openSession()` run real turns against a
fake spawner deterministically, and against real claude in smoke.

#### M3.1: streamTurn (spawn-per-turn runner)

- **Dependencies:** M2.1, M2.2 (override loading proven before the runner
  builds argv - else smoke runs on code defaults and an override bug ships;
  MUSE F7)
- **Effort:** M
- **Testing:** test-first
- **Observability:** required (spawn/exit/stall structured events; argv logged with secret redaction; exit cause classified clean/limit/crash/stall)
- **Tasks:**
  1. Seams: `streamTurn(h, opts, { spawn, clock, signal, stallMs }) -> AsyncIterable<HarnessEvent>`;
     fake spawner + fake clock + fake signal injected (D-005: no direct
     `process.kill`; "kill mid-stream" goes through injected `signal`)
  2. RED/GREEN: drain both stdio streams, decode identity, emit typed events,
     stall watchdog only for `none`-granularity invocations, limit detection,
     `done` with exit cause. <!-- D-022 --> `system/init` re-emits every turn
     with the same id (A-001): treat as turn-start metadata, dedupe, emit an
     `identity` HarnessEvent only on first sight or id change - RED against
     `spikes/evidence/a001-raw.ndjson`
  3. RED: torn/interleaved output lines, harness that never announces identity,
     kill mid-stream
  4. REFACTOR: event decoding shared with M3.2

#### M3.2: openSession (persistent session runner)

- **Dependencies:** M3.1, A-001 pass
- **Effort:** M
- **Testing:** test-first
- **Observability:** required (session lifecycle events; per-turn correlation; send/interrupt dispositions)
- **Tasks:**
  1. Seams: `openSession(h, opts, deps) -> { turns, send, interrupt?, close }`;
     one fake process, many turns
  2. RED/GREEN: turn boundaries from stream-json events, `send` during idle
     (starts turn) and during turn (queued - per A-001 evidence), close
     drains cleanly
  3. RED: process dies mid-turn; consumer stops pulling (OS backpressure path)

#### M3.3: Real-claude smoke (compatibility, not proof)

- **Dependencies:** M3.1, M3.2
- **Effort:** S
- **Testing:** test-after (nondeterministic real harness; verify = scripted smoke run checked into the repo, run manually / on demand)
- **Tasks:**
  1. Implement smoke script: headless single-turn (token deltas observed),
     session multi-turn, limit/error propagation, kill + resume
  2. Verify: script green against installed claude; evidence recorded in run log

### Gate 3→4

- [ ] Fake-spawner suite deterministic (repeated runs identical)
- [ ] Runner-semantics REDs green: stall watchdog fires ONLY for
      `none`-granularity invocations (M3.1); `send` queues mid-turn per A-001
      (M3.2); `close` drains cleanly (MUSE F13)
- [ ] Real-claude smoke green
- [ ] No normalizer file imports chat/protocol types (enforced by test)

### Phase 4: Protocol reducer

**Goal:** The chat session protocol exists as a pure, fully-tested
reducer: frames, epoch fencing, leases, replay, liveness - the PLAN.md
4.7 invariants hold under any sequence.

#### M4.1: Frame schemas + validation

- **Dependencies:** M1.2
- **Effort:** S
- **Testing:** test-first
- **Observability:** required (a `refused` frame with a named `issue` is the
  only operator-visible auth/validation signal; the codec returns structured
  `{verdict, issue}` the host logs - MUSE F9)
- **Tasks:**
  1. Seams: frame codecs (attach, event, ack, disposition, heartbeat,
     detach / attach-ok, refused, event-ack, input, control, lease, credit)
  2. RED/GREEN: unknown kind refused; malformed refused with named `issue`;
     never half-applied

#### M4.2: Reducer core - attach, epoch, lease, seq

- **Dependencies:** M4.1
- **Effort:** L
- **Testing:** test-first
- **Observability:** required (every transition returns a structured event: verdict, epoch, seq/n, refusal issue - the host logs them verbatim)
- **Tasks:**
  1. Seams: `(state, frame, now) -> { state, effects, record } | refusal`;
     injected clock <!-- D-002 -->
  2. RED/GREEN: attach handshake (secret check <!-- D-004 -->, epoch grant,
     replayFrom), lease renew/expiry, takeover increments epoch, stale-epoch
     frames refused, lucid-minted seq on acceptance, per-epoch n gap/dupe
     detection
  3. RED: the two-simultaneous-attach oracle incl. stale-lease takeover;
     lease expiry MID-TURN aborts the in-flight turn
  4. RED: **channel-auth oracle** (MUSE F2) - `attach` with a wrong secret
     refused `auth-failed`; `event`/`input`/`control` carrying a stale or
     wrong epoch/secret refused, never applied; an impersonator sending
     `control {end|switch-path}` on a stolen/stale epoch cannot end or
     redirect the conversation <!-- D-004 --> <!-- D-021 -->
  5. REFACTOR: state as plain data, exhaustive switch on frame kind

#### M4.3: Input delivery, dispositions, replay, backpressure

- **Dependencies:** M4.2
- **Effort:** L
- **Testing:** test-first
- **Observability:** required (disposition + credit events; queue depth gauge)
- **Tasks:**
  1. Seams: input queue with idempotent ids; disposition transitions;
     replay from `resumeFrom`; **the credit path** - `host.grantCredit()`
     mints `credit {tokens}` for the droppable class only, bounded by one
     constant `DROPPABLE_QUEUE_MAX` (MUSE F4)
  2. RED/GREEN: accepted = durable applied|queued disposition; rejected
     returns to queue, never silently dropped; death-before-ack -> reconnect,
     replay, dedupe; credit starvation coalesces `token`/`progress`/`context`
     (latest-wins), lossless class NEVER dropped; queue bounded at
     `DROPPABLE_QUEUE_MAX`
  3. RED: heartbeat timeout vs slow-turn disambiguation; malformed mid-stream;
     cross-conversation isolation (no leakage)

#### M4.4: Liveness + state machine

- **Dependencies:** M4.2, M3.1 (fake `presence`/`isInteractive` from the
  normalizer - the state machine consumes presence, so the seam is wired
  here even though real polling lands in M5.1; MUSE F6)
- **Effort:** M
- **Testing:** test-first
- **Observability:** required (heartbeat/grace/lease/epoch events answer "why did it take over?" from the log alone)
- **Tasks:**
  1. Seams: the five conversation states (interactive-attached/-unattached,
     agent-gone, headless-session, headless-turn); HEARTBEAT_MS /
     ATTACH_GRACE_MS constants in one module
  2. RED/GREEN: heartbeat timeout decides, transport close is a hint;
     presence corroborates unattached vs gone, never proves a channel;
     headless takeover REFUSED while presence holds; handoff legal only at
     turn boundaries except lease-expiry takeover (aborts turn)
  3. NOTE <!-- D-020 -->: the mid-flight exactly-once handoff oracle does NOT
     live here - the reducer has no durable seq/replay buffer to prove
     ordered exactly-once. It moves to M5.4 (store + both modes + fake
     harness both sides). M4.4 proves only heartbeat/lease/epoch/state.

### Gate 4→5

Enumerated so "full oracle list" cannot pass with half deferred (MUSE F14).
The reducer-ownable oracles, all green:
- [ ] Exactly-one-writer under two simultaneous attaches + stale-lease takeover
      (epoch fencing; loser's frames refused by epoch, observably)
- [ ] Lease expiry mid-turn aborts the in-flight turn
- [ ] Channel-auth: wrong/stale secret+epoch refused on attach AND on
      event/input/control (impersonated `end`/`switch-path` rejected)
- [ ] No-lost / no-duplicated input via durable disposition + idempotent ids
- [ ] Credit starvation coalesces droppable, never lossless; queue bounded
- [ ] Heartbeat-timeout vs slow-turn disambiguation; cross-conversation isolation
- [ ] Reducer suite fully deterministic (injected clock; zero wall-clock reads)
- [ ] Refusals carry named issues; no refusal path half-applies
- NOTE: the mid-flight exactly-once handoff oracle is NOT claimed here - it is
  a Gate 5→6 item (needs the store); spawn-boundary security, `resumeLast`
  race, and identity collisions are M7.1 (this gate does not claim them).

### Phase 5: Store, modes, and the claude adapters

**Goal:** Real conversations flow end to end: durable store hosts the
reducer; all three integration modes map into frames; the claude ladder
rungs 1-3 work against live sessions.

#### M5.1: Durable conversation store (the host)

- **Dependencies:** M4.2
- **Effort:** M
- **Testing:** test-first
- **Observability:** required (one structured line per accepted/refused frame at the host boundary; fold-based inspection command)
- **Tasks:**
  1. Seams: append-only conversation log (seq authority), crash-safe append,
     fold to state; secret minted 0600 at record creation <!-- D-004 -->;
     `host.grantCredit()` (from M4.3); **presence polling** - the host calls
     the normalizer's `isInteractive(sid)` on a cadence to feed the state
     machine (MUSE F6)
  2. RED/GREEN: torn trailing line tolerated; fold idempotent; secret file
     permissions; refusal on missing/wrong secret; presence alive +
     heartbeat timeout => `interactive-unattached`, NOT `agent-gone`
  3. RED: concurrent unrelated conversations; kill one source, others undisturbed;
     **headless-vs-headless concurrent resume** - two contenders both see
     `presence=false` and attempt `openSession(--resume)`; exactly one wins,
     the other refused `stale-epoch` (D-021: presence gate is necessary, not
     sufficient; epoch fencing is the actual guard - A-005)

#### M5.2: Headless modes mapped in

- **Dependencies:** M5.1, M3.1, M3.2
- **Effort:** M
- **Testing:** test-first
- **Observability:** required (turnId correlation runner-events -> frames -> dispositions)
- **Tasks:**
  1. Seams: HarnessEvent -> event frames; input -> send (session) or
     next-turn prompt (turn mode); droppable/lossless mapping
  2. RED/GREEN with fake spawner: headless-session queue/steer dispositions;
     headless-turn queues between turns; limit/error terminate turn with
     durable record

#### M5.3: claude interactive ladder - rungs 1-3

- **Dependencies:** M5.1; **entry criterion** <!-- D-023 -->: A-002 evidence
  present (done - spikes/evidence/A-002.md); A-003 evidence required before
  the rung-2/3 tasks (currently deferred - those tasks are BLOCKED until the
  A-003 retry lands, per its self-gating criterion). Rung 1 is unblocked.
- **Effort:** L
- **Testing:** SPLIT <!-- D-023 --> - (a) adapter *logic* (tail parsing, 10k
  chunking, disposition state) test-first on the spike fixtures in
  spikes/evidence/; (b) the *injection contract* test-after with a mandatory
  live-pty smoke asserting disposition (`applied|queued|rejected`) and
  terminal rendering (fixtures cannot prove injection - MUSE F10)
- **Observability:** required (attach/detach/heartbeat, injection dispositions per rung, tail lag gauge)
- **Prototyping:** none (the spike is the prototype; fixtures come from it)
- **Tasks:**
  1. Seams: hooks adapter (SessionStart announce -> attach; requires
     `--setting-sources project` AND `HERDR_ENV` unset for the child
     <!-- D-025 -->; PostToolUse/Stop -> boundary
     injection with disposition; transcript tail -> message events);
     cooperative rung (wait-poll delivery); observe-only rung (tail + queue
     with resume instruction) <!-- D-017 -->; **at attach, query
     `capabilitiesOf(h, model, mode)`** against the active harness/registry
     (runtime-verified; degrade to curated/unknown) <!-- D-008 --> (MUSE F3)
  2. RED/GREEN (logic, fixtures): rung degradation order; input chunking under
     the 10k cap (A-004); tail resumes after adapter restart without dupes
     (per-epoch n); capabilities source = runtime-verified vs curated fallback
  3. RED: forbidden path - a headless resume attempted while presence holds is
     refused (D-018: the harness would otherwise append with no guard)
  4. Verify (injection, live smoke): scripted live-session run per rung
     asserting disposition + terminal rendering

#### M5.4: States + handoff wired end to end

- **Dependencies:** M5.2, M5.3
- **Effort:** M
- **Testing:** test-first (fake harness both sides)
- **Observability:** required (state transition events with cause)
- **Tasks:**
  1. Seams: the state machine driving mode selection per conversation
  2. RED/GREEN: attached -> unattached (heartbeat), unattached -> gone
     (presence), gone -> headless takeover; interactive reattach epoch++;
     boundary-only handoff enforced

### Gate 5→6

- [ ] End-to-end fake-harness conversation across all three modes, with a
      mid-conversation handoff, exactly-once
- [ ] Live claude: rung-1 session streams into a conversation and a message
      injects at a tool boundary (A-002 proven; wire it end to end)
- [ ] rungs 2-3 verified on a bare session - GATED on the A-003 retry landing
      (deferred); if A-003 stays deferred at this gate, rungs 2-3 ship behind
      escape hatch 3 and this checkbox is explicitly waived with that note

### Phase 6: TUI + the milestone-1 skill

**Goal:** A human can drive a real conversation from the terminal, and
an agent can learn the contract from the skill alone.

#### M6.1: Minimal TUI

- **Dependencies:** M5.4
- **Effort:** M
- **Testing:** test-after (terminal rendering - visual/scripted verification; the substrate under it is already invariant-tested)
- **Observability:** required (TUI reads the same structured events as the tests)
- **Tasks:**
  1. Implement: conversation view over the folded log, input box, state +
     rung indicator, per-item disposition marks <!-- D-009 -->
  2. Verify: scripted pty run + manual pass against live claude

#### M6.2: The milestone-1 skill

- **Dependencies:** M5.4
- **Effort:** S
- **Testing:** test-after (documentation; verify = a fresh agent session drives a full conversation using only the skill)
- **Tasks:**
  1. Write the skill: frames, epoch/single-writer rule, capability
     declaration with source, ladder truthfully stated, disposition
     discipline, yield rules
  2. Verify: cold-start agent run recorded as evidence

### Gate 6→7

- [ ] A human (TUI) and an agent (skill) each complete a full review-shaped
      conversation against live claude

### Phase 7: Full test surface + landing

**Goal:** PLAN.md 4.7 in its entirety is green and everything is merged.

#### M7.1: Oracle completion sweep

- **Dependencies:** Phase 5
- **Effort:** M
- **Testing:** test-first (any oracle not yet covered gets written here; expected: mostly audit)
- **Tasks:**
  1. Audit the 4.7 list against the suite; write the gaps
  2. RED where missing: spawn-boundary security set, resumeLast race,
     credit-starvation classes, identity collisions

#### M7.2: Real-harness compatibility smoke (the original seven)

- **Dependencies:** M7.1, Phase 6
- **Effort:** M
- **Testing:** test-after (nondeterministic; scripted, run on demand, evidence logged)
- **Tasks:**
  1. Script the seven against claude (full) and pi/codex/muse (headless
     scope per their descriptors)
  2. Verify: green run recorded; failures triaged to findings, not ignored

#### M7.3: Landing wrap

- **Dependencies:** all
- **Effort:** S
- **Testing:** test-after (process work; verify = branches merged, tags cut)
- **Tasks:**
  1. <!-- D-014 --> Each phase's PR was already merged to main immediately
     after that phase's gate passed (per-phase cadence, cross-family review
     per PR) - NOT batched here. M7.3 only confirms all phase PRs are merged
     and cuts the tag; it does not hold a backlog of PRs (MUSE F21).
  2. Tag normalizer 0.1.0 (still private; npm publish is a future decision)

### Gate 7→complete

- [ ] Invariants + oracles + smoke all green
- [ ] All phase PRs merged; `complete` = merged

---

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| claude ships a version changing hook/stream-json behavior mid-build | high | medium | pin the verified version in descriptors; smoke scripts detect drift early (normalizer CI-on-drift is deferred but scripts exist from M3.3) | agent |
| Hooks adapter rung 1 unusable | high | **low** | A-002 core PASSED (announce + mid-turn boundary inject + continuity, evidence/A-002.md); residual risk is Stop-path only, which the ladder absorbs (boundary inject is the primary mode) | human+agent |
| A-003 rungs 2-3 (bare tail / cooperative) stay unproven | medium | medium | deferred not failed; M5.3 rung-2/3 tasks self-gate on the A-003 retry; rung 1 (proven) covers lucid-aware sessions meanwhile | agent |
| ~~openSession semantics differ from docs~~ | ~~medium~~ | **resolved** | A-001 PASSED (evidence/A-001.md: 3 turns/one process, mid-turn send queued, `result` delimits turns). Row retired; escape hatch 1 no longer armed | agent |
| Real-harness smoke flaky under rate limits | medium | high | smoke is test-after and on-demand; never in the deterministic suite; limit events are themselves assertions | agent |
| Node/Bun divergence in normalizer stream handling | medium | low | injected primitives + dual test lanes from M1.1 | agent |
| Two-writer accident during live-session testing | high | high | <!-- D-018 --> the harness appends concurrent resumes into live sessions with no guard (A-005 measured), so the forbidden-path test (M5.3) and the presence gate are load-bearing; NO dev script resumes an id outside the gate | agent |

---

## Escape Hatches

1. ~~**If A-001 fails**~~ **RETIRED - A-001 passed** (evidence/A-001.md); the
   trigger can no longer fire and cutting headless-session would contradict
   D-003. Original text kept for history: *If A-001 fails* (no viable persistent session): headless-session
   mode is cut from milestone 1; `openSession` ships pi-only or not at
   all; `capabilities.session=false` for claude. Protocol unchanged
   (mode 2 is additive by design).
2. **If A-002 fails wholly:** claude interactive = rungs 2-3 only;
   the profile table and PLAN.md narrowing are updated; milestone-0
   ratification note amended via iterate mode.
3. **If A-003 tail proves unreliable mid-turn:** observe granularity
   drops to turn-end folding; `observe: message` claim narrows; chat
   renders progress-only during turns.
4. **If the mid-flight handoff oracle cannot pass** (Gate 5→6): this is NOT a
   silent narrowing. <!-- D-019 --> Per the oracle-failure policy, narrowing
   handoff to fully-quiesced boundaries only is a SPEC AMENDMENT via iterate
   mode (a new RFC-level decision amending PLAN.md 4.5), which then rewrites
   the oracle to match the amended rule. The oracle is never rewritten to
   hide a failure of the shipped spec.
5. **If Bun/Node duality (D-005) blocks the execution layer:** there is no
   silent Node-first fallback - <!-- D-005 --> requires both and Gate 1→2
   requires both lanes green. So this blocks all of Phase 3 and forces an
   explicit decision: amend D-005 via iterate mode (accept Node-first, defer
   Bun with a recorded finding) BEFORE proceeding. The gate does not waive
   itself (MUSE F17).

---

## Landing Strategy

<!-- D-014 -->

| Field | Value |
|-------|-------|
| Merge target | `main` in each repo |
| Branch model | branch per phase (`phase-1-scaffold`, ...) in whichever repo(s) the phase touches |
| PR cadence | PR per phase |
| Independent reviewer | cross-family per model rubric: codex review; muse-spark fallback when codex is over limit |
| Ship mechanism | manual PR merge via gh; repos private under dungle-scrubs; npm publish out of scope |

---

## Progress Report Accounting

Per the planner invariants: buckets (current blockers / deferred /
superseded / done), current-focus marker matches the first unchecked
current-cutoff box, `plan-db check-progress` before any resume.

---

## Validation Commands

```bash
# normalizer (~/dev/harness-cli-normalizer)
pnpm check          # biome + tsc + vitest (Node lane)
bun test            # Bun lane
bun run smoke:claude  # M3.3 real-harness smoke (on demand)

# lucid-v2 (~/dev/lucid-v2)
bun run check       # biome + tsc + bun test
bun run smoke:seven # M7.2 compatibility smoke (on demand)
```

(Names fixed at M1.1/M1.2 scaffold time; commands above are the contract.)

---

## Decisions

Canonical decisions live in `.plans/00-chat-substrate/plan.db`:

```bash
npx tsx <planner-skill>/scripts/plan-db.ts query-decisions --plan "00-chat-substrate"
```

Referenced here via `<!-- D-NNN -->` markers. Broadly: D-001..D-010 are the
ratified PLAN.md decisions; D-011 onward are the planning-pipeline additions
(create interview, the spike-derived resume-identity/identity-event/hook-
isolation findings, and the pre-CONVERGE muse + drift review outcomes). The
**canonical, complete and current** ledger is `plan.db` - this list is a
summary and never the source of truth, so it does not re-enumerate every
code (that is what kept going stale as decisions were added).

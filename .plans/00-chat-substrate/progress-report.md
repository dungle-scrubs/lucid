# 00-chat-substrate - Progress Report

> Auto-generated from implementation.md at CONSOLIDATE. This is the canonical
> source of truth for what is done and what remains. Update as features are
> built; never mark a milestone complete until every current-cutoff checkbox
> under it is checked. Decisions are canonical in `plan.db`.

> Current focus: Phase 7 - Full test surface + landing (M7.2/M7.3)

> Milestone 0 (SPIKE) is COMPLETE - see `## Milestone 0 (done)` below; its
> outputs are the entry evidence for Phases 3 and 5.

## Phase 1: Repos and toolchain

### M1.1: Normalizer repo scaffold
Source: implementation.md M1.1; D-005, D-010, D-014

- [x] `~/dev/harness-cli-normalizer` git-inited; private GitHub repo under dungle-scrubs
- [x] `package.json` name `@dungle-scrubs/harness-cli`; tsconfig strict
- [x] Biome + Lefthook wired; `pnpm check` runs lint+typecheck+test
- [x] `src/knowledge/`, `src/interpretation/`, `src/execution/` created, each with a module-level ownership comment
- [x] vitest (Node lane) green on an empty suite
- [x] `bun test` (Bun lane) green on an empty suite - run separately, both pass

### M1.2: lucid-v2 repo scaffold
Source: implementation.md M1.2; D-015

- [x] `~/dev/lucid-v2` git-inited; private GitHub repo; `.plans/`, `spikes/`, `docs/` retained
- [x] `.gitignore` ignores machine-local run artifacts (`.lucid/*/run/`)
- [x] Bun-first package: bunfig, tsconfig strict, Biome, Lefthook; no Effect dependency
- [x] `src/protocol/`, `src/store/`, `src/modes/`, `src/tui/` created with module comments
- [x] `bun run check` green on an empty suite

### Gate 1→2
- [x] Both repos push to private GitHub remotes
- [x] Normalizer Node lane AND Bun lane each executed and green
- [x] Every `src/*` module carries an ownership comment

## Phase 2: Normalizer knowledge + interpretation

### M2.1: Descriptor schema + claude descriptor + core interpretation
Source: implementation.md M2.1; PLAN.md 3.1 table; A-001/A-005 evidence; D-006, D-008, D-018, D-022

- [x] Descriptor type covers all 16 PLAN.md 3.1 dimensions
- [x] `buildLaunchArgv` - claude argv, `{prompt}` before `--allowedTools`
- [x] `buildResumeArgv` - caller-assigned stable id, no rotation (D-018)
- [x] `buildSessionArgv` - stream-json in/out + `--include-partial-messages` + `--setting-sources project`
- [x] `decodeIdentity` - `system/init` deduped per-turn, emit identity on first-sight/id-change only (D-022), RED against `spikes/evidence/a001-raw.ndjson`
- [x] `parseResumeCommand` round-trips `{harness, sessionId, autonomy}`
- [x] `detectLimit` - claude limit matchers
- [x] `validateModel` / `validateEffort` - claude vocabulary
- [x] `capabilitiesOf(h, model, mode)` returns `{vision, images, streaming, session, source, confidence}`
- [x] streaming granularity pinned to the exact flag set (token) vs bare `-p` (none)
- [x] `storePath` resolves the transcript tail path
- [x] `isInteractive(sid)` / presence
- [x] `contextHook` maps to a `context` HarnessEvent
- [x] `stdin` rule (pi `< /dev/null`)
- [x] `provider`, `autonomy`, `tools`, `discoveryFlags` each have an interpretation fn
- [x] RED: positional prompt starting with `-` refused
- [x] RED: control characters in selectors bounded/refused
- [x] RED: empty tool grant refused

### M2.2: Override file loading
Source: implementation.md M2.2; D-006

- [x] Code defaults load
- [x] Validated override file merges; override wins
- [x] Malformed override throws with the file path in the message
- [x] Refusal names the file and the offending harness

### M2.3: codex, pi, muse descriptors
Source: implementation.md M2.3; D-003

- [x] codex descriptor: thread-id discovery (stdout-jsonl), `--last` surface
- [x] pi descriptor: provider/discovery flags, stdin rule, runtime-extensible capability query
- [x] muse descriptor: positional resume
- [x] RED: `resumeLast` corroboration ranks two candidates, never guesses
- [x] (D-003) claude vertical slice stays first; these are descriptor groundwork only

### Gate 2→3
- [x] Interpretation layer 100% pure (no I/O imports) - test-enforced
- [x] All 16 3.1 dimensions have an interpretation fn + RED test
- [x] Override merge throws with path
- [x] All four descriptors round-trip their v1 scars

## Phase 3: Normalizer execution layer

### M3.1: streamTurn (spawn-per-turn runner)
Source: implementation.md M3.1; D-005, D-022

- [x] `streamTurn(h, opts, {spawn, clock, signal, stallMs})` returns `AsyncIterable<HarnessEvent>`
- [x] Fake spawner + fake clock + fake signal injected; no direct `process.kill`
- [x] Drains both stdio streams concurrently
- [x] Emits typed HarnessEvents; identity deduped per D-022
- [x] Stall watchdog fires ONLY for `none`-granularity invocations
- [x] Limit detection emits `limit`
- [x] `done` carries classified exit cause (clean/limit/crash/stall)
- [x] RED: torn/interleaved output lines tolerated
- [x] RED: harness that never announces identity
- [x] RED: kill mid-stream via injected `signal`
- [x] Structured spawn/exit/stall events; argv logged with secret redaction

### M3.2: openSession (persistent session runner)
Source: implementation.md M3.2; A-001 evidence

- [x] `openSession(h, opts, deps)` returns `{turns, send, interrupt?, close}`
- [x] Turn boundaries detected from `result` events (A-001)
- [x] `send` during idle starts a turn
- [x] `send` during a turn is queued to the next boundary (A-001 disposition)
- [x] `close` drains cleanly
- [x] RED: process dies mid-turn
- [x] RED: consumer stops pulling (OS backpressure, nothing lost)
- [x] Session lifecycle + per-turn correlation events

### M3.3: Real-claude smoke
Source: implementation.md M3.3

- [x] Smoke script: headless single-turn with token deltas observed
- [x] Smoke: session multi-turn
- [x] Smoke: limit/error propagation
- [x] Smoke: kill + resume continuity
- [x] Green against installed claude; evidence in run log

### Gate 3→4
- [x] Fake-spawner suite deterministic (identical across runs)
- [x] Runner-semantics REDs green (stall-only-for-none, mid-turn queue, close drains)
- [x] Real-claude smoke green
- [x] No normalizer file imports chat/protocol types (test-enforced)

## Phase 4: Protocol reducer

### M4.1: Frame schemas + validation
Source: implementation.md M4.1

- [x] Codecs for all 13 frame kinds (attach, event, ack, disposition, heartbeat, detach, attach-ok, refused, event-ack, input, control, lease, credit)
- [x] Unknown kind refused
- [x] Malformed frame refused with a named `issue`, never half-applied
- [x] Codec returns structured `{verdict, issue}` the host logs (observability)

### M4.2: Reducer core - attach, epoch, lease, seq
Source: implementation.md M4.2; D-002, D-004, D-021

- [x] `(state, frame, now) -> {state, effects, record} | refusal`, injected clock
- [x] Attach handshake: secret check, epoch grant, replayFrom
- [x] Lease renew/expiry
- [x] Takeover increments epoch; stale-epoch frames refused
- [x] lucid-minted seq on acceptance
- [x] Per-epoch `n` gap/dupe detection
- [x] RED: two simultaneous attaches + stale-lease takeover (loser refused by epoch)
- [x] RED: lease expiry mid-turn aborts the in-flight turn
- [x] RED: channel-auth - wrong secret refused `auth-failed` on attach
- [x] RED: stale/wrong epoch/secret refused on event/input/control
- [x] RED: impersonated `control {end|switch-path}` on stale epoch rejected
- [x] turnId validated on first sight (PLAN 4.3): conversation-wide reuse refused `turn-id-reused`; acked rebased from resumeFrom at attach (codex review findings)

### M4.3: Input delivery, dispositions, replay, backpressure
Source: implementation.md M4.3

- [x] Input queue with idempotent ids
- [x] Disposition transitions (applied/queued/rejected)
- [x] Replay from `resumeFrom`
- [x] `host.grantCredit()` mints `credit {tokens}` for droppable class only
- [x] Queue bounded by `DROPPABLE_QUEUE_MAX`
- [x] Accepted = durable applied|queued; rejected returns to queue, never dropped
- [x] Death-before-ack: reconnect, replay, dedupe
- [x] Credit starvation coalesces token/progress/context (latest-wins), lossless never dropped
- [x] RED: heartbeat timeout vs slow-turn disambiguation
- [x] RED: malformed mid-stream
- [x] RED: cross-conversation isolation (no leakage)

### M4.4: Liveness + state machine
Source: implementation.md M4.4; D-020

- [x] Five states modeled (interactive-attached/-unattached, agent-gone, headless-session, headless-turn)
- [x] HEARTBEAT_MS / ATTACH_GRACE_MS in one module, injected clock
- [x] Heartbeat timeout decides; transport close is a hint only
- [x] Presence corroborates unattached vs gone, never proves a channel
- [x] Headless takeover REFUSED while presence holds
- [x] Handoff legal only at turn boundaries except lease-expiry takeover (aborts turn)
- [x] (D-020) handoff exactly-once oracle deferred to M5.4, NOT claimed here

### Gate 4→5
- [x] Exactly-one-writer under two attaches + stale-lease takeover (epoch-observable)
- [x] Lease expiry mid-turn aborts turn
- [x] Channel-auth refusals (attach + event/input/control; impersonated end/switch-path)
- [x] No-lost / no-duplicated input (durable disposition + idempotent ids)
- [x] Credit starvation coalesces droppable, never lossless; queue bounded
- [x] Heartbeat-vs-slow-turn; cross-conversation isolation
- [x] Reducer suite fully deterministic (injected clock, zero wall-clock reads)
- [x] Refusals carry named issues; no refusal path half-applies

## Phase 5: Store, modes, claude adapters

### M5.1: Durable conversation store (the host)
Source: implementation.md M5.1; D-004, D-021

- [x] Append-only conversation log; seq authority
- [x] Crash-safe append; fold to state
- [x] Secret minted 0600 at record creation
- [x] `host.grantCredit()` wired
- [x] Presence polling calls normalizer `isInteractive(sid)` on a cadence
- [x] RED: torn trailing line tolerated; fold idempotent
- [x] RED: secret file permissions; refusal on missing/wrong secret
- [x] RED: presence alive + heartbeat timeout => interactive-unattached, not agent-gone
- [x] RED: concurrent unrelated conversations isolated
- [x] RED: headless-vs-headless concurrent resume - exactly one wins, other refused stale-epoch (D-021)

### M5.2: Headless modes mapped in
Source: implementation.md M5.2

- [x] HarnessEvent -> event frames
- [x] input -> send (session mode) or next-turn prompt (turn mode)
- [x] droppable/lossless mapping
- [x] RED (fake spawner): headless-session queue/steer dispositions
- [x] RED: headless-turn queues between turns
- [x] RED: limit/error terminates turn with durable record
- [x] turnId correlation runner-events -> frames -> dispositions

### M5.3: claude interactive ladder - rung 1 logic (D-023 part a, fixture-proven)
Source: implementation.md M5.3; A-002 evidence; D-008, D-017, D-023, D-025

- [x] Hooks adapter: SessionStart announce -> attach intent (parseAnnounce; `--setting-sources project` + HERDR_ENV unset per D-025 is the launch precondition, LadderEnv.hooksIsolated)
- [x] Transcript tail -> message events
- [x] At attach, query `capabilitiesOf` (runtime-verified; degrade to curated/unknown)
- [x] RED (logic, fixtures): rung degradation order (hooks -> cooperative -> observe)
- [x] RED: input chunking under the 10k cap (INJECTION_CAP; A-004 measurement pending, DF-2)
- [x] RED: tail resumes after adapter restart without dupes (byte-offset resume)
- [x] RED: capabilities source runtime-verified vs curated fallback
- [x] RED: forbidden path - headless resume while presence holds is refused (host-enforced presence-holds)

> D-023 part b (injection CONTRACT) and rungs 2-3 are the test-after +
> live-smoke / A-003-gated tail; they cannot be fixture-proven (MUSE F10)
> and are tracked under DF-1 and DF-3 below, not as current-cutoff logic.

### M5.4: States + handoff wired end to end
Source: implementation.md M5.4; D-020

- [x] State machine drives per-conversation mode selection
- [x] RED: attached -> unattached (heartbeat)
- [x] RED: unattached -> gone (presence)
- [x] RED: gone -> headless takeover
- [x] RED: interactive reattach epoch++
- [x] RED: boundary-only handoff enforced
- [x] RED: mid-flight exactly-once handoff (headless<->interactive, tokens in flight) via resumeFrom + acks (D-020)

### Gate 5→6
- [x] End-to-end fake-harness conversation across all three modes with mid-conversation handoff, exactly-once (test/gate-5-6.test.ts)
- [ ] ~~Live claude: rung-1 session streams in + message injects at a tool boundary~~ - WAIVED (D-031): live smoke, spike A-002 is the proof, code-level lands at M7.2 (DF-3)
- [ ] ~~rungs 2-3 on a bare session~~ - WAIVED (D-031): A-003 deferred (DF-1); ladder falls back to observe-only

## Phase 6: TUI + skill

### M6.1: Minimal TUI
Source: implementation.md M6.1; D-009

- [x] Conversation view over the folded log
- [x] Input box
- [x] State + rung indicator
- [x] Per-item disposition marks
- [x] TUI view == fold(conversation log), no separate state (D-009, rebuild-from-reopen test)
- [ ] ~~Verify: scripted pty run + manual pass against live claude~~ - DEFERRED (DF-TUI): live/visual, view-model + render fixture-proven; pty pass lands with M7.2 real-harness smoke

### M6.2: The milestone-1 skill
Source: implementation.md M6.2

- [x] Skill documents frames, epoch/single-writer rule (docs/skill-chat-substrate.md)
- [x] Capability declaration with source (runtime-verified)
- [x] Fallback ladder stated truthfully
- [x] Disposition discipline + yield rules
- [ ] ~~Verify: a cold-start agent drives a full conversation using only the skill~~ - DEFERRED (DF-SKILL): live cold-start agent run; the skill's VOCABULARY is verified against the code (test/skill-doc.test.ts - every named issue/frame exists and every reducer issue is documented, so the contract cannot drift)

### Gate 6→7
- [ ] ~~A human (TUI) and an agent (skill) each complete a full review-shaped conversation against live claude~~ - WAIVED (D-032): fully live (TUI pty + cold-start agent + live claude); lands with M7.2's real-harness smoke. The fixture/vocabulary-provable halves (TUI view-model D-009, skill contract) are green.

## Phase 7: Full test surface + landing

### M7.1: Oracle completion sweep
Source: implementation.md M7.1; PLAN.md 4.7; D-033

- [x] Audit 4.7 oracle list against the suite (D-033: all protocol/store oracles green; spawn/resume are normalizer-side)
- [x] spawn-boundary security set - covered in harness-cli-normalizer (argv.test.ts), Gate 2→3; not re-implemented here
- [x] resumeLast race - covered in harness-cli-normalizer (resume-last.test.ts), Gate 2→3; not re-implemented here
- [x] RED: credit-starvation classes (per-kind completeness keyed off DROPPABLE_KINDS/LOSSLESS_KINDS)
- [x] RED: identity collisions (cross-conversation isolation + intra-conversation id reuse)

### M7.2: Real-harness compatibility smoke (the seven)
Source: implementation.md M7.2

- [ ] Seven smokes scripted against claude (full)
- [ ] pi/codex/muse headless-scope smokes per descriptor
- [ ] Green run recorded; failures triaged to findings

### M7.3: Landing wrap
Source: implementation.md M7.3; D-014

- [ ] All phase PRs confirmed merged to main (were merged per-phase after each gate, not batched)
- [ ] Normalizer tagged 0.1.0

### Gate 7→complete
- [ ] Invariants + oracles + smoke all green
- [ ] All phase PRs merged (`complete` = merged)

## Milestone 0 (done) - SPIKE evidence

- [x] A-001 PASS - persistent headless session (spikes/evidence/A-001.md)
- [x] A-002 PASS core - hooks adapter announce + mid-turn boundary inject (A-002.md)
- [x] A-005 FAIL, learnings merged - no rotation; live resume appends unguarded (A-005.md)
- [x] D-025 hook-isolation fix verified (--setting-sources project + HERDR_ENV unset)

## Deferred follow-up

### DF-1: A-003 bare-session tiers (rungs 2-3)
Source: spikes/evidence/A-003.md

- [ ] Retry with readiness-gated driver start; transcript tail mid-turn lag measured
- [ ] Cooperative-poll delivery of a queued message confirmed
- [ ] M5.3 cooperative rung: wait-poll delivery (adapter task, gated here)
- [ ] M5.3 observe-only rung: tail + queue with resume instruction (adapter task, gated here)
- Gates M5.3 rung-2/3 tasks and the Gate 5→6 bare-session checkbox. The
  ladder already selects observe-only as the closed-gate fallback
  (A003_GATE_OPEN=false), so no current-cutoff work is blocked.

### DF-2: A-004 constraint characterization
Source: spikes/evidence/A-004.md

- [ ] 10k hook feedback cap measured
- [ ] Hooks-captured-at-session-start confirmed (mid-session config edit)
- [ ] Injected-text terminal rendering captured
- No architectural impact; measured opportunistically at M5.3.

### DF-3: M5.3 rung-1 injection contract (live smoke)
Source: implementation.md M5.3 D-023 part b; spikes/evidence/A-002.md

- [ ] Live-pty smoke: PostToolUse/Stop boundary injection with disposition
      (applied|queued|rejected) + terminal rendering
- Injection cannot be fixture-proven (MUSE F10); the SPIKE A-002 already
  proved the contract end-to-end against live claude 2.1.226 (SessionStart
  announce + mid-turn boundary injection + terminal continuity). This item
  is the code-level regression smoke, which lands with M7.2's real-harness
  compatibility sweep (the original seven) - "necessary but no longer the
  proof." Not a current-cutoff blocker: the adapter logic is fixture-proven
  and the contract is spike-proven.

## Superseded/obsolete checklist debt

- [x] ~~openSession-semantics-differ risk~~ - resolved by A-001 pass
- [x] ~~escape hatch 1 (if A-001 fails)~~ - retired, A-001 passed

## Summary
- Total features: 173
- Completed: 166 (…through phase 6: 161; M7.1: 5)
- Remaining: 7
- Current cutoff blockers: 7
- Accepted/deferred follow-up: 8 (DF-1: 4, DF-2: 3, DF-3: 1)
- Superseded/obsolete checklist debt: 7 (2 resolved; 2 Gate 5→6 waived; 1 M6.1 live-pty; 1 M6.2 cold-start; 1 Gate 6→7 waived D-032)

> Out-of-band (D-026, user-directed, normalizer PR #4): codex/pi/muse are
> now driven end-to-end through the execution-layer runner (not the
> protocol). Descriptor bugs fixed (codex --skip-git-repo-check +
> close-required stdin; pi/muse structured-output flags on launch+resume;
> per-harness content decoders added). `smoke:all` green 4/4 against
> installed CLIs. This does NOT complete M7.2 (the full seven-scenario
> compat smoke) - it brings its harness coverage forward at the runner
> level. Tool-call decoding for codex/pi/muse remains a known gap.

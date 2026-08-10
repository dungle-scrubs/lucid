# 00-chat-substrate - Progress Report

> Auto-generated from implementation.md at CONSOLIDATE. This is the canonical
> source of truth for what is done and what remains. Update as features are
> built; never mark a milestone complete until every current-cutoff checkbox
> under it is checked. Decisions are canonical in `plan.db`.

> Current focus: Phase 2 - Normalizer knowledge + interpretation (M2.1)

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
- [ ] Interpretation layer 100% pure (no I/O imports) - test-enforced
- [ ] All 16 3.1 dimensions have an interpretation fn + RED test
- [ ] Override merge throws with path
- [ ] All four descriptors round-trip their v1 scars

## Phase 3: Normalizer execution layer

### M3.1: streamTurn (spawn-per-turn runner)
Source: implementation.md M3.1; D-005, D-022

- [ ] `streamTurn(h, opts, {spawn, clock, signal, stallMs})` returns `AsyncIterable<HarnessEvent>`
- [ ] Fake spawner + fake clock + fake signal injected; no direct `process.kill`
- [ ] Drains both stdio streams concurrently
- [ ] Emits typed HarnessEvents; identity deduped per D-022
- [ ] Stall watchdog fires ONLY for `none`-granularity invocations
- [ ] Limit detection emits `limit`
- [ ] `done` carries classified exit cause (clean/limit/crash/stall)
- [ ] RED: torn/interleaved output lines tolerated
- [ ] RED: harness that never announces identity
- [ ] RED: kill mid-stream via injected `signal`
- [ ] Structured spawn/exit/stall events; argv logged with secret redaction

### M3.2: openSession (persistent session runner)
Source: implementation.md M3.2; A-001 evidence

- [ ] `openSession(h, opts, deps)` returns `{turns, send, interrupt?, close}`
- [ ] Turn boundaries detected from `result` events (A-001)
- [ ] `send` during idle starts a turn
- [ ] `send` during a turn is queued to the next boundary (A-001 disposition)
- [ ] `close` drains cleanly
- [ ] RED: process dies mid-turn
- [ ] RED: consumer stops pulling (OS backpressure, nothing lost)
- [ ] Session lifecycle + per-turn correlation events

### M3.3: Real-claude smoke
Source: implementation.md M3.3

- [ ] Smoke script: headless single-turn with token deltas observed
- [ ] Smoke: session multi-turn
- [ ] Smoke: limit/error propagation
- [ ] Smoke: kill + resume continuity
- [ ] Green against installed claude; evidence in run log

### Gate 3→4
- [ ] Fake-spawner suite deterministic (identical across runs)
- [ ] Runner-semantics REDs green (stall-only-for-none, mid-turn queue, close drains)
- [ ] Real-claude smoke green
- [ ] No normalizer file imports chat/protocol types (test-enforced)

## Phase 4: Protocol reducer

### M4.1: Frame schemas + validation
Source: implementation.md M4.1

- [ ] Codecs for all 13 frame kinds (attach, event, ack, disposition, heartbeat, detach, attach-ok, refused, event-ack, input, control, lease, credit)
- [ ] Unknown kind refused
- [ ] Malformed frame refused with a named `issue`, never half-applied
- [ ] Codec returns structured `{verdict, issue}` the host logs (observability)

### M4.2: Reducer core - attach, epoch, lease, seq
Source: implementation.md M4.2; D-002, D-004, D-021

- [ ] `(state, frame, now) -> {state, effects, record} | refusal`, injected clock
- [ ] Attach handshake: secret check, epoch grant, replayFrom
- [ ] Lease renew/expiry
- [ ] Takeover increments epoch; stale-epoch frames refused
- [ ] lucid-minted seq on acceptance
- [ ] Per-epoch `n` gap/dupe detection
- [ ] RED: two simultaneous attaches + stale-lease takeover (loser refused by epoch)
- [ ] RED: lease expiry mid-turn aborts the in-flight turn
- [ ] RED: channel-auth - wrong secret refused `auth-failed` on attach
- [ ] RED: stale/wrong epoch/secret refused on event/input/control
- [ ] RED: impersonated `control {end|switch-path}` on stale epoch rejected

### M4.3: Input delivery, dispositions, replay, backpressure
Source: implementation.md M4.3

- [ ] Input queue with idempotent ids
- [ ] Disposition transitions (applied/queued/rejected)
- [ ] Replay from `resumeFrom`
- [ ] `host.grantCredit()` mints `credit {tokens}` for droppable class only
- [ ] Queue bounded by `DROPPABLE_QUEUE_MAX`
- [ ] Accepted = durable applied|queued; rejected returns to queue, never dropped
- [ ] Death-before-ack: reconnect, replay, dedupe
- [ ] Credit starvation coalesces token/progress/context (latest-wins), lossless never dropped
- [ ] RED: heartbeat timeout vs slow-turn disambiguation
- [ ] RED: malformed mid-stream
- [ ] RED: cross-conversation isolation (no leakage)

### M4.4: Liveness + state machine
Source: implementation.md M4.4; D-020

- [ ] Five states modeled (interactive-attached/-unattached, agent-gone, headless-session, headless-turn)
- [ ] HEARTBEAT_MS / ATTACH_GRACE_MS in one module, injected clock
- [ ] Heartbeat timeout decides; transport close is a hint only
- [ ] Presence corroborates unattached vs gone, never proves a channel
- [ ] Headless takeover REFUSED while presence holds
- [ ] Handoff legal only at turn boundaries except lease-expiry takeover (aborts turn)
- [ ] (D-020) handoff exactly-once oracle deferred to M5.4, NOT claimed here

### Gate 4→5
- [ ] Exactly-one-writer under two attaches + stale-lease takeover (epoch-observable)
- [ ] Lease expiry mid-turn aborts turn
- [ ] Channel-auth refusals (attach + event/input/control; impersonated end/switch-path)
- [ ] No-lost / no-duplicated input (durable disposition + idempotent ids)
- [ ] Credit starvation coalesces droppable, never lossless; queue bounded
- [ ] Heartbeat-vs-slow-turn; cross-conversation isolation
- [ ] Reducer suite fully deterministic (injected clock, zero wall-clock reads)
- [ ] Refusals carry named issues; no refusal path half-applies

## Phase 5: Store, modes, claude adapters

### M5.1: Durable conversation store (the host)
Source: implementation.md M5.1; D-004, D-021

- [ ] Append-only conversation log; seq authority
- [ ] Crash-safe append; fold to state
- [ ] Secret minted 0600 at record creation
- [ ] `host.grantCredit()` wired
- [ ] Presence polling calls normalizer `isInteractive(sid)` on a cadence
- [ ] RED: torn trailing line tolerated; fold idempotent
- [ ] RED: secret file permissions; refusal on missing/wrong secret
- [ ] RED: presence alive + heartbeat timeout => interactive-unattached, not agent-gone
- [ ] RED: concurrent unrelated conversations isolated
- [ ] RED: headless-vs-headless concurrent resume - exactly one wins, other refused stale-epoch (D-021)

### M5.2: Headless modes mapped in
Source: implementation.md M5.2

- [ ] HarnessEvent -> event frames
- [ ] input -> send (session mode) or next-turn prompt (turn mode)
- [ ] droppable/lossless mapping
- [ ] RED (fake spawner): headless-session queue/steer dispositions
- [ ] RED: headless-turn queues between turns
- [ ] RED: limit/error terminates turn with durable record
- [ ] turnId correlation runner-events -> frames -> dispositions

### M5.3: claude interactive ladder - rungs 1-3
Source: implementation.md M5.3; A-002 evidence; D-008, D-017, D-023, D-025

- [ ] Hooks adapter: SessionStart announce -> attach (requires `--setting-sources project` + HERDR_ENV unset, D-025)
- [ ] Hooks adapter: PostToolUse/Stop boundary injection with disposition
- [ ] Transcript tail -> message events
- [ ] At attach, query `capabilitiesOf` (runtime-verified; degrade to curated/unknown)
- [ ] Cooperative rung: wait-poll delivery [GATED on A-003 retry]
- [ ] Observe-only rung: tail + queue with resume instruction [GATED on A-003 retry]
- [ ] RED (logic, fixtures): rung degradation order
- [ ] RED: input chunking under the 10k cap
- [ ] RED: tail resumes after adapter restart without dupes (per-epoch n)
- [ ] RED: capabilities source runtime-verified vs curated fallback
- [ ] RED: forbidden path - headless resume while presence holds is refused
- [ ] Verify (live smoke): rung-1 injection disposition + terminal rendering

### M5.4: States + handoff wired end to end
Source: implementation.md M5.4; D-020

- [ ] State machine drives per-conversation mode selection
- [ ] RED: attached -> unattached (heartbeat)
- [ ] RED: unattached -> gone (presence)
- [ ] RED: gone -> headless takeover
- [ ] RED: interactive reattach epoch++
- [ ] RED: boundary-only handoff enforced
- [ ] RED: mid-flight exactly-once handoff (headless<->interactive, tokens in flight) via resumeFrom + acks (D-020)

### Gate 5→6
- [ ] End-to-end fake-harness conversation across all three modes with mid-conversation handoff, exactly-once
- [ ] Live claude: rung-1 session streams in + message injects at a tool boundary
- [ ] rungs 2-3 on a bare session [waived-with-note if A-003 still deferred]

## Phase 6: TUI + skill

### M6.1: Minimal TUI
Source: implementation.md M6.1; D-009

- [ ] Conversation view over the folded log
- [ ] Input box
- [ ] State + rung indicator
- [ ] Per-item disposition marks
- [ ] TUI view == fold(conversation log), no separate state
- [ ] Verify: scripted pty run + manual pass against live claude

### M6.2: The milestone-1 skill
Source: implementation.md M6.2

- [ ] Skill documents frames, epoch/single-writer rule
- [ ] Capability declaration with source (runtime-verified)
- [ ] Fallback ladder stated truthfully
- [ ] Disposition discipline + yield rules
- [ ] Verify: a cold-start agent drives a full conversation using only the skill

### Gate 6→7
- [ ] A human (TUI) and an agent (skill) each complete a full review-shaped conversation against live claude

## Phase 7: Full test surface + landing

### M7.1: Oracle completion sweep
Source: implementation.md M7.1; PLAN.md 4.7

- [ ] Audit 4.7 oracle list against the suite
- [ ] RED (if missing): spawn-boundary security set (argvOrder, path traversal, control chars)
- [ ] RED: resumeLast race
- [ ] RED: credit-starvation classes
- [ ] RED: identity collisions

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
- Gates M5.3 rung-2/3 tasks and the Gate 5→6 bare-session checkbox.

### DF-2: A-004 constraint characterization
Source: spikes/evidence/A-004.md

- [ ] 10k hook feedback cap measured
- [ ] Hooks-captured-at-session-start confirmed (mid-session config edit)
- [ ] Injected-text terminal rendering captured
- No architectural impact; measured opportunistically at M5.3.

## Superseded/obsolete checklist debt

- [x] ~~openSession-semantics-differ risk~~ - resolved by A-001 pass
- [x] ~~escape hatch 1 (if A-001 fails)~~ - retired, A-001 passed

## Summary
- Total features: 181
- Completed: 45 (milestone-0 spike evidence: 4; M1.1: 6; M1.2: 5; Gate 1→2: 3; M2.1: 18; M2.2: 4; M2.3: 5)
- Remaining: 136
- Current cutoff blockers: 136
- Accepted/deferred follow-up: 5 (DF-1: 2, DF-2: 3)
- Superseded/obsolete checklist debt: 2 (both resolved)

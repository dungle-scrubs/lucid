# 00-chat-substrate - Spike Guide

<!-- D-013 --> This spike IS PLAN.md's milestone 0: prove the claude-code
integration facts in code before any protocol code exists. All spike code
lives in `~/dev/lucid-v2/spikes/` - throwaway quality, kept as evidence,
never imported by production code. Each experiment writes its evidence to
`spikes/evidence/A-00N.md` (commands run, raw output excerpts, verdict).

Environment: claude CLI 2.1.226 (re-record the version if it changed),
macOS, this machine. The round-2 review verified these facts against docs
and `--help`; the spike's job is to prove them against the running
harness and capture the behavioral details docs don't state.

## Assumptions

### A-001: Persistent headless session (mode 2)

- **Claim:** `claude -p --input-format stream-json --output-format
  stream-json --verbose --include-partial-messages` holds ONE process
  across MANY turns: user messages streamed in via stdin, token-level
  `content_block_delta` events out, turn boundaries detectable, and a
  message sent mid-turn is queued (not dropped, not crashing).
- **Impact if false:** headless-session mode cut for claude;
  `openSession` scoped to pi or dropped; escape hatch 1.
- **Experiment:** `spikes/a001-session.ts` - spawn once; drive 3 turns;
  assert single PID throughout; send a message while turn 2 is
  mid-generation and record its disposition; kill and `--resume` to
  check session continuity.
- **Pass criteria:** 3 turns, one PID; deltas observed on every turn;
  mid-turn send neither lost nor interleaved (queued to turn 3 is a
  pass - record which); clean close emits a result event.
- **Effort:** half a day.
- **Result (D-022):** PASS; also found `system/init` re-emits every turn
  with the SAME session id (raw in `spikes/evidence/a001-raw.ndjson`) - treat
  as turn-start metadata, dedupe, emit `identity` only on first sight or id
  change. Folded into M2.1/M3.1.

### A-002: Hooks adapter profile (rung 1)

- **Claim:** with project hooks pre-installed: SessionStart announces
  identity to a local endpoint; PostToolUse can deliver queued text the
  model acts on mid-turn (tool boundary); Stop with decision:block +
  reason continues the turn acting on the reason; the human's terminal
  session remains usable throughout; no process takeover.
- **Impact if false:** claude interactive drops to rungs 2-3; PLAN.md
  4.4 profile table and narrowing amended; escape hatch 2.
- **Experiment:** `spikes/a002-hooks/` - a `.claude/settings.json` hook
  set pointing at a tiny local receiver + queue file; run a live
  interactive session in a real terminal; queue messages while it works;
  observe delivery points and the model's visible response to injected
  feedback.
- **Pass criteria:** identity announced at start; a queued message
  delivered at a tool boundary changes the model's subsequent behavior
  in-turn; a Stop-time message re-drives the turn; terminal interaction
  unaffected; every delivery's rendering in the terminal recorded.
- **Effort:** one day.

### A-003: Bare-session tiers (rungs 2-3)

- **Claim:** on a session with NO lucid config: the transcript JSONL
  under `~/.claude/projects/<slug>/<id>.jsonl` appends completed
  message/tool events incrementally DURING a turn (tail-able,
  message-granularity observation); and a skill-instructed agent
  polling a wait command receives queued input at turn end
  (cooperative injection).
- **Impact if false:** observe-only/cooperative rungs cut or narrowed;
  interactive coverage limited to lucid-aware sessions; escape hatch 3.
- **Experiment:** `spikes/a003-bare.ts` - tail the transcript of an
  unconfigured live session running a multi-tool turn; measure event
  lag and mid-turn availability. Separately, hand the session a
  minimal poll instruction and verify turn-end pickup.
- **Pass criteria:** tool/message events visible in the tail before the
  turn ends (record lag); zero-config; cooperative poll delivers a
  queued message on the next boundary.
- **Effort:** half a day.

### A-004: Constraint characterization

- **Claim:** the operational constraints hold as documented: hook
  feedback capped near 10k chars; hooks are captured at session start
  (config added mid-session does not take effect without restart);
  injected feedback is visible in the terminal as hook output rather
  than a chat bubble.
- **Impact if false:** input chunking policy, adapter contract wording,
  and the skill's guidance change; no architectural impact.
- **Experiment:** part of `spikes/a002-hooks/` - oversized payload
  (observe truncation/refusal), mid-session hook-config edit (observe
  non-pickup), screenshot/record terminal rendering of injections.
- **Pass criteria:** each constraint confirmed or corrected with
  evidence; the real cap number recorded.
- **Effort:** couple of hours (piggybacks on A-002).

### A-005: Headless-turn resume semantics (mode 1) - SETTLED by D-018

<!-- D-018 --> Recorded as done; the original open questions are decided,
so this section documents the confirmed behavior rather than a hypothesis.

- **Confirmed:** the caller-assigned `--session-id` is stable across
  resumes on 2.1.226 - two consecutive resumes continue one conversation
  under the original id, one store file, no new id emitted. The normalizer
  carries NO id-rotation/re-bind handling; `--fork-session` is reserved for
  deliberate branching only.
- **Refuted (the load-bearing half):** resuming a LIVE session does NOT
  refuse or fork - the harness appends the intruder turn straight into the
  live conversation with no lock or guard. So single-writer safety is not a
  harness guarantee; it must come from lucid's presence gate + epoch
  fencing (D-017's forbidden-path rule is normalizer-enforced policy).
- **Evidence:** `spikes/evidence/A-005.md` (two-resume continuity; live
  store grew 9->15 lines with the intruder turn present).

## Exit

All five pass/fail/deferred -> write `spikes/evidence/spike-report.md`
summarizing verdicts + the behavioral details discovered, register it,
merge learnings into implementation.md (updating the Assumptions table
out and the affected milestones), archive this guide, advance to
CONVERGE.

<!-- D-007 --> The spike report also closes the wire-transport deferral:
capture A-001's turn-boundary and A-003's liveness/tail observations in
transport-neutral terms (what the state machine needs, independent of
stdio vs socket) and hand the transport choice to CONVERGE with that
evidence attached.

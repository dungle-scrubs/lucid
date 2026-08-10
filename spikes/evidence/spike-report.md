# 00-chat-substrate - Spike Report (milestone 0)

Date: 2026-08-10 · claude CLI 2.1.226 · macOS (pro)

Milestone 0 proved the claude-code integration facts the design rests on,
in code, before any protocol code. Five assumptions, all resolved.

## Verdicts

| Code | Verdict | One-line result |
|------|---------|-----------------|
| A-001 | **PASS** | Persistent headless session: one process, 3 turns, token deltas, mid-turn send queued, resume continuity. |
| A-002 | **PASS** (core) | Hooks adapter rung 1: SessionStart announce + PostToolUse mid-turn boundary injection + terminal continuity. Stop-path partial. |
| A-005 | **FAIL** (learnings merged) | No id rotation (simpler than assumed); but concurrent resume of a LIVE session appends with NO harness guard - presence gate + epoch fencing are the only defense. |
| A-003 | **DEFERRED** | Bare-session tail/cooperative rungs not measured (driver startup-timeout); fallback tiers, self-gated by M5.3 entry criterion. |
| A-004 | **DEFERRED** | Constraint numbers (10k cap etc.) not measured; no architectural impact; measured at M5.3. |

## The transport-neutral liveness facts (closes D-007 deferral)

From A-001/A-002 in transport-independent terms, for the state machine:
- A turn is delimited by a `result` event (A-001); `system/init` re-emits
  per turn with a stable id (D-022) - turn-start metadata, dedupe.
- Mid-session input is accepted and queued to the next turn boundary (A-001
  headless) or delivered at a tool/turn boundary via hooks (A-002
  interactive). Neither depends on stdio vs socket.
- Liveness has no harness signal on the interactive side beyond transcript
  activity + presence; the protocol's own heartbeat is required (this is
  why 4.3 liveness is heartbeat-decided, presence-corroborated).
The wire-transport choice (D-007) can now be made at CONVERGE with these in
hand; nothing here forces stdio or socket.

## The load-bearing surprise

A-005: the harness offers ZERO single-writer protection. This promoted the
presence gate + epoch fencing from defense-in-depth to the ONLY defense
(D-018, D-021), and made the forbidden-path test load-bearing (M5.3).

## The operational unlock

The interactive spikes hung on inherited machine-global Stop hooks. Fix
(D-025): `--setting-sources project` + `HERDR_ENV` unset for any nested
claude session - this is now a requirement of the interactive adapter
itself, not just the spike harness.

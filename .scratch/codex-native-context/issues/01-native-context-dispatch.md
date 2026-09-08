# Dispatch verified Codex turns with native context management

Status: resolved
Blocked by: none

## What to build

Expose verified native compaction through hcn descriptor inspection. Use that
capability for managed headless turns while preserving the full offered context,
exact executable verification, saved settings, native continuity, and durable
failure recovery. Other routes retain their preflight accounting path.

## Acceptance criteria

- [x] HCN declares Codex native compaction separately from unavailable accounting.
- [x] Lucid rejects malformed declarations and limits use to verified headless turns.
- [x] Full context and preparation fences survive native dispatch.
- [x] Deterministic native dispatch, same-session resume, failure preservation,
      cancellation, stale settings, and unchanged preflight tests pass.
- [x] Full Lucid and hcn checks, compiled builds, and hcn skill audit pass.
- [x] Cross-family review findings are answered.
- [x] Local server processes the user's four saved prompts and shows responses.

## Parent

RFC-19; repeated user requests to fix Codex dispatch, 2026-09-08.

## Verification

Lucid check: 1363 tests pass; compiled build and diff check pass. HCN: 913
tests pass in each runtime; package build/check and skill claim checks pass.
Cross-family reviewer: opus-5@claude; all nine findings answered in RFC v2.
The actual user record completed all four saved prompts, each on attempt 1.
The first turn established one Codex session; all three later turns resumed it.
Desktop and mobile show responses with no context-accounting error cards.
Evidence: primary checkout artifacts/evidence/codex-native-context/.

Local server uses the explicit LUCID_HCN checkout at commit e6afc2f.
The published 0.6.4 dependency does not yet contain this capability; release
integration must update the dependency pin, HCN_MIN_VERSION, and recordings
together before removing the local override.

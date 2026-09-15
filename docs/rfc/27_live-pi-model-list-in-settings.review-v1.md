# Review: RFC-27 v1, live pi model list in settings

## What was reviewed

- Path: `docs/rfc/27_live-pi-model-list-in-settings.rfc.md`
- Version: v1
- Status: Draft
- Reviewer route: `gpt-5.6-sol@codex` via the delegate walk (intended ==
  actual, status ok). The worker ran in a read-only workspace, so it could
  not write this file; the session author transcribed its report verbatim
  below and verified the two local facts it asserts.

## Structural results

The worker's `npx tsx` validator call did not finish package resolution in
its network-restricted runner, so it produced no output there. The session
author ran the same command locally during drafting:

```text
{
  "passed": true,
  "errors": [],
  "warnings": []
}
```

## Findings

- **F1 (Terminology/Design; rung 2):** `models.json` is custom
  configuration, not pi's full installed-model registry. Verified
  locally: `/Users/kevin/.pi/models.json` holds 4 providers and 7
  models (lmstudio, lmstudio-mini, meta, openrouter), while
  `pi --list-models` prints 25 rows across 7 providers. The remaining
  providers (zai, minimax, openai-codex) live in `models-store.json`.
  The RFC's Design section reads only `models.json`, so the served list
  would omit most installed models.
- **F2 (Design; rung 2):** the fallback path is wrong. Verified locally:
  `~/.pi/agent/models.json` does not exist; the agent-scoped store is
  `~/.pi/agent/models-store.json` (empty dict on this machine). The RFC
  names `~/.pi/models.json` as the fallback.
- **F3 (Design; rung 3):** the current `models: string[]` shape plus the
  settings datalist cannot preserve provider/model pairs without
  ambiguity. `qwen3.6-35b-a3b-ud-mlx` exists under both `lmstudio` and
  `lmstudio-mini` in the live list output. The RFC's Open Question 1
  spots this, but the Design section does not specify the pair shape
  through seam, served choices, and control.
- **F4 (Design; rung 2):** conflicting refresh requirements. The Design
  section says both "re-read on each poll cadence the existing memo
  already uses" and "read once per process". The memo is once per
  process; only one of these can hold.
- **F5 (Error Handling; rung 2):** no consistent result for malformed,
  unavailable, or partly valid registry data. The section names
  `registry-unreadable` and `registry-unparseable` but never says which
  source value (`source: "unavailable"` vs baseline-only vs partial
  pairs) each produces, and partial validity (one bad entry among good
  ones) is unspecified.
- **F6 (Design; rung 3):** the RFC conflates pre-write HCN inspection
  with native spawn-time availability. `hcn inspect` validates the
  selection shape; pi decides availability at spawn. A listed pair can
  still refuse (logged-out provider, withdrawn model), so the list MUST
  NOT be specified as admission evidence. The RFC says this once but
  also leans on "validating the pair at save" as if save-time success
  settles it.

## Cleared

- The fit is sound: same surface, same user, one list corrected.
- The hcn boundary holds: hcn owns the read and projection, Lucid
  consumes operation results, no second registry in Lucid.
- Rejecting `pi --list-models` parsing (spawn cost, human-readable
  table, no JSON mode) and rejecting a direct Lucid file read are both
  correct with the evidence cited.
- Security section correctly scopes the projection to provider/model
  pairs and excludes `apiKey` fields.
- `extensible: true` stays, so unlisted ids remain valid choices.

## Not reviewed

- The hcn-side implementation (spawn cost, JSON shape, fixture
  discipline) beyond what the Lucid RFC specifies; that review belongs
  to the hcn repo when its half is specified there.
- Taste of the provider grouping in the control; Open Question 1 covers
  the shape, and visual design follows implementation.

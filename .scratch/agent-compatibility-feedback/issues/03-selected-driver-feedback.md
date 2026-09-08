# 03 - Explain compatibility of the selected driver

Status: resolved
Blocked by: 02
Publication: local only
Source: RFC 20, version 2 - Authority and version policy; Check boundaries and lifetime; Diagnostic contract; Error Handling.

## What to build

When the person opens or changes a managed driver preference, explain known
harness-version and selection problems before another prompt where possible.
Show this feedback in the existing compatibility region with the selected
driver and operation identified. Retain the preference and document access.

Use HCN's version-only inspection and existing structured selection refusals.
Treat a saved interactive preference as a human-owned route, without probing
a substitute headless process to describe it.

## Acceptance criteria

- [x] A managed selection uses its actual working folder and settings. Its detected executable and verified harness version come from the same runtime inspection; missing facts remain unknown. A mismatch is described as unverified, with severity limited to the RFC's existing-operation policy.
- [x] A structured model, profile, or capability refusal has its own selection-unsupported explanation. A matching version does not imply capability support, and an unlisted model in an extensible vocabulary is not rejected merely for being absent from the list.
- [x] The current selection's diagnostic reaches the conversation response and shared notice region, identifies the selected driver and operation, and remains accessible with chat closed. Existing settings errors use the same safe facts and announcement deduplication.
- [x] Observation sharing uses all RFC identity inputs: selected HCN, harness, model, effort, provider, profile, working folder, and applicable native-resume identity. Concurrent requests share a probe; polling and multiple tabs do not repeat diagnostic probes. A changed selection permits a new observation, and late results cannot replace current feedback.
- [x] Missing settings or working folders retain their existing errors without probing guessed defaults. Version-only inspection reuses the harness boundary's timeout, cancellation, output-limit, and child-cleanup facilities, without model prompts or context accounting.
- [x] Opening or changing a saved interactive preference adds no native-executable diagnostic probe or headless substitution. Applicable HCN notices refer to managed work; human-owned attachment and existing settings validation retain their own behavior.
- [x] Diagnostic caching does not suppress or refresh from existing recovery availability. Its current trigger conditions, per-server/key 1500 ms cache, fresh/resume probes, interactive recovery conversion, and actions remain unchanged.
- [x] Selection inspection alone creates no attempt or durable event, changes no preference, and acquires no execution authority. The worker retains its independent execution checks. Artifact creation, viewing, editing, and saving add no compatibility probe.
- [x] Deterministic tests cover matching, unverified, unknown, malformed and unsupported evidence, identity changes, concurrent requests, stale results, saved interactive preferences, and unchanged recovery refresh. A fake-HCN browser demonstration verifies changed selections and notices with chat closed, keyboard access, deduplicated announcements, and the three RFC viewport widths.
- [x] Current selection/API contracts describe the behavior and limitations. Repository check, build, and whitespace gates pass, with no new repair or recovery controls.

## Resolution

Implemented autonomously on `feat/agent-compatibility-feedback` in
`/Users/kevin/dev/lucid-compatibility`. selection-compatibility.test.ts proves shared observation, nonblocking preview, warning-only preview failure, structured refusal retention and interactive exclusion. Current observations are shared by full identity and superseded references are released. Browser checks show HCN and selected-harness warnings together outside the closed panel. Runtime, recovery and worker inspections keep separate lifetimes.

Final gates: `bun run check` passed 1,385 tests / 7,124 assertions;
`bun run build`, `bun run build:package`, and `git diff --check` passed.
One independent four-axis review ran through opus-5@claude. Its corrections
were applied; full reports and browser/process evidence are ignored under
`artifacts/evidence/compatibility/`. No model call was used for feature
verification. No publication or landing is included.

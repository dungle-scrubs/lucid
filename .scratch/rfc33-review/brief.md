# Task
Review RFC 33 (publish-time theme declaration guard) in /Users/kevin/dev/lucid.
Follow the review-rfc skill. Write the review beside the RFC as
docs/rfc/33_publish-time-theme-declaration-guard.review-v1.md.

## Inputs
- RFC: docs/rfc/33_publish-time-theme-declaration-guard.rfc.md (status Draft,
  unversioned; snapshot it by SHA-256 per the skill).
- Normative references the RFC names: docs/artifacts.md section "Application
  and artifact appearance", test/server/artifact-theme.test.ts,
  src/cli/artifact-publish.ts, src/cli/handoff.ts.
- Skills available: review-rfc.

## Requirements
- Run the structural validator first, report output verbatim.
- Grade every finding on the evidence ladder, name the rung.
- Whole-document checks: uncovered states, dangling references, unused or
  undefined terminology, conflicting normative statements, scope not
  delivered, drift from the codebase.
- Answer the three Open Questions with a position each.
- Keep it under 400 lines.

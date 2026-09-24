# Brief: review RFC 32 (any-session handoff to Lucid)

## Task
Review the RFC per the review-rfc skill and write the review file. Read-only work: read files, write exactly one new review file, change nothing else.

## Inputs (read these yourself)
- RFC under review: /Users/kevin/dev/lucid/docs/rfc/32_any-session-handoff-to-lucid.rfc.md
- Review skill (follow it in full): /Users/kevin/.agents/skills/review-rfc/SKILL.md
- Technical writing (apply while drafting): /Users/kevin/.agents/skills/technical-writing/SKILL.md
- Validator: /Users/kevin/.agents/skills/draft-rfc/scripts/validate-structure.ts (run it first, report output verbatim)
- Codebase context: /Users/kevin/dev/lucid repo at the current checkout. Key files the RFC cites: src/cli/artifact-publish.ts, src/protocol/frames.ts, src/store/log.ts, src/store/conversation-context.ts, src/store/native-registration.ts, src/store/presence.ts, src/cli/managed-worker.ts, src/cli/native-context.ts, src/store/conversation-host.ts. Related specs: docs/skill-chat-substrate.md, docs/architecture.md, docs/drivers.md, docs/rfc/26_interactive-artifact-conversation-continuity.rfc.md, docs/rfc/README.md.
- Wayfinding decisions behind the RFC: https://github.com/dungle-scrubs/lucid/issues/299 (map), issues #300-305 (closed tickets with evidence).

## Requirements
1. Run the structural validator first and report its output verbatim.
2. The review file lands at /Users/kevin/dev/lucid/docs/rfc/32_any-session-handoff-to-lucid.review-v1.md, in the exact output shape the review skill requires (what was reviewed, structural results, findings with section + evidence-ladder rung, cleared, not reviewed).
3. Every finding cites file:line or a section heading. A search that found nothing is still reported as a result.
4. Hunt whole-document properties: uncovered states, dangling references, unused/undefined terminology, conflicting normative statements, scope claimed but not specified, drift from the cited code behavior. Verify at least three MUST statements against the actual code cited.
5. Grade each finding on the evidence ladder. Reference: /Users/kevin/.agents/skills/blast-radius/references/EVIDENCE-LADDER.md (read it yourself; if absent, grade inline as hunch/observation/demonstrated and say so).
6. Never edit the RFC. The review is a separate document.

## Output slot
Write the review file to the path above and return: the validator output, the count of findings by grade, and the list of sections marked cleared vs not reviewed.

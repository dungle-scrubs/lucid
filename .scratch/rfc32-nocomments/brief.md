# Brief: comment review of the handoff command diff

## Task
Review comments in the diff for deletion per the comment-sicko definition. Report findings only; leave all files unchanged.

## Scope
The exact commit is 566331c on branch feat/rfc32-handoff-command in /Users/kevin/dev/lucid. Review ONLY these files from that commit:
- src/cli/handoff.ts (new)
- src/cli/handoff-request.ts (new)
- src/cli/mapping.ts (handoff hunk only)
- src/cli/dispatch.ts (handoff hunk only)
- test/cli/handoff.test.ts (new)
- test/cli/handoff-request.test.ts (new)

Do NOT review docs/rfc files, pre-existing branch changes, or any other file.

## Inputs (read these yourself)
- Comment-sicko definition: /Users/kevin/.pi/agents/comment-sicko.md (read the full file before reviewing)
- The diff: run `git show 566331c -- <file>` yourself in /Users/kevin/dev/lucid for each file above
- Project instructions: /Users/kevin/dev/lucid/AGENTS.md (read it; it governs comment conventions)

## Requirements
1. Recommend deletion for narration, section banners, commented-out code, and workaround justifications unless a keep condition from the definition applies.
2. For suppressions, inspect the diagnostic; correctness/safety suppressions are MUST KILL with the fix.
3. Every finding names the file and line, quotes the comment, states delete or keep with the exact keep condition.
4. Return counts: comments reviewed, deletions proposed, keeps with conditions, MUST KILL flags.

## Output slot
Return the findings list. Write no files.

## Summary

<!-- What this changes, and why. One or two sentences. -->

## What changed

<!-- The notable edits. Skip anything mechanical. -->

## How verified

- [ ] `bun run typecheck`
- [ ] `bun run lint`
- [ ] `bun test test/*.test.ts`
- [ ] `bunx playwright test` (if the change touches the viewer, overlay, or chrome)
- [ ] Rebuilt **and restarted** the viewer, if client code changed - a running
      viewer serves the bundle its binary embedded at compile time

## Linked issue

<!-- Closes #NNN, or "none". -->

<!--
Title follows Conventional Commits: feat:, fix:, docs:, refactor:, test:, chore:
CONTEXT.md is the canonical vocabulary and wins on conflicts.
-->

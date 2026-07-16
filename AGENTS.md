# Agent conventions for this repository

Rules for any coding agent working on Lucid. `CONTEXT.md` is the canonical
vocabulary and wins on conflicts; the decision ledger (D-001..) lives in
`.plans/lucid/`.

## Icons

**Never draw an SVG from scratch. Every icon is a [Lucide](https://lucide.dev)
icon**: copy its path data inline, stroke style, `stroke-width: 1.5`,
`stroke: currentColor`, no fills. Solo icons only for truly universal actions,
always with an accessible label. Existing examples to follow:
`client/chrome/Header.tsx` (crosshair), `client/chrome/Thread.tsx`
(chevron-down). The full iconography rules are in
`skills/lucid-design/README.md` §4.

## Design

All chrome UI follows the Lucid design system - load the `lucid-design` skill
(`skills/lucid-design/`) before styling anything. Dark ink, cream type, one
brass accent; sage marks the agent, amber the human, and neither is ever
decoration. No emoji, no exclamation marks, sentence case.

## Build and verify

```sh
bun run build:client   # browser bundles + Tailwind -> generated constants
bun run build          # + compile the single binary -> dist/lucid
bun run typecheck && bun run lint
bun test test/*.test.ts && bunx playwright test
```

- A running viewer serves the bundle its binary embedded at compile time:
  after client changes, rebuild AND restart the viewer, then verify against
  `curl http://127.0.0.1:<port>/__lucid/client.js` - green tests against a
  stale bundle are not green.
- The wait payload has two consumers: the agent reads bytes by absolute
  `path`, the viewer fetches by `file` URL. Any payload field referencing a
  stored asset carries both.
- Zustand selectors must return stable slices; a selector that filters or maps
  re-renders forever (React #185). Select the slice, derive with `useMemo`.

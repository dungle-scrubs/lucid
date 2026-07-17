# Agent conventions for this repository

Rules for any coding agent working on Lucid. `CONTEXT.md` is the canonical
vocabulary and wins on conflicts; the decision ledger (D-001..) lives in
`.plans/lucid/`.

## Icons

**Never draw an SVG from scratch. Every icon is a [Lucide](https://lucide.dev)
icon, no exceptions**: copy its path data inline, stroke style,
`stroke-width: 1.5`, `stroke: currentColor`, no fills. If a glyph is not in
Lucide, the answer is a different Lucide icon, not a hand-drawn path. Solo icons
only for truly universal actions, always with an accessible label. Existing
examples to follow: `client/chrome/Header.tsx` (crosshair),
`client/chrome/Thread.tsx` (chevron-down). The full iconography rules are in
`docs/DESIGN.md` §4. The brand marks are `assets/*.svg` - reference them, never
redraw them.

## Design

Two design systems, and they are not interchangeable:

- **The chrome** (this app) follows `docs/DESIGN.md`. Dark ink, cream type, one
  brass accent; sage marks the agent, amber the human, and neither is ever
  decoration. No emoji, no exclamation marks, sentence case. The tokens live in
  `client/chrome/styles.css`; the running chrome is the only reference
  implementation of a Lucid control.
- **The artifact** (the agent's document, inside the iframe) is **paper** and
  follows the optional `lucid-design` skill. It is content, not Lucid UI, and it
  renders identically with or without Lucid, so it never wears the chrome's
  palette. Do not style an artifact from `docs/DESIGN.md`.

## UI primitives

**Reach for a library primitive before hand-rolling any control - no
exceptions.** If assistant-ui or shadcn/ui ships a solution for what you are
building (a control, an overlay, a menu, a field, a keycap), vendor and use it;
a bespoke element needs a stated reason in its header comment for why neither
covered it. "It was faster to write" is not a reason.

Chat and transcript primitives come from **assistant-ui**. For everything it
does not cover (sidebar, tabs, select, kbd, and future shell chrome), use
**shadcn/ui, the Base UI variant** - `shadcn add <c> -b base` against the
`base-nova` registry - vendored under `client/chrome/ui/`. shadcn is open code, not a dependency: the
copies are ours to edit, and they inherit Lucid's palette through the
`@theme inline` shadcn variable bridge in `styles.css` (including the
`--color-sidebar-*` ramp) rather than carrying a second theme. Keep each vendored
file close to upstream so a later `shadcn add` stays diffable; note the edits in
its header comment. Runtime deps this pulls in: `@base-ui/react`,
`class-variance-authority`, `clsx`, `tailwind-merge`. Icons inside these
components still follow the Lucide-only rule above.

## Build and verify

```sh
bun run build:client   # browser bundles + Tailwind -> generated constants
bun run build          # + compile the single binary -> dist/lucid
bun run typecheck && bun run lint
bun test test/*.test.ts && bunx playwright test
```

- A running viewer serves the bundle its binary embedded at compile time, and
  the per-session daemon is detached (D-036): `lucid open` on a live session
  reattaches to the old process, so a rebuild stays invisible. After client
  changes, rebuild AND replace the daemon with **`lucid open <file> --restart`**
  (stops the live daemon, spawns a fresh one on the new binary, session
  untouched). Then verify against `curl http://127.0.0.1:<port>/__lucid/client.js`
  - green tests against a stale bundle are not green.
- The wait payload has two consumers: the agent reads bytes by absolute
  `path`, the viewer fetches by `file` URL. Any payload field referencing a
  stored asset carries both.
- Zustand selectors must return stable slices; a selector that filters or maps
  re-renders forever (React #185). Select the slice, derive with `useMemo`.

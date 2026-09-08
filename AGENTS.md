# Agent conventions - lucid-v2

Coding-agent rules for this repo. `CONTEXT.md` wins on product scope and vocabulary.
`docs/README.md` routes current contracts and active work;
`docs/smoke-seven.md` wins on smoke semantics. Completed proposals and
reviews live in Git, as described in the documentation index.
Architecture decisions live in `docs/adr/`; read the governing ADR before
changing what it covers.
For changes larger than a correction, follow the RFC workflow in
`docs/rfc/README.md` before code.

## Build and verify - single command

```sh
bun run check   # lint + typecheck + test (also `bun run lint && bun run typecheck && bun test`)
```

Individual gates:

```sh
bun run lint         # biome check .
bun run typecheck    # tsc --noEmit
bun test             # deterministic, clock-injected, fake hcn
bun scripts/smoke-handoff.ts   # handoff oracle, writes artifacts/evidence/handoff-smoke.md
```

### The binary is built by a script, not by `bun build`

```sh
bun run build      # -> scripts/build.ts -> dist/lucid
```

Never change this back to `bun build --compile`. Bundler plugins do not run
through the `bun build` CLI - only through `Bun.build`'s API, or through
`bunfig.toml` for the dev server. The browser stylesheet starts with
`@import "tailwindcss"`, so a CLI build warns `invalid @ rule encountered:
'@theme'`, emits the raw import, and **succeeds**. The binary runs and serves
a stylesheet with no Tailwind in it.

`scripts/build.ts` reads the binary back and fails loudly when that happens.

Tailwind arrives as two packages, both pinned exactly, for the same reason
hcn is: `bun-plugin-tailwind` carries the compiler, `tailwindcss` carries the
CSS that `@import` resolves to. Bump them together or the compiler and its
source drift apart.

A patch is green only when `bun run check` is green. Do not skip gates via `-k not` / `--deselect`.

## What "full e2e" means here

`bun test` is the proof (deterministic, clock-injected, fake harness). Full e2e adds a **live-harness confirmation** against a real model - nondeterministic, not gating CI, evidence-logged.

- Deterministic proof: `test/harness/*`, `test/modes/headless.test.ts`, `test/store/store.test.ts`, `test/protocol/*`, `test/gate-5-6.test.ts` - every smoke in `docs/smoke-seven.md` has a fake-hcn oracle.
- Live confirmation, one lane per thing that can only be proven against a
  real process. Run on demand:
  - `scripts/smoke-live.ts` - a harness driven through `hcn`, per harness
  - `scripts/smoke-resume.ts` - a harness recalls its own session after the
    process is lost
  - `scripts/smoke-cross-harness.ts` - one record, two different harnesses
  - `scripts/smoke-handoff.ts` - two processes, baton-passed
  - `scripts/smoke-interactive.ts` - the mode with no `hcn` in it at all: a
    claude session lucid does not own, reached through project-scope hooks

  The interactive lane confirms the human-owned integration mode.
  It has a negative control:
  with the hooks removed the session answers its own prompt and lucid never
  attaches.

**Do not gate a deepening refactor on live models alone.** If deterministic gates are green and live confirmation shows transcript folding, the seam is proven.

## Live-model confirmation

The standing live model is local Qwen through LM Studio. Query the chosen
machine's current model list before a run; do not assume a model inventory
from an old session. Use the shared home-network and local-inference
references for machine selection and routing. Prefer mini for isolated
handoff runs when local record locks must remain undisturbed.

Route local models through an extensible hcn harness such as pi. A direct
model call can prove store/protocol plumbing when a harness is unavailable,
but cannot prove a harness-process or hook-integration claim.

## Verification discipline

- Never weaken correct code to make a self-authored test pass - the repo's own tests are the oracle.
- After any change that touches `src/store`, `src/protocol`, `src/modes`, or `src/harness`, run the full suite, not just the file you changed: `bun test` (or `bun test test/modes/headless.test.ts` + `test/store/store.test.ts` + `test/protocol/reducer.test.ts` at minimum).
- `biome.json` is the lint gate - do not substitute `tsc` or `gofmt` for it.

## Harness access - through `hcn`, never around it

lucid drives a harness by spawning `hcn --json` and reading its NDJSON. It
does not import the normalizer, and it holds no descriptor.

- **The seam is `src/harness/`.** `HarnessRunner` is the whole interface:
  `openSession`, `streamTurn`, `inspect`, `capabilities`. Above it nothing
  knows what a descriptor is or how a harness frames a turn. Adding a mode or
  a flag means changing that one module.
- **The dependency is pinned exactly** (`@dungle-scrubs/harness-cli-normalizer`),
  because `test/fixtures/hcn/*.ndjson` are recordings of one hcn version.
  Bumping it is a deliberate commit that re-captures them with
  `bun scripts/capture-hcn-fixtures.ts`. `HCN_MIN_VERSION` in
  `src/harness/version.ts` is the floor a running binary must meet.
- **Never hand-write a fixture.** They are evidence. A test that needs a
  sequence no recording shows composes it inline and says so.
- **Do not re-derive hcn's behaviour.** Its flags, event kinds, failure
  classes, and exit codes are documented in its own README and the `hcn`
  skill. Import `EventKind` from `src/protocol/events.ts`; never mirror kind
  literals.
- **An unknown event kind is carried, not dropped.** hcn's kinds are additive
  by contract, so `decodeHarnessLine` passes through what it does not know.
  A decoder that threw there would turn a normalizer release into an outage.
- **Which binary ran is resolved once** - `LUCID_HCN`, then
  `node_modules/.bin/hcn`, then PATH - and logged. Set `LUCID_HCN` to test
  against a different build.

## Context hygiene

Keep current contracts, concise ADRs, active proposals, and executable
verification. Completed plans, resolved reviews, exploratory runs, and
machine inventories do not belong in the working tree. Extract any surviving
contract before removal. Keep recordings only where a test consumes them.
Generated run output belongs under ignored `artifacts/`; never commit it
as instructions or a permanent claim about current behavior.

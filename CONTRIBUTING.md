# Contributing to Lucid

Lucid is pre-1.0. The shape of the thing is still moving, so open an issue
before building anything large - it is cheaper than a rejected PR.

## Setup

Requires [Bun](https://bun.sh) 1.3.0 or newer. Linux and macOS.

```sh
bun install   # also installs the git hooks (via the "prepare" script)
```

Git hooks are managed by [Lefthook](https://lefthook.dev) (`lefthook.yml`), and
`bun install` installs them through the `prepare` script. If they ever go
missing, run `bunx lefthook install`.

- **pre-commit** runs Biome (`biome check`) on the staged files - the same gate
  CI enforces - applying safe fixes and re-staging them; real lint errors block
  the commit.
- **pre-push** runs `bun run typecheck` and a
  [TruffleHog](https://github.com/trufflesecurity/trufflehog) verified-secret
  scan (`scripts/secret-scan.sh`), which no-ops with a warning if TruffleHog is
  not installed. The scan is local by design: catching a secret after it is
  pushed is too late to matter.

Bypass a hook with `git commit`/`git push --no-verify` when you have reason to.

## Build and verify

```sh
bun run build:client   # browser bundles + Tailwind -> generated constants
bun run build          # + compile the single binary -> dist/lucid
bun run typecheck && bun run lint
bun test test/*.test.ts

bunx playwright install chromium   # once
bunx playwright test               # end-to-end against a real browser
```

Run all of it before opening a PR. CI on Linux runs the build, then typecheck,
lint, and the unit tests, on pull requests and on main. It does not run the
Playwright end-to-end suite - that needs a browser download, so run it locally,
especially for any change to the viewer, overlay, or chrome.

## Two things that will bite you

**A running viewer serves the bundle its binary embedded at compile time.**
After changing anything under `client/`, rebuild *and restart the viewer*, then
confirm what is actually being served:

```sh
curl http://127.0.0.1:<port>/__lucid/client.js
```

Green tests against a stale bundle are not green.

**`src/server/client-bundle.generated.ts` is generated, and not tracked.**
`src/server` imports it, so nothing typechecks or runs until it exists: `bun
install` builds it via the `prepare` script, and `bun run build:client` rewrites
it. If you ever see it missing, that is the command.

It is deliberately not in git. Bun's bundler does not emit byte-identical output
for identical input - identifier mangling and emit length both move between runs
of the same source - so a tracked copy could only be kept honest by a byte
comparison that fails at random, on a defect no author could act on. Not
tracking it deletes the question instead of answering it badly.

## Conventions

- **[CONTEXT.md](CONTEXT.md) is the canonical vocabulary and wins on
  conflicts.** If a PR needs a new term, it belongs there first.
- **[AGENTS.md](AGENTS.md)** carries the code conventions, and applies to human
  and agent contributors alike.
- **Design.** All chrome UI follows the `lucid-design` skill
  (`skills/lucid-design/`): dark ink, cream type, one brass accent; sage marks
  the agent, amber the human. No emoji, no exclamation marks, sentence case.
- **Icons are [Lucide](https://lucide.dev) only**, copied inline as path data,
  `stroke-width: 1.5`, `stroke: currentColor`, no fills. Never draw an SVG from
  scratch. Adding an icon means adding a row to
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) - the copied path data
  carries Lucide's license with it.
- **The agent contract is a contract.** Changes to the wait payload or the
  event log format need a matching update to [docs/CONTRACT.md](docs/CONTRACT.md).
  Agents depend on it off-disk.

## Commits and PRs

[Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`,
`docs:`, `refactor:`, `test:`, `chore:`. There is no release automation wired up
yet; the convention is enforced now so that when it is added, the prefix can
drive the version bump without a history rewrite.

PRs target `main`, which is protected - no direct pushes. Squash merge.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

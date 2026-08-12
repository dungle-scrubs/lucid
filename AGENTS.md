# Agent conventions — lucid-v2

Coding-agent rules for this repo. `PLAN.md` wins on product scope; `docs/smoke-seven.md` wins on smoke semantics.

## Build and verify — single command

```sh
bun run check   # lint + typecheck + test (also `bun run lint && bun run typecheck && bun test`)
```

Individual gates:

```sh
bun run lint         # biome check .
bun run typecheck    # tsc --noEmit
bun test             # 122 tests across 15 files (~1s, deterministic, fake harness)
bun scripts/smoke-handoff.ts   # handoff oracle, writes spikes/evidence/handoff-smoke.md
```

A patch is green only when `bun run check` is green. Do not skip gates via `-k not` / `--deselect`.

## What "full e2e" means here

`bun test` is the proof (deterministic, clock-injected, fake harness). Full e2e adds a **live-harness confirmation** against a real model — nondeterministic, not gating CI, evidence-logged.

- Deterministic proof: `test/modes/headless.test.ts`, `test/store/store.test.ts`, `test/protocol/*`, `test/gate-5-6.test.ts` — every smoke in `docs/smoke-seven.md` has a fake-harness oracle.
- Live confirmation: `scripts/smoke-live.ts` (claude via normalizer's real spawn) and the handoff smoke. These are deferred (DF-SMOKE) — run on demand against an installed harness.

**Do not gate a deepening refactor on live models alone.** If deterministic gates are green and live confirmation shows transcript folding, the seam is proven.

## Live model for this workspace — mini + LM Studio local Qwen

For this workspace, the standing live model is **LM Studio local Qwen** (OpenAI-compatible at `http://localhost:1234/v1` on both `pro` and `mini`).

Available on `pro` and `mini` ( LM Studio on each ):

```
unsloth/qwen3.6-27b-mlx
qwen3.6-35b-a3b-mlx        # mini: qwen3.6-35b-a3b-ud-mlx
lmstudio-community/qwen3.6-27b-mlx
qwen/qwen3-vl-8b  (vl)
openai/gpt-oss-20b
```

Check:

```sh
curl -s http://localhost:1234/v1/models | jq .data[].id
curl -s http://localhost:1234/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model":"qwen3.6-35b-a3b-mlx","messages":[{"role":"user","content":"ping"}],"max_tokens":20}'
```

Harness routing:

- `pi` is the only harness whose descriptor is model-extensible (`pi --provider lmstudio --model qwen3.6-35b-a3b-mlx`) — `~/.pi/models.json` can register local models at runtime, capability claims then degrade to `unknown` rather than refusing.
- `claude` / `codex` / `muse` are pinned to their upstream models; do not route Qwen through them.
- When `pi` is absent, a live check can hit LM Studio directly via `fetch` — this still proves the store+protocol plumbing (seq, transcript, credit) without a harness process.

### Running full e2e on mini

`mini` (M4 Pro iMac, 64 GB, always-on, `ssh mini`) mirrors `pro` via Tailscale and also runs LM Studio. For heavy or isolated runs:

```sh
ssh mini "cd ~/dev/lucid-v2 2>/dev/null || cd ~/dev/lucid && bun run check"
ssh mini "curl -s http://localhost:1234/v1/models | jq .data[].id"
```

Prefer `mini` for live-model handoff smokes that should not disturb `pro`'s `flock` / `presence.lock` activity.

## Verification discipline

- Never weaken correct code to make a self-authored test pass — the repo's own tests are the oracle.
- After any change that touches `src/store`, `src/protocol`, or `src/modes`, run the full suite, not just the file you changed: `bun test` (or `bun test test/modes/headless.test.ts` + `test/store/store.test.ts` + `test/protocol/reducer.test.ts` at minimum).
- `biome.json` is the lint gate — do not substitute `tsc` or `gofmt` for it.

## Harness-cli

Live-harness facts (argv shapes, resume grammar, stream granularity) live in `../harness-cli-normalizer` — the `descriptor` is the single source; do not re-derive flags or transcript vocabulary in lucid-v2. Import `EventKind` from `protocol/events`, never mirror literals.

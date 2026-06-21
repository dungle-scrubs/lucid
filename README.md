# Lucid

Agent-agnostic CLI that lets a terminal coding agent render a response as a
free-form, **addressable** HTML artifact, which a human reviews in a browser and
marks up at the level of individual elements and text ranges. Located feedback
loops back to the agent through a co-located, append-only event log that any
harness can read or resume.

Built with Bun (single binary), Effect (CLI + typed errors), and Lit + Shadow
DOM (the overlay/chrome). See `.plans/lucid/` for the RFC and the decision ledger
(D-001..D-067), and `CONTEXT.md` for the canonical vocabulary.

## What it does

```
agent writes plan.html  ->  lucid open plan.html  ->  human reviews + annotates
                                     ^                          |
                                     |   located feedback       v
                            lucid wait plan.html  <-------  event log (NDJSON)
```

- **Legibility** - rich HTML instead of monospace prose.
- **Surgical addressability + the loop** - every element and text range of the
  agent's output is targetable, and located human feedback is carried back into
  the agent's context. This is the core value.

## Install / build

Requires [Bun](https://bun.sh).

```sh
bun install
bun run build        # builds the browser bundle, then the single binary -> dist/lucid
```

`dist/lucid` is a self-contained binary (the browser overlay+chrome bundle, the
Effect server, and static serving are embedded). For development you can run the
CLI directly with `bun run lucid <args>` (i.e. `bun run src/cli/main.ts`).

## Usage (for the human-facing CLI)

```sh
lucid open <file>     # serve the artifact + open the viewer; prints an opening cursor
lucid wait <file> --since <cursor>   # block for located feedback (JSON on stdout)
lucid wait <file> --reply "<msg>"    # post an agent message, then wait
lucid end  <file>     # end the session
lucid                 # status of discoverable sessions
```

The agent contract is in [`docs/CONTRACT.md`](docs/CONTRACT.md); a drop-in agent
skill snippet is in [`docs/lucid-skill.md`](docs/lucid-skill.md).

## Architecture

```
 lucid open  ->  detached per-session loopback server (Bun.serve, 127.0.0.1:random)
                  |  serves the artifact with the overlay injected at serve time
                  |  watches <file>, commits versions, broadcasts over SSE
                  v
 browser: VIEWER (/__lucid/viewer)
   +-- chrome    (parent document; Lit)   composer | conversation | queue | controls
   +-- surface
        +-- artifact   (isolated iframe; GET /  =  agent HTML, unmodified on disk)
        +-- overlay    (injected Lit + Shadow DOM; hover/click/range targeting)
```

- **Event log** (`.lucid/<name>/log.ndjson`) is the single source of truth.
  Append-only, lock-serialized single appender, globally-monotonic `seq` cursor,
  torn-tail tolerant, folded to state per lifecycle segment.
- **Versions** are segment-scoped, hash-verified snapshots under `versions/sN/`.
- **Anchors** follow the W3C Web Annotation model (element: lucidId -> fingerprint
  -> domPath; range: quote -> position). Resolution runs against the authored
  snapshot then carries forward to current; failures orphan rather than mis-target.
- **Security** (loopback only): Host/Origin validation, path-traversal/symlink
  scoping, dotfile denylist (with a `/.well-known/` carve-out), an enumerated
  asset-extension allowlist, and a fixed `GET /` document route. Auth/token
  hardening is deferred (non-loopback binding is never offered).

## Layout

```
src/
  cli/        @effect/cli entry + command implementations + daemon spawn
  core/       event log, fold, versions, watcher-commit, cursor, wait, paths, lock
  server/     Bun.serve daemon, overlay injection, viewer page, security, discovery
  anchors/    anchor schema + shared DOM capture/resolution (browser + linkedom)
client/       browser bundle: overlay (iframe) + chrome (parent), one entry
scripts/      build-client (embed bundle) + build-binary (compile)
test/         bun unit/integration tests + Playwright e2e
docs/         agent contract + skill snippet
```

## Tests

```sh
bun test            # unit + integration (core, session, server)
bun run test:e2e    # Playwright end-to-end (full render -> annotate -> wait -> revise loop)
bun run typecheck
bun run lint
```

## Status

MVP: the thin slice proving render -> annotate -> wait -> revise -> resume, with
per-session loopback servers, the cheap security mitigations, layered anchors with
orphaned handling, the lock-serialized NDJSON log with cross-agent resume, and the
single-binary build. Deferred (post-MVP): diff/revert UI, inbound image paste,
layout audit, auth/token hardening, multi-artifact-per-session.

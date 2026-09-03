# lucid v2

lucid turns a coding-agent conversation into a durable, local record and a document you can review in the browser.

It can start and drive Claude Code, Codex, Pi, or Muse through [`hcn`](https://www.npmjs.com/package/@dungle-scrubs/harness-cli-normalizer), preserve the conversation when that process exits, and resume it later. When an agent emits an HTML artifact, lucid renders it beside the transcript so you can edit it, annotate exact elements or phrases, and send the notes back as one request.

> **Project status:** working prototype. lucid v2 is local, single-user software and is not published as a package. The executable is named `lucid2` so it can coexist with lucid v1.

## What works

- Durable conversations backed by an append-only NDJSON record.
- Restart and resume with the same harness, or hand a record to another supported harness.
- Live input delivery to a running agent, including after long idle periods.
- One active driver per conversation, enforced with a kernel-held presence lock and epoch fencing.
- Terminal chat, separate driver/viewer commands, and send-from-anywhere input.
- A loopback browser surface for the transcript and one versioned artifact per conversation.
- Artifact rename, edit and save, version history, and non-destructive restore.
- Element and text-range annotations with quote, position, and DOM-path re-anchoring across revisions.
- Exact, all-or-nothing artifact patches so an agent can revise a document without emitting it in full.
- Deterministic tests for protocol, storage, modes, CLI, TUI, server, artifacts, and annotations.

## Requirements

- [Bun](https://bun.sh/) 1.3 or newer.
- macOS or Linux with `flock(2)`. lucid refuses writes when a safe lock backend is unavailable.
- At least one supported agent CLI installed and authenticated:
  - `claude`
  - `codex`
  - `pi`
  - `muse`

`bun install` installs the pinned `hcn` dependency used to normalize those CLIs. At runtime lucid resolves `hcn` in this order: `LUCID_HCN`, the checkout's `node_modules/.bin/hcn`, then `PATH`.

## Install and build

```sh
git clone https://github.com/chrisdietr/lucid-v2.git
cd lucid-v2
bun install --frozen-lockfile
bun run build
```

The build produces `dist/lucid2`. Run it from the checkout so it can find the package-local `hcn`, or set `LUCID_HCN` explicitly.

```sh
./dist/lucid2 --help
```

During development, commands can also be run without building:

```sh
bun src/cli/main.ts <command>
```

## Quick start

Start a conversation in an interactive terminal:

```sh
./dist/lucid2 chat demo --harness claude
```

In another terminal, start the browser surface:

```sh
./dist/lucid2 serve
```

Open <http://127.0.0.1:17454/c/demo>. Ask the agent to produce an HTML document; it will appear beside the transcript when the agent emits it as a lucid artifact.

### Terminal controls

| Key | Action |
|---|---|
| `Enter` | Queue and send the current input |
| `Alt+Enter` | Steer a running session immediately |
| `Backspace` | Delete the previous character |
| `Ctrl+U` | Clear the draft |
| `Ctrl+C` or `Ctrl+D` | Exit and restore the terminal |

If the harness asks a question, submitting from `chat` answers that question instead of opening an unrelated turn. Answering and steering require a persistent-session profile; use ordinary `Enter` to queue input when lucid selects a per-turn profile.

### Browser controls

- **Use** mode operates the document: check controls, fill fields, and edit supported text.
- **Mark up** mode selects content for a note. Click an element, drag over a phrase, or command-click to add more spots.
- `Option+Backspace` switches between Use and Mark up, including when focus is inside the sandboxed document.
- `Command+Enter` (or `Ctrl+Enter`) adds the open note. With no note editor open, it sends all queued notes.
- Older versions are read-only. Restoring one copies it to a new latest version; no history is overwritten.

## CLI

```text
lucid2 chat [conversation] [--harness <claude|codex|pi|muse>]
lucid2 run [conversation] [--harness <claude|codex|pi|muse>]
lucid2 watch <conversation>
lucid2 send <conversation> <text>
lucid2 serve
```

| Command | Purpose |
|---|---|
| `chat` | Drive a harness, render the transcript, and read input in one TTY. This is the normal entry point. |
| `run` | Drive a harness without the interactive TUI. It follows the record until stopped and does not return after starting. |
| `watch` | Render a read-only terminal view. It never acquires the executor lease or dispatches input. |
| `send` | Append input from another process. If no driver is active, the input waits durably for the next one. |
| `serve` | Start the browser UI on `127.0.0.1:17454`. The server appends but never drives a harness. |

If `conversation` is omitted from `chat` or `run`, lucid generates an id. Supplying a stable id is recommended because the browser and the other CLI commands address records by that id.

`announce` and `inject` are internal hook entry points for attaching to a human-owned interactive agent process. They read hook JSON from stdin and use a verified `LUCID_RECORD_DIR` stamp; they are not commands people normally invoke directly.

## Configuration

| Variable | Meaning |
|---|---|
| `LUCID_ROOT` | Record root. Defaults to `~/.lucid2/records`. |
| `LUCID_HARNESS` | Default harness when `--harness` is omitted. Defaults to `claude`. |
| `LUCID_HCN` | Explicit path to the `hcn` executable. |

`LUCID_RECORD_DIR` and `LUCID_TURN_ID` are internal environment stamps passed to interactive hooks.

## Storage model

Each conversation is one directory under the record root:

```text
~/.lucid2/records/<conversation-id>/
├── log.ndjson          # append-only source of truth
├── log.ndjson.lock     # short-lived append transaction lock
├── meta.json           # record version and conversation identity
├── presence.lock       # lifetime lock held by the active driver
└── secret              # per-conversation credential, mode 0600
```

Frames, human inputs, delivery cursors, artifact versions, and artifact metadata all append to `log.ndjson`. State and the transcript are projections produced by folding that log. Artifact versions are immutable and include their author, content type, timestamp, and SHA-256 hash.

The log layer serializes writers with `flock(2)`, catches up under the lock before reducing a new entry, writes complete lines, calls `fsync`, and repairs a torn trailing write on the next locked open. A delivery cursor advances only after effects have been handed to the harness, giving delivery at-least-once behavior while input ids provide deduplication.

## Architecture

```text
                    ┌──────────────────────────┐
                    │ Claude / Codex / Pi /    │
                    │ Muse                     │
                    └────────────▲─────────────┘
                                 │ normalized NDJSON
                           ┌─────┴─────┐
                           │    hcn    │
                           └─────▲─────┘
                                 │ HarnessRunner
                  ┌──────────────┴──────────────┐
                  │ headless session/turn host │
                  └──────────────▲──────────────┘
                                 │ typed frames and effects
┌──────────────┐          ┌──────┴─────────────┐          ┌──────────────┐
│ send/browser ├─────────►│ ConversationHost   │◄─────────┤ chat / run   │
│ append only  │          │ reducer + log fold │          │ lease holder │
└──────────────┘          └──────┬─────────────┘          └──────────────┘
                                 │
                      ┌──────────▼──────────┐
                      │ durable record      │
                      │ log + two flocks    │
                      └──────────┬──────────┘
                                 │ projections
                         ┌───────▼────────┐
                         │ watch/browser │
                         └────────────────┘
```

The main boundaries are:

- `src/harness/` — the complete harness seam. It spawns `hcn` and decodes its NDJSON; code above it does not know harness descriptors or invocation details.
- `src/protocol/` — frame codecs, the pure reducer, lease/epoch rules, input and credit ledgers, artifact and annotation encodings, and exact patch application.
- `src/store/` — record creation, append transactions, folds, recovery, delivery cursors, artifact indexing, and presence locks.
- `src/modes/` — persistent-session and per-turn orchestration over the common protocol.
- `src/cli/` — command mapping, lifecycle wiring, TUI chat, direct append, and interactive hooks.
- `src/server/` — the loopback API and React browser client.
- `src/tui/` — pure terminal view projection, rendering, and raw-key input.

## Safety boundaries

- The browser server binds only to `127.0.0.1`.
- Each server start mints an in-memory token required in a custom header for API requests; foreign browser origins are rejected.
- The record secret never reaches the browser.
- Agent-authored documents render in a sandboxed iframe without same-origin access to the parent page.
- Only the process holding `presence.lock` may execute effects. Epoch fencing rejects output from a superseded writer.
- Unknown harness event kinds are carried rather than dropped, while malformed protocol frames are refused without partial application.

This is a local same-user security model, not a remote or multi-user service.

## Development

Run the complete deterministic gate:

```sh
bun run check
```

This is equivalent to:

```sh
bun run lint
bun run typecheck
bun test
```

The suite uses injected clocks and fake/recorded `hcn` streams, so it does not need a live model. Live harness confirmations are intentionally separate and nondeterministic:

```sh
bun scripts/smoke-live.ts
bun scripts/smoke-resume.ts
bun scripts/smoke-cross-harness.ts
bun scripts/smoke-handoff.ts
bun scripts/smoke-interactive.ts
```

See [`AGENTS.md`](AGENTS.md) for verification policy and live-model setup.

## Project documentation

- [`CONTEXT.md`](CONTEXT.md) — current product definition, vocabulary, delivered behavior, limitations, and next work.
- [`docs/decisions.md`](docs/decisions.md) — historical decision register.
- [`docs/rfc/`](docs/rfc/) — feature RFCs; the highest applicable RFC supersedes older decisions.
- [`docs/skill-chat-substrate.md`](docs/skill-chat-substrate.md) — complete source-to-host frame protocol.
- [`docs/smoke-seven.md`](docs/smoke-seven.md) — deterministic and live-harness smoke coverage.
- [`PLAN.md`](PLAN.md) — delivered substrate RFC, retained as history.

## Current limitations

- The project is not published; installation is a local build.
- It is designed for one person on one machine, not teams or remote clients.
- A conversation holds exactly one artifact. Start another conversation for another document.
- The terminal names artifact versions but does not render them; artifact review is browser-only.
- The browser surface is functional but intentionally still a visual-design prototype.
- Annotation re-anchoring reports a lost target instead of guessing when a rewrite removes or changes it too heavily.

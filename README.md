# lucid

Read an agent's document, mark it up, and continue the conversation that
produced it. lucid keeps the conversation in a durable local record, so it
survives a process dying or a change of harness.

This workspace builds `lucid2`. It is private and unpublished. It serves
one person on one machine. Product scope and terms live in
[CONTEXT.md](CONTEXT.md).

## Run it

Use Bun 1.3 or later. Install dependencies with `bun install`, then build:

```sh
bun run build
./dist/lucid2 chat demo --harness claude
```

In another terminal, `./dist/lucid2 serve` opens the browser surface at
[the conversation hub](http://127.0.0.1:17454/). The server binds to loopback.
The hub lists local conversations by repository or starting folder; selecting
one opens its artifacts and transcript. **New** creates a conversation with
a working folder and saved harness, model, effort, and mode. Creating or opening
a conversation starts no agent. Submitting a prompt starts or resumes a managed
worker when the saved folder and route support execution.

Each new browser view starts with the conversation panel closed. Use the
Show conversation button beside the Lucid mark to open it. Closing the panel
releases document space and preserves drafts, notes, and the running conversation.

Choose the initial state of the printed link explicitly:

```sh
./dist/lucid2 serve demo --conversation-panel open
./dist/lucid2 serve demo --conversation-panel closed
```

With no arguments, `serve` prints the hub URL. A panel option without a
conversation selects `demo`. The option accepts only `open`
and `closed`. Visibility belongs to that browser view; toggles do not save a
preference. Reloading applies the URL's initial choice again. No record is
created by selecting a conversation here.

| Command | Use |
|---|---|
| `lucid2 chat demo` | Drive a conversation in a terminal window with an input box |
| `lucid2 run demo` | Drive without the terminal interface |
| `lucid2 watch demo` | Follow the transcript |
| `lucid2 send demo "your question"` | Append input to an existing conversation |
| `bun src/cli/main.ts <command>` | Run from source during development |

In chat, Enter queues input and Alt+Enter steers a running turn where the
profile supports it. An open question accepts an answer. Ctrl+C restores
the terminal. Harnesses run through hcn; see [drivers](docs/drivers.md).

Records live in `~/.lucid2/records` by default. An explicit root wins over
`LUCID_ROOT`, then user configuration. [User defaults](docs/drivers.md#user-defaults-and-creation)
configure new hub conversations and the record root.
The older lucid installation's `~/.lucid` directory is separate.

## Working with a document

A conversation holds one artifact with immutable versions. In the browser,
use mode operates the document; markup mode selects places to discuss.
Click an element or drag over words, write notes, then send the queue as
one input. Command-click adds to a selection. Command+Enter adds a note
when the note box is open and sends the queue when it is closed.

You can attach files as context, rename the document, browse and compare
versions, and restore an older version as a new one. Saving your edits also
creates a version; it does not start a turn. The agent receives the saved
state on your next input. A new agent version does not replace unsaved work.

## Develop and verify

```sh
bun run check
bun run build
```

The first command runs lint, both TypeScript checks, and deterministic
tests. The build script also verifies the binary's bundled stylesheet.
Use the script, not a direct Bun compile command.

[Documentation](docs/README.md) separates current contracts, active design
work, and lasting decisions. [Smoke verification](docs/smoke-seven.md)
defines the live confirmation lanes. [AGENTS.md](AGENTS.md) contains the
repository's coding and verification rules.

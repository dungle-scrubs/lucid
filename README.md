# Lucid

Read your agent's work as a document, not a wall of markdown.

Your coding agent writes its answer as an HTML document instead of printing
markdown to your terminal: real headings, tables that look like tables, and
diagrams and wireframes built from elements you can point at. Lucid serves it
in a browser, where you mark up any element or phrase and your notes go back
carrying the thing you pointed at. When the agent revises, that same document
updates in place.

A terminal has one format for everything. A migration plan, a schema, an audit,
all of it arrives as the same monospace wall, with no hierarchy to skim and
nothing to select. By the third revision you are re-reading paragraphs you
already approved to find the two lines that changed, and somewhere in there you
stop absorbing any of it.

<!-- Proof slot: replace this block with docs/media/side-by-side.png - the same
     migration plan as terminal markdown on the left, as a Lucid artifact on
     the right. Caption: "The same plan, both ways." -->

```sh
# Ask your agent for a plan. It writes the document and opens it:
lucid open .lucid/plan.html
# You mark up step 3 in the browser. Your agent picks the note up here:
lucid wait .lucid/plan.html --since <cursor>
```

## Install

Requires [Bun](https://bun.sh) 1.3+. macOS and Linux.

```sh
bun install
bun run build     # -> dist/lucid, a self-contained binary
ln -s "$PWD/dist/lucid" ~/.local/bin/lucid
```

Then give your agent the skill. For Claude Code:

```sh
ln -s "$PWD/skills/lucid"        ~/.claude/skills/lucid
ln -s "$PWD/skills/lucid-design" ~/.claude/skills/lucid-design
```

Symlink rather than copy, so the skill can never describe a different version
than the binary you built. Other harnesses have their own skill directories, or
can read [`SKILL.md`](skills/lucid/SKILL.md) as a plain prompt.

## Use it

Ask your agent for a plan. It writes `<project>/.lucid/plan.html` and runs
`lucid open`, and the review appears. You never touch the CLI to review - but
these are yours if you want them:

```sh
lucid open plan.html    # serve + open the review
lucid end  plan.html    # close the session
lucid                   # list sessions in this project
```

### One window over every session

Rather than a browser tab per review, run the shell: one window, a tab per
artifact, a `⌘K` palette, `⌘1-9` to switch, `⌘W` to close.

```sh
lucid app               # start the hub (if needed) + open the shell as a Chrome app
lucid hub --attend      # or run the daemon yourself
```

While the hub runs, `lucid open` surfaces sessions as tabs in that one window
(`http://127.0.0.1:17428/`) instead of spawning per-session servers. Agents
notice nothing: `wait` / `ask` / `end` and the JSON payload are unchanged.

It finds artifacts by scanning the folders in `~/.lucid/roots.json` (`~/dev`
plus your agents' scratchpads by default). The projects drawer has a folder
button to add another; it reports how many reviews were already inside.

## The review record

Annotations, messages, versions, approvals and replies land in one append-only
log in `.lucid/<name>/`, beside the artifact they belong to. Nothing is
discarded when a turn ends, so a review suspends and resumes, and any agent can
pick up one someone else started.

That record lives in your project rather than a temp directory, which is why a
reboot, a cleared `/tmp` or a dead agent cannot take weeks of review with it.
It is committable: only the record's `run/` subdirectory is machine-local, and
its own `.gitignore` already excludes it. Commit the rest when a review should
travel between machines or people.

## Two modes

Which one you're in depends on whether that artifact's agent conversation is
**open in a terminal right now**. The panel names the mode under the composer.

**Interactive** - the conversation is open and someone is at it. Lucid records
your feedback and stays out of the way; the waiting agent picks it up through
`lucid wait`. The model and effort in use are shown, not offered: they belong to
the session that's already running.

**Spawn mode** - nothing is watching. Lucid resumes that artifact's own
conversation headlessly to apply your feedback, so a review answers itself while
you're elsewhere. Pick the model and effort for the next turn, and copy a resume
command if you'd rather take it over in a terminal. Requires `--attend` (which
`lucid app` sets) and a recorded session.

Two other states are honest about having nothing to spawn: **no agent session**
(hand-written or recovered artifact - feedback is saved for the next agent that
opens it) and **recording only** (a hub started without `--attend`).

Detection is live, not historical: copy the resume command into a terminal and
the mode follows you there.

## Harnesses

A harness is any agent CLI. Both modes above run on Claude Code, Codex or pi;
`docs/LAUNCHER.md` carries the model and effort flag mapping for each. The
whole integration surface is this CLI and a JSON payload, with no SDK and no
plugin, so anything that can run a subprocess and read JSON can drive a review.

Lucid needs a recipe for a harness only to *start* or *resume* turns itself.
Reviews work without any registry at all.

`~/.config/lucid/harnesses.json` (or `$LUCID_HARNESSES`):

```json
{
  "default": "claude_code",
  "harnesses": {
    "claude_code": {
      "spawn":  ["claude", "-p", "--session-id", "{id}", "{prompt}"],
      "resume": ["claude", "--resume", "{id}", "-p", "{prompt}"],
      "models": [{ "id": "opus", "label": "Opus 5" }],
      "defaultModel": "opus",
      "efforts": ["low", "medium", "high"]
    }
  }
}
```

`spawn` authors a new artifact; `resume` drives a turn on an existing one.
`models` and `efforts` become the pickers in the panel - without them, the
harness simply gets none. Absent file means the launcher is off.

`~/.lucid/settings.json` holds Lucid's own preferences:

```json
{ "resumeYolo": true }
```

`resumeYolo` (default true) adds the harness's skip-permissions flag to the
resume command offered for copying - you're re-entering a conversation about
your own artifact.

## How agents use it

```sh
lucid open plan.html                       # prints an opening cursor
lucid wait plan.html --since <cursor>      # blocks until feedback; JSON on stdout
lucid wait plan.html --since <cursor> --reply "reordered the steps"
lucid ask  plan.html --text "batch or nightly?" --ref step-backfill
```

The full protocol is [docs/CONTRACT.md](docs/CONTRACT.md); the vocabulary is
[CONTEXT.md](CONTEXT.md).

## Contributing

```sh
bun run build          # bundles + dist/lucid
bun run typecheck && bun run lint
bun test test/*.test.ts
bunx playwright install chromium && bunx playwright test
```

Working on the UI? `bun run dev` starts a hub that serves the client bundles
from disk, rebuilds on save and live-reloads every connected shell - no binary
rebuild, no restart. (Live reload, not HMR: component state resets.)

A running viewer serves the bundle its binary embedded at compile time, so after
client changes rebuild **and** restart it - green tests against a stale bundle
are not green.

Conventions for coding agents: [AGENTS.md](AGENTS.md). Guidelines:
[CONTRIBUTING.md](CONTRIBUTING.md). Design system: [docs/DESIGN.md](docs/DESIGN.md).

```
src/cli        entry + commands       client/chrome    review panel (React)
src/core       log, fold, wait, lock  client/overlay   in-artifact marks (Lit)
src/server     loopback daemon        client/shared    postMessage protocol
src/anchors    anchor resolution      skills/          agent skills
```

## Roadmap

- **Skills in the binary** - `lucid skills install`, so a skill can never
  describe a different version of the CLI than the one that wrote it.
- **Stale-binary guard** - a shell reloads itself when the hub it reconnects to
  reports a different bundle, but nothing notices that the *running* hub is
  older than the binary on disk. Restarting it is still discipline.
- **Draft persistence** - submitted messages survive an outage and a reload (the
  outbox), but queued annotations are still client memory: a reload before
  sending loses them, along with their anchors and staged images.
- **Per-session viewers follow their session** - the hub serves every session at
  a stable address, so a restart reconnects. Without a hub, `lucid open` binds a
  random port and a viewer on the old one strands.
- **Packaging** - prebuilt binaries and a published package.

## Thanks

Inspired by [lavish-axi](https://github.com/kunchenguid/lavish-axi) by
[@kunchenguid](https://github.com/kunchenguid): HTML is the format agents should
be writing when prose stops being enough, and the review belongs in a browser
rather than scrolling out of a terminal.

## License

[MIT](LICENSE), copyright Kevin Frilot.

Lucid inlines Lucide icon path data and compiles its dependencies into the
binary; those carry their own notices, reproduced in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

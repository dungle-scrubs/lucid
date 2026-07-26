# The fork launcher

`lucid launch <file>` is an opt-in process that turns **fork requests** into new
artifacts. When you select a region in a review and click **Fork**, Lucid records
a `fork` event (it never spawns anything itself). Something has to act on that
request; the launcher is the something.

It is the one Lucid component permitted to spawn agents - a deliberate,
human-initiated exception to D-064 (the review server still only appends to a
log). It stays agent-agnostic by running a **recipe the harness declares**, never
a launch command compiled into Lucid.

## The harness registry

The launcher needs to know how to start your harness headless. That lives in a
JSON file at `$LUCID_HARNESSES`, or `$XDG_CONFIG_HOME/lucid/harnesses.json`
(default `~/.config/lucid/harnesses.json`). Absent file = the launcher is off.

```jsonc
{
  "default": "claude_code",
  "harnesses": {
    "claude_code": {
      // CREATE turn: a fresh headless session authors the new artifact.
      "spawn": [
        "claude", "-p", "--session-id", "{id}", "{prompt}",
        "--allowedTools", "Bash(lucid *) Write Edit Read"
      ],
      // REVISE turn (shape-C liveness): re-drive the SAME session on feedback.
      // Omit it and a forked artifact is one-shot (created, not re-driven).
      "resume": [
        "claude", "--resume", "{id}", "-p", "{prompt}",
        "--allowedTools", "Bash(lucid *) Write Edit Read"
      ]
    }
  }
}
```

Model ids are the harness's OWN spelling, and a wrong one is only discoverable
by running it: `claude --model` takes `claude-opus-5` or the moving alias
`opus`, never a bare `opus-5`. Verify an id against the CLI before adding it
to a registry (`claude -p --model <id> "say ok"`); Lucid validates that a pick
is in your list, not that your list is real, and a bad id surfaces as the
CLI's own refusal in the create dialog.

`{prompt}` sits BEFORE `--allowedTools`: claude's tools flag is variadic
(`<tools...>`), so a trailing prompt gets swallowed as another tool name and
the turn dies with "input must be provided".

`spawn`/`resume` are argv arrays (no shell, no quoting). Placeholders, filled per
fork: `{id}` (new harness session id), `{seed}` (fork seed file), `{artifact}`
(the file the agent must write + `lucid open`), `{cwd}` (project root), `{prompt}`
(the instruction Lucid composes).

### Model and effort (optional, per harness)

A recipe may also declare the **models** it may run headless turns on and the
**effort/reasoning levels** those models accept. Lucid shows them as pickers
(create dialog, chat panel); a recipe that declares neither simply has no
pickers.

```jsonc
{
  "harnesses": {
    "claude-code": {
      "spawn": ["claude", "-p", "--session-id", "{id}", "{prompt}", "--allowedTools", "..."],
      "models": [
        { "id": "opus-5", "label": "Opus 5" },
        { "id": "opus-4.8" }
      ],
      "defaultModel": "opus-4.8",
      // Harness-wide ladder: applies to every model that declares none itself.
      "efforts": ["low", "medium", "high", "xhigh", "max"]
    },
    "codex": {
      "spawn": ["codex", "exec", "--sandbox", "workspace-write", "-C", "{cwd}", "{prompt}"],
      "models": [
        // codex's ladder is per model GENERATION - the API enforces the subset,
        // so each model carries its own.
        { "id": "gpt-5.6-sol", "efforts": ["medium", "high", "xhigh", "max", "ultra"] },
        { "id": "gpt-5.5", "efforts": ["minimal", "low", "medium", "high"] }
      ],
      "defaultModel": "gpt-5.6-sol"
    }
  }
}
```

- `models[].efforts` wins over the harness-wide `efforts` for that model.
- `defaultModel`/`defaultEffort` are what the pickers preselect. Both must be
  in the harness's own lists - the registry **fails to load** otherwise, with
  the file path in the error, rather than offering a pick the CLI will reject.
- These fields are optional and additive: a registry written before them keeps
  working unchanged.

**The flags Lucid composes**, per harness (nothing else is guessed at):

| harness | model | effort |
| --- | --- | --- |
| `claude-code` | `--model <id>` | `--effort <level>` |
| `codex` | `-c model="<id>"` | `-c model_reasoning_effort="<level>"` |
| `pi` | `--model <id>` | `--thinking <level>` |

A harness Lucid has no flags for cannot carry a selection. Declaring `models`,
`efforts`, `defaultModel`, or `defaultEffort` on one **fails the registry
load**, with the file path in the error: a picker whose every pick is refused
at spawn is worse than no picker.

**Where they are inserted:** right after `argv[0]` for `claude-code`/`pi`, and
after the last `exec` (or `exec resume`) subcommand tokens for `codex`. Never
appended - a trailing option lands inside claude's variadic `--allowedTools`
(see the warning above) and is read as another tool name. The index is read off
the argv TEMPLATE, before substitution, so a `{cwd}` or `{prompt}` holding the
literal `exec` cannot move it.

> **`argv[0]` must be the harness executable itself.** Insertion is positional,
> so a recipe fronted by a wrapper (`env FOO=1 claude ...`, `bunx ...`) puts the
> model/effort flags on the wrapper. Wrap with a shell script the recipe calls
> directly instead. `codex` behind `direnv exec . codex exec ...` is the one
> safe case - the scan takes the last `exec`.

**No pick means no flag.** "Default" is not a value Lucid synthesizes; it
passes nothing and the CLI's own configured default applies.

**The pick sticks to the artifact.** It is written to
`.lucid/<name>/selection.json` (`{ harness?, model?, effort? }`) by the create
dialog and by `POST {base}/__lucid/selection`, and every later unattended
resume reads it back. If the registry later stops offering that model or
level, the turn still runs - on the CLI's own defaults - and the viewer says
why (`SELECTION_INVALID`). A stalled delivery would be the worse failure.

### The allowlist is a security decision, not plumbing

A headless agent has no terminal, so it cannot answer permission prompts - it
runs under exactly the tools its recipe grants. Grant the **least** it needs
(`Bash(lucid *)`, `Write`, `Edit`, `Read`), not `--dangerously-skip-permissions`.
The recipe is where that posture is declared, once.

## What happens on a fork

1. The launcher polls the parent session's log for new `fork` events.
2. For each new fork it writes a **seed** (`<session>/forks/<id>/seed.md`) - the
   selected region, the directive, the source ref, any pasted images. A fork's
   whole context is the region + directive, so the seed is self-contained; the
   spawned agent inherits nothing from the parent process.
3. It resolves the recipe for the harness that attended the parent (from the
   attendant sidecar), or the registry `default`, and runs the `spawn` argv.
4. The agent authors the new artifact and runs `lucid open` - a new viewer on a
   new port, a new row in the Sessions panel. (If it doesn't open it, the
   launcher does.)
5. **Shape C:** the launcher then attends the child itself - holding the
   listening presence - and spawns a short-lived `resume` turn only when review
   feedback arrives. No idle agent process sits per artifact.

## Hand-off (single attendant)

If you'd rather drive a forked artifact interactively, attach your own harness to
it (e.g. `lucid wait <child> --harness claude_code --resume '<cmd>'`). The launcher
sees a non-launcher attendant appear and **yields** that child - one attendant at
a time, so annotations are never processed twice. The launcher keeps watching the
parent for new forks either way.

## Degradation

A harness with no recipe (and no `default`) has no headless spawn. The launcher
writes a `COMMAND.txt` next to the seed with the manual steps and moves on - the
fork is never silently dropped, it just waits for you.

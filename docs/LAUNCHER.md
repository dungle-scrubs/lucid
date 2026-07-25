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

`{prompt}` sits BEFORE `--allowedTools`: claude's tools flag is variadic
(`<tools...>`), so a trailing prompt gets swallowed as another tool name and
the turn dies with "input must be provided".

`spawn`/`resume` are argv arrays (no shell, no quoting). Placeholders, filled per
fork: `{id}` (new harness session id), `{seed}` (fork seed file), `{artifact}`
(the file the agent must write + `lucid open`), `{cwd}` (project root), `{prompt}`
(the instruction Lucid composes).

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

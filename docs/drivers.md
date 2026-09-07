# Drivers and harness selection

The server appends input and preferences. A driver runs the agent through
`HarnessRunner`: `openSession`, `streamTurn`, `inspect`, and `capabilities`.
Everything about harness invocation and decoding stays in [src/harness](../src/harness/index.ts).

## Profiles

| Profile | Ownership and delivery |
|---|---|
| `interactive` | A human owns the process. Hooks attach and inject at boundaries; lucid does not respawn it. |
| `headless-session` | lucid owns a persistent harness session. Queue inputs wait; supported steer and answer inputs can reach a running turn. |
| `headless-turn` | lucid starts one process per turn. Inputs queue; steer and answer are unsupported. |

For interactive sessions, the implemented ladder uses hooks when available
and otherwise observe-only delivery. The cooperative drop-file rung exists
but remains disabled by `A003_GATE_OPEN`. Do not present it as available.
Project-scope hooks must coexist with other project hooks. Nested smoke
sessions use project settings and unset `HERDR_ENV`. Hook delivery bounds
apply to UTF-8 bytes after JSON escaping; invoke commands as argument arrays.

## hcn boundary

lucid spawns `hcn --json`, consumes NDJSON, and keeps unknown event kinds.
It does not import hcn's normalizer or reconstruct descriptors above the
harness seam. hcn supervises one process; lucid owns conversation delivery
and its queue across processes. Capability claims retain their provenance:
`runtime-verified`, `curated`, or `unknown`. Unknown does not imply support.

Binary resolution happens once: `LUCID_HCN`, then the repository's
`node_modules/.bin/hcn`, then PATH. The chosen binary is logged. The exact
package pin, runtime version floor, and recorded fixtures move together;
see [AGENTS](../AGENTS.md).

## Preference and actual driver

New hub conversations save a complete selection in `driver.json`: version 1,
harness, concrete model, effort, profile, optional provider, and revision.
Settings are separate from the actual driver recorded in the log.

`POST /api/conversations/:id/driver` requires the browser token and
`expectedRevision`. It replaces the complete bundle and clears an omitted
provider. Stale revisions return 409 (E-HUB-02); incomplete or unsupported
choices return 400 (E-HUB-03). hcn inspection validates model aliases, effort,
provider, and session support before writing. Aliases resolve to concrete model
IDs. Saving uses the record lock and a synced atomic sidecar replacement.

Older partial preferences remain readable. Opening computes compatible
completion without writing: saved choice, compatible actual driver, then user
default. Explicit changes and accepted submissions save the completion. A
concurrent explicit update wins over legacy completion. Malformed saved fields
remain visible and block execution until repaired; they never become defaults.

The conversation projection keeps these separate:

- `driver`: what runs now, from the log.
- `driverPreference`: what the person chose, or null.
- `driverChoices`: model and effort vocabularies from hcn inspect, aliases
  resolved, plus extensibility and provider support. These may be cached
  for the server process. Do not create a second vocabulary registry.

A dimension the harness cannot express is absent from its controls. An
extensible model vocabulary permits free entry. Changing the browser
preference never changes a running interactive process or starts a driver.
The full settings editor can select an interactive profile for a human-owned
terminal session. A headless command refuses that selection rather than
starting a different mode.

## User defaults and creation

Read `$XDG_CONFIG_HOME/lucid/config.toml`. If XDG_CONFIG_HOME is unset,
empty, or relative, use `~/.config/lucid/config.toml`:

```toml
version = 1
records_dir = "~/.lucid2/records"

[defaults]
harness = "claude"
model = "opus"
effort = "high"
profile = "headless-turn"
```

These values are also the built-ins. A missing file uses them. Invalid TOML,
versions, keys, or choices are shown as errors. Paths are literal: only the
leading `~/` in records_dir expands. No shell or environment interpolation
runs. Explicit creation dimensions override user defaults, then built-ins.
A complete explicit bundle can bypass invalid defaults while the configuration
error remains visible. Defaults are reread for each new creation and never
rewrite an existing complete selection. Changing the root requires restart;
an explicit root or LUCID_ROOT continues to override the configured root.

`GET /api/defaults` returns selected defaults, inspection choices, configuration
errors, and whether a root change needs restart. `POST /api/conversations`
accepts a client creationId, absolute workingDirectory, and optional settings.
It returns the same conversationId for an identical retry, including after a
lost response or restart. The browser retains uncertain requests until retry
or explicit discard. Discard does not delete a conversation already created.
Creation and opening start no harness or model call. Automatic workers and
resume behavior remain later RFC 15 slices.

The working folder and repository project are saved separately. In a nested
repository the nearest repository owns the project; outside Git the folder
itself is the project. `POST /api/conversations/:id/location` repairs the
folder with expectedRevision. Location errors use E-HUB-04. Reads never guess
or rewrite missing folder metadata.

## Applying a preference

At startup, an explicit `--harness` or `LUCID_HARNESS` wins over the preference
and pins that dimension for the process lifetime. Preference wins over the
default on unpinned dimensions. Model, provider, and effort currently come
from preference or hcn defaults.

At the next queue-input boundary, compare unpinned dimensions and reopen
through the shared driven-conversation lifecycle if they changed. Never
interrupt a running turn for a preference. Steer and answer stay on the
current driver, including when idle. An interactive session never respawns.

A refused change keeps the current driver answering the input. Record a
nonterminal error naming the refused choice and the driver that continues.
Leave the preference intact so the browser can show why choice and reality
differ. Remember the refused preference and retry only after it changes,
not on every input.

## Session recall

The record keeps session IDs per harness, reported on identity events.
Attach returns only the session ID for the requested harness. Same-harness
reopen uses its own hint; switching harnesses never carries the other
harness's session ID across. A harness with no recorded session starts fresh
with the conversation replayed.

A hint may name a missing session. Try it once; if refused, retry the same
input fresh and record why. Input idempotence and event replay watermarks
remain separate from harness session recall.

See [honor tests](../test/modes/honor.test.ts),
[session prompts](../test/modes/session-prompts.test.ts),
[harness runner tests](../test/harness/hcn-runner.test.ts), and
[driver endpoint tests](../test/server/driver.test.ts).

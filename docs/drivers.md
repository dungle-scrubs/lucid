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

`driver.json` is the person's standing choice: version 1, a required harness,
and optional provider, model, and effort. The server replaces the whole file
atomically with mode 0600. It is not an event, and it travels with the record.
The driver reads it but never rewrites it to describe what actually spawned.
An absent preference uses the driver's normal defaults.

`POST /api/conversations/:id/driver` requires the browser token. It replaces
the bundle; omitted optional fields are cleared. It accepts harnesses
`claude`, `codex`, `pi`, and `muse`. Optional fields must be nonempty strings
of at most 128 characters without controls. Unknown fields, including `mode`
and `profile`, are refused. Malformed JSON, harness, field, and unknown-field
failures return 400 with their named issue. Validation checks shape; hcn
judges model and effort membership at spawn.

The conversation projection keeps these separate:

- `driver`: what runs now, from the log.
- `driverPreference`: what the person chose, or null.
- `driverChoices`: model and effort vocabularies from hcn inspect, aliases
  resolved, plus extensibility and provider support. These may be cached
  for the server process. Do not create a second vocabulary registry.

A dimension the harness cannot express is absent from its controls. An
extensible model vocabulary permits free entry. Changing the browser
preference never changes the interactive profile or starts a driver.

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

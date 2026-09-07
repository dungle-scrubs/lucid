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

A refused change stops the driver and leaves the input pending. Record the
failure and preserve the selected settings. Never reopen the previous driver
or start a fresh session automatically after a refusal.

## Session recall

The record keeps session IDs per harness, reported on identity events.
Attach returns only the session ID for the requested harness. Same-harness
reopen uses its own hint; switching harnesses never carries the other
harness's session ID across. A harness with no recorded session starts fresh
with outstanding inputs replayed. Transfer of completed history is a separate
RFC 15 implementation slice.

Every later headless turn resumes the latest native identity for its harness.
Each launch uses the exact saved working folder. A missing folder blocks
execution. A refused resume leaves the input and settings pending for recovery.
Input idempotence and event replay watermarks remain separate from native recall.

Named interactive sources record their native identity with the producing
epoch, turn, and corroborated process owner. The latest participation survives
detach even if no identity arrived. A living terminal remains protected after
detach or lease expiry. Unknown ownership blocks takeover. Once departure is
confirmed and an executor lease is held, its captured session can continue in
headless-turn mode with a recorded mode-change notice. The worker records its
own process identity on attachment.

See [honor tests](../test/modes/honor.test.ts),
[session prompts](../test/modes/session-prompts.test.ts),
[harness runner tests](../test/harness/hcn-runner.test.ts), and
[driver endpoint tests](../test/server/driver.test.ts).

## Recorded context preparation

The context projection quotes accepted messages, recorded tool results,
questions, partial replies, and failures with their record IDs and source
provenance. Current artifact versions remain mandatory material. The pending
accepted prompt stays separate from historical requests. Protocol identity
envelopes and record credentials do not enter the projection. Arbitrary
sensitive text already written in conversation content is not scrubbed.
Quoted inputs retain their delivery status; quoting outstanding work does
not execute it. Partial token fragments are marked as possibly containing
gaps, and interrupted turns retain that status. Unclassified event content,
including an unsupported payload shape for a known kind, holds preparation
until an upgraded projector can read it. Attachment references encoded in
input text remain quoted with that input; unreferenced uploaded blobs do not
become conversation context. The projected offer copies files referenced by
human annotation inputs and supplies a manifest keyed to input, note, and
blob identity. Historical paths remain quoted data; the manifest names current
copies or explicitly reports a missing file. Different blobs with the same
filename retain separate copies. The offered text is also returned for budget
accounting before dispatch.

An offered copy lives in a private temporary directory outside the record.
`lucid2 context <offered-directory> [--offset BYTE] [--bytes COUNT] [--json]`
reads that copy directly, without HTTP or record access. Each read returns at
most 65,536 bytes on UTF-8 boundaries, with nextOffset and done. Keep the copy
for the active execution and remove it when that execution closes.
Use its attachmentsDir with the existing attachment delivery operation so
both copies share one lifetime. Copies carry process provenance in their
directory name. The next preparation reaps copies whose owner has departed;
live owners and unknown ownership are retained. This also covers a crash
before the attempt's first durable write.
Failure to remove an unrelated orphan emits a cleanup warning and does not
block preparation of this conversation.

The store records offered and confirmed context per actual native session
and supplying turn. Managed offers retain their input and attempt identity;
other turns require no synthetic input. A durable successful terminal event
can confirm the offer. Merely offering context does not advance coverage.
Confirmation includes the turn's own output, stopping at concurrent input
or another turn's events that the captured context did not supply. Repeated
confirmation is idempotent and survives reopening the record.
The reducer derives these limits from compressed input/turn ranges, so
replay enforces the same gap check as the live writer. Native identity and
terminal evidence are retained by supplying turn, independent of the most
recent session for that harness.
Context entries have their own envelope source, so a reader without this
extension can carry them. A confirmation names the harness, actual native
session, source range, supplying turn, managed attempt when applicable, and
successful terminal evidence. Recovery can confirm a completed managed turn
from its pre-dispatch attempt snapshot even if it lost the later offer write.

After executor takeover, `reconcileExecution` settles an abandoned attempt
under the append lock. A recorded successful terminal settles the attempt;
an unsuccessful terminal preserves partial output as a failed attempt. No
terminal evidence means uncertain, including loss before process creation.
Recovery never appends another copy of the input or dispatches it again.
An exact repeated settlement is a no-op, and stale attempts are refused.

An attempt covers one harness turn. Successful termination includes hcn's
`awaiting-input` result: the asking turn completed, while its question stays
in the transcript. This does not claim that the person's whole task is
finished. Their answer is a new input that continues the conversation; it
does not require repeating the already acknowledged asking turn.

These preparation APIs do not yet enable managed dispatch. RFC 15 still
requires verified hcn budgets, bounded summarization, and worker integration.

Both headless profiles accept a pre-dispatch preparation callback. It supplies
the complete, accounted prompt, including protocol teaching and current
artifact bytes. The host appends nothing afterward. A held input keeps its
queued disposition and permits later eligible work. Persistent processes
start only after the first ready input, including an initial steer. Saved
driver changes still apply after held preparation. A refused prepared send
ends the source with a startup failure and preserves the input; it never
silently opens a fresh session. Store failures retain their own classification.
The stall watch starts when prepared work reaches the harness, not while
context is held. A persistent turn crosses its boundary once, at its terminal
event, even when its stream closes after the next send.
The callback receives an abort signal for source shutdown and must bound its
own preparation operations. Mid-turn legacy steers and answers retain their
existing delivery path; they are not prepared queued dispatches.

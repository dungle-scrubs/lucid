---
number: 35
title: "Pi native settings and extension loading for bound continuation"
type: protocol
status: Draft
author: "Claude Opus 5.5"
date: 2026-09-27
version: 1
---

# RFC-35: Pi native settings and extension loading for bound continuation

## Abstract

RFC 28 makes a Pi session bindable and defines how a headless resume of it
proves which session Pi opened. It assumed that Lucid can already resume a
bound Pi session. It cannot. Lucid's bound continuation asks hcn for the
session's native settings and a fingerprint (RFC 27), and hcn answers
`unsupported-harness` for Pi, so Lucid holds every Pi note before a prompt
is sent. RFC 28 also passes its extension as native passthrough, which
hcn refuses beside a settings fingerprint. This RFC adds a Pi
native-settings source to hcn, a first-class hcn option that loads a Pi
extension, and an hcn-owned field that tells Lucid which continuation
transport a snapshot needs. Lucid then resumes a bound Pi session with a
fingerprint and no approval channel.

## Introduction

RFC 26 requires that a headless continuation preserve the native session's
settings. RFC 27 implemented that for Codex: `hcn inspect codex
--native-settings` reads the session record and returns a snapshot with a
fingerprint; `hcn run` rechecks the fingerprint before spawn; Codex runs
through an app-server approval channel. RFC 27 states that other interfaces
keep their acceptance requirements and hold feedback until they have a
lane.

Lucid's preparation (`src/modes/managed-preparation.ts`) applies RFC 27 to
every bound record. It calls `inspectNativeContinuation`, holds with
`E-HUB-03` when the result is unavailable, and treats any fingerprint as
the Codex approval transport (`src/modes/managed-execution.ts`). For Pi
the call returns `unsupported-harness`. RFC 28's headless role therefore
never runs.

The person using this is the reader who annotates an agent's artifact
(`CONTEXT.md`); for a Pi author, the notes go to the author's own
Pi session after the TUI closes (RFC 28). This RFC holds the scope RFC 26
already accepted. It adds no new user-visible capability.

Out of scope: Claude Code's native-settings lane (a separate acceptance
item under RFC 26), approval channels for Pi (Pi has none), and changes to
Pi.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD
NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted
as described in RFC 2119.

- **Settings snapshot**: hcn's `NativeSettingsSnapshot`: provider, model,
  effort, folder, session ID, source, fingerprint.
- **Continuation transport**: how hcn runs a fingerprinted resume.
  `native-approvals` is Codex's app-server channel (RFC 27). `resume` is an
  ordinary one-turn resume with no approval channel.
- **Flagless resume**: `pi --session-id <id> -p --mode json` with no
  provider, model, or thinking flag, so Pi restores its own settings.

## Evidence

Pi 0.87.1, hcn 0.7.4, 2026-09-27. Provider: a closed local port with two
models marked reasoning-capable. An extension logged `ctx.model`,
`pi.getThinkingLevel()`, and the session's entry types at `session_start`.

| Probe | Observation |
|---|---|
| S1 | `hcn inspect pi --native-settings --resume <id> --cwd <dir> --json` returns `{"reason":"unsupported-harness","status":"unavailable"}`. Claude returns the same. |
| S2 | A session created with `--provider dead --model none --thinking high` records `model_change` (`dead/none`) and `thinking_level_change` (`high`). A flagless resume starts with `dead/none`, `high`. |
| S3 | A resume with `--model dead/other` runs `dead/other` and records no `model_change`. The next flagless resume starts with `dead/other`, taken from the assistant messages that run wrote. |
| S4 | A resume with `--thinking low` runs `low` and records nothing; the next flagless resume starts with `high` again, from the latest `thinking_level_change`. |
| S8 | Pi source, `getSessionContextSettings` in `dist/core/session-manager.js`: Pi walks the current leaf path (`buildSessionPath`: from the selected leaf, else the last entry, through `parentId`). Along it, each `model_change` and each assistant message (`provider`, `model`) replaces the model; each `thinking_level_change` replaces the thinking level, which starts at `off`. |
| S5 | `hcn run pi --resume <id>` with no selectors spawns `pi --session-id <id> -p --mode json`: no profile default is added. A fresh `hcn run pi` adds `--thinking medium`. |
| S6 | hcn's fingerprint admission (`verifyNativeSettings`, `renderVerifiedNativeSettings`) is Codex-only and refuses passthrough, so RFC 28's `-- -e <path>` cannot combine with it. |
| S7 | Pi docs (`security.md`): print and JSON modes cannot prompt for project trust. They apply a command-line override, then an extension's decision, then a saved decision, and otherwise skip trust-gated project resources unless `defaultProjectTrust` is `always`. |

## Protocol Overview

### hcn: Pi settings source

1. `NATIVE_SETTINGS_SOURCES.pi` becomes `pi-session-v1`.
2. `hcn inspect pi --native-settings --resume <id> --cwd <dir> --json`
   resolves the session file through the Pi store root (hcn 0.7.4: the
   session folder, else the agent folder's per-folder directory) and reads
   it with the same bounds as the Codex source: a regular file of at most
   64 MiB, lines of at most 1 MiB, UTF-8, and a file identity (device,
   inode, size, modification and change times) that must not change
   during the read.
3. The first entry MUST be the session header, whose `id` equals the
   requested ID and whose `cwd` resolves to the requested folder;
   otherwise `session-unavailable` or `cwd-refused`.
4. The snapshot applies Pi's own restoration rule (S8):
   - the path runs from the last entry through `parentId` links to the
     header, as `buildSessionPath` does when no leaf is selected; a
     missing parent is `settings-unavailable`;
   - provider and model: the last `model_change` or assistant message on
     that path, whichever comes later;
   - effort: the last `thinking_level_change` on that path, else `off`;
   - no model on the path: `settings-unavailable`.
5. The fingerprint is SHA-256 over the source, harness, session ID,
   requested folder, file identity, the IDs of the entries that set the
   model and the effort, provider, model, and effort. Lucid treats it as opaque.
6. The snapshot carries `continuation: "resume"`. Codex snapshots carry
   `continuation: "native-approvals"`. The field is additive; a snapshot
   without it is a Codex snapshot from an older hcn.

### hcn: fingerprinted Pi resume

7. `hcn run pi --json --resume <id> --cwd <dir>
   --native-settings-fingerprint <hash>` re-inspects before spawn,
   refuses with `native-settings-changed` on a different fingerprint, and
   spawns a flagless resume. It passes no provider, model, or thinking
   flag: Pi restores the same values the snapshot read, by its own rule.
   It keeps the existing refusal of caller model, effort, and provider
   selectors and of native passthrough.
8. `--extension <path>` is a new run option. The Pi descriptor renders it
   as `-e <path>`; other harnesses refuse it before spawn. The path MUST
   be absolute and name a regular file. It is not a settings selector, so
   it is allowed beside a fingerprint. It loads even when discovery is off
   (Pi `-e` semantics, RFC 28 step 7).

### Lucid

9. Preparation keeps its current order: inspect, hold when unavailable,
   record the snapshot's provider, model, and effort as the driver.
10. The snapshot's `continuation` selects the transport. `native-approvals`
    (or absent) keeps RFC 27's approval stream. `resume` runs an ordinary
    one-turn resume with `--native-settings-fingerprint`, `--cwd`, and no
    approval channel.
11. For a `pi-cli` binding, the run also carries RFC 28's verification:
    `--extension <path>` and the four `LUCID_PI_*` variables in the hcn
    process environment. RFC 28's outcome table classifies the result.

### Project trust

The headless resume passes no trust override. Pi applies the saved
decision for the folder, or skips trust-gated project resources (S7). A
session whose person granted trust for that TUI process only continues
with fewer project resources, never more. Lucid does not widen trust on
the person's behalf.

## Message Formats

Snapshot addition (hcn `NativeSettingsSnapshot`):

```json
{"v":1,"status":"available","harness":"pi","source":"pi-session-v1","sessionId":"<id>","cwd":"/abs","provider":"zai","model":"glm-5.3","effort":"high","fingerprint":"<64 hex>","continuation":"resume"}
```

Pi snapshots omit `permissions`: Pi records no approval policy. Lucid MUST
NOT read an absent `permissions` as a grant.

New run option: `--extension <path>`, repeatable, absolute paths only.

Lucid `StreamTurnOptions` gains `nativeSettingsFingerprint?: string` for
the `resume` transport, and RFC 28's `native.args` becomes
`native.extensions: readonly string[]`, rendered as `--extension`.

## State Machine

No new durable state. A bound Pi attempt moves through RFC 26's existing
states: `prepared` after the snapshot is recorded, then `held` on an
unavailable snapshot or a pre-start refusal, or `started`, followed by
RFC 28's outcome classification at settlement.

## Error Handling

| Condition | Behavior |
|---|---|
| Session file changed between inspect and run | hcn `native-settings-changed`, before spawn; Lucid records a pre-start refusal and holds the note. |
| No assistant message and no `model_change` | `settings-unavailable`; Lucid holds with `E-HUB-03`. |
| Header ID or folder differs | `session-unavailable` or `cwd-refused`; held. |
| `--extension` on a harness other than Pi | Refused before spawn. |
| `--extension` path missing or not a regular file | Refused before spawn: `invalid-option-value`. |
| `continuation` value Lucid does not know | Held with `E-HUB-03`; never mapped to a transport by guess. |

## Amendments to RFC 28

1. Step 7 passes the extension with hcn `--extension <path>`, not native
   passthrough, and adds `--native-settings-fingerprint`.
2. Security: the nonce leaves every tool's environment (R8), but a
   same-user process can read another process's initial environment
   (`ps -E`). The nonce is defense in depth. The proofs rest on the
   stream: a refusal needs exit 3 and no agent events, which a run that
   reached the model cannot produce, and a refused session never lets the
   model run to forge a `verified` file.

## Security Considerations

- The Pi source reads session metadata and the provider and model fields
  of assistant messages. It never returns message content.
- A flagless resume cannot widen settings: Pi restores what the session
  recorded, and the fingerprint proves the file did not change after
  inspection.
- Project trust can only narrow (Project trust).
- `--extension` accepts only an absolute regular file chosen by the
  caller; Lucid passes only the file it wrote (RFC 28).

## Versioning

`pi-session-v1` is a new source value; `continuation` and `--extension`
are additive. An older hcn answers `unsupported-harness` for Pi, and
Lucid keeps holding, which is safe. An older hcn omits `continuation` on
Codex snapshots, which Lucid reads as `native-approvals`. Lucid moves its
hcn pin deliberately with re-captured fixtures.

## Implementation Notes

1. hcn: Pi source parser (pure, `src/interpretation`), store-rooted read
   (`src/execution/native-settings.ts`), `continuation` field, Pi branch in
   `verifyNativeSettings` and argv rendering (flagless), `--extension`
   option with descriptor data. Tests with recorded-shape session files;
   a live check against Pi with the dead provider.
2. hcn release; Lucid pin bump with re-captured fixtures.
3. Lucid: parse `continuation`; `resume` transport in preparation and
   execution; `native.extensions`. Fake-hcn tests for both transports.
4. Lucid: RFC 28's `scripts/smoke-pi-resume.ts` runs through the real
   path.

## Alternatives Considered

- **Restore settings with explicit flags.** hcn would pass the snapshot's
  provider, model, and thinking level. Rejected: if hcn's reading ever
  differs from Pi's rule, explicit flags would change the session's
  settings. A flagless resume lets Pi apply its own rule; the fingerprint
  still detects any change.
- **Resume Pi without a fingerprint.** Rejected: RFC 26 and RFC 27 require
  settings evidence before a bound continuation, and the fingerprint is
  what detects a session changed between preparation and spawn.
- **Allow passthrough beside a fingerprint.** Rejected: passthrough can
  carry any selector and would defeat the fingerprint's purpose.
- **Lucid decides the transport by harness name.** Rejected: ADR 0005
  keeps harness differences in hcn.

## Open Questions

None.

## References

Normative:

- [RFC 26](26_interactive-artifact-conversation-continuity.rfc.md): continuity and settings preservation.
- [RFC 27](27_native-approvals-during-headless-continuation.rfc.md): native settings fingerprint and the Codex approval transport.
- [RFC 28](28_pi-native-extension-bridge-and-strict-session-locators.rfc.md): Pi extension bridge and verified resume.
- [ADR 0005](../adr/0005-hcn-owns-harness-differences.md): hcn owns harness differences.

Informative:

- Pi docs `sessions.md`, `security.md`, `cli.md` (Pi 0.87.1).

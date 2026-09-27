---
number: 28
title: "Pi native extension bridge and verified headless resume"
type: protocol
status: Draft
author: "Claude Opus 5.5"
date: 2026-09-27
version: 3
---

# RFC-28: Pi native extension bridge and verified headless resume

## Abstract

An interactive Pi session can publish a Lucid artifact, but browser notes
cannot reach it, and Lucid cannot resume it headlessly after it closes.
RFC 34 now answers those notes from a new headless session. This RFC
connects the Pi session itself. A Lucid extension for Pi registers the
interactive session, commits the session's Lucid commands from Pi's
`tool_result` callback, and delivers each note into the live session while
Pi is idle. After the interactive session closes, Lucid resumes the same
session headlessly through hcn. The same extension, loaded into that
headless run, checks the session that Pi opened and stops the run before
any model call if Pi opened a different or a new session. That closes the
lookup/open race that blocked v2, without a change to Pi.

## Introduction

RFC 26 defines native continuity: the session that published an artifact
receives its browser notes, and after that session closes, Lucid resumes
the same session headlessly. Claude Code and Codex CLI have this through
their hooks. Pi has none of it. A Pi session that publishes gets RFC 34's
fallback: a new headless session answers, without the original
conversation.

v2 of this RFC was parked on two problems. The v1 review (F1-F8) found the
protocol underspecified. A native probe showed a race: Pi's
`--session-id <id>` creates a new session when the session file disappears
between hcn's check and Pi's open, so a headless resume could silently run
in an empty session under the old ID.

v3 is a redesign built on native probes run on 2026-09-27 (Evidence
below):

- The race is closed by verification after open, inside Pi, before the
  model. Proven end to end through hcn with fault injection.
- Pi's extension context reports the run mode, and only the interactive
  terminal reports `tui`. Proven for TUI, RPC, JSON, and terminal-less
  print runs.
- Pi's `agent_settled` event is the end of a run; `agent_end` fires once
  per automatic retry. An extension can inject a user message while Pi is
  idle, with no blocking wait.

The design reuses the Claude Code adapter's proven shape instead of the
v2 extension tool and 45-second in-handler wait. That removes v2's session
file locator and its payload version 4.

The person using this is the reader who annotates agent-authored artifacts
(`CONTEXT.md`). Lucid routes a live agent conversation into a durable
record and back to that reader. For a Pi author, this RFC makes the notes
reach the author's own session. It holds the scope RFC 26 accepted for
native interfaces.

Out of scope, with reasons:

- Sessions stored outside Pi's default store (`--session-dir`, a custom
  `sessionDir` setting). Only default-store sessions become eligible for
  headless resume. Others stay held. This removes v2's locator.
- SDK-embedded Pi and RPC clients. They never report `tui`, so they never
  register. RFC 34's fallback still covers their publications.
- Interactive reconnect (reopening the Pi TUI through Lucid). RFC 26's
  protected reconnect stays Codex-only.
- Transcript import. RFC 26 ruled it out.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD
NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted
as described in RFC 2119.

- **Lucid Pi extension**: a TypeScript extension that ships in the Lucid
  npm package and loads into Pi. One file serves the interactive and the
  headless role; `ctx.mode` selects the role.
- **Pi hook helper**: `lucid _pi-hook <event>`, a short-lived child process
  that the extension starts for one event. It reads one bounded JSON
  capture on stdin and writes one bounded JSON result on stdout.
- **Capture**: what the extension reads from its own callback context:
  mode, session ID, session file, working folder, and for `tool_result` the
  tool call ID and command text.
- **Verify-after-open**: the headless-role check. Pi opens a session; the
  extension compares it with the expected session before the prompt
  reaches the model.
- **Idle injection**: the extension calls `pi.sendUserMessage` while
  `ctx.isIdle()` is true.

## Evidence

Pi 0.87.1, hcn 0.7.3, 2026-09-27. Provider: a closed local port, so a
model call appears as `Connection error.` and no traffic leaves the
machine. Implementation slice 3 turns P1 into a repeatable live script
(`scripts/smoke-pi-resume.ts`).

| Probe | Observation |
|---|---|
| E1 | Extensions load in `-p --mode json` (`ctx.mode: "json"`). Order: `session_start`, `input` (`source: "interactive"`), `before_agent_start`. |
| E3 | Resume of an existing session with the expected ID: allowed; model reached. |
| E4, E7 | Missing session file: Pi creates a new session with the same ID, 2 entries, 0 message entries. Extension refuses; 0 model calls; exit 3; no session file written. |
| E6 | Opened session ID differs from expected: refused; 0 model calls. |
| P1 | The real race through `hcn run pi --resume`: hcn's guard passes, a shim moves the file aside, Pi creates a new session. Refused; 0 model calls. hcn reports `class: "native"`, `nativeExitCode: 3`, and the extension's marker in `message`. Control run without the shim reached the model. |
| P2 | TUI (Herdr pane): `mode: "tui"`. RPC: `mode: "rpc"`, `hasUI: true`. |
| P3 | TUI: a timer 1.5 s after `session_start` saw `isIdle: true`, called `sendUserMessage(text, {deliverAs: "followUp", expandPromptTemplates: false})`; Pi recorded `input` with `source: "extension"` and ran. Retries: 4 `agent_end`, 1 `agent_settled`. `ctx.shutdown()` in `agent_settled` exited Pi. |
| P4 | No terminal and no `-p`: `mode: "print"`. A Pi started from another agent's Bash tool cannot report `tui`. |

hcn defect found during P1: the Pi descriptor's store template is
`{home}/.pi/sessions/{cwdSlug}` (`src/knowledge/pi.ts`), but Pi stores
sessions under `<PI_CODING_AGENT_DIR or ~/.pi/agent>/sessions`. The resume
guard therefore refuses valid resumes unless the agent folder is exactly
`~/.pi`. `src/cli/store-root.ts` already resolves the correct folder.

## Protocol Overview

### Roles by mode

The extension reads `ctx.mode` in `session_start`:

| Mode | Role |
|---|---|
| `tui` | Interactive: registration, command commits, idle injection. |
| `json` or `print`, with `LUCID_PI_EXPECTED_SESSION` set | Headless resume: verify-after-open only. |
| `json` or `print` without it, `rpc`, anything else | None. The extension does nothing. |

Three independent proofs compose; none substitutes for another (v1 F5):

1. The kernel identity of the helper's direct parent proves which process
   started the helper.
2. `ctx.mode === "tui"`, read in the extension callback, proves the role.
3. Registration generation, offer ID, and epoch prove the specific work,
   as in RFC 26.

A parent match alone MUST NOT be treated as role proof.

### Interactive role

1. **Register.** On `session_start` in `tui` mode, the extension starts
   `lucid _pi-hook session-start` with the capture. The helper reads its
   direct parent's identity (PID, start time, executable) with
   `readProcessOwner(process.ppid)`, requires the executable to be the Pi
   entry point's interpreter, and calls `registerNativeSession` with
   interface `pi-cli`, harness `pi`, the captured session ID, and the
   captured working folder. The owner is the Pi process. A `session_start`
   with reason `new`, `resume`, or `fork` replaces the registration with a
   new generation. `session_shutdown` runs `lucid _pi-hook
   session-shutdown`, which removes it.
2. **Propose from Bash.** The model runs ordinary Lucid commands in Pi's
   Bash tool: `lucid artifact publish`, `lucid connection resume-listen`,
   `receipt`, `respond`. As for Claude Code, a command run inside Pi only
   proposes. It finds the registration by `PI_SESSION_ID` (a locator that
   proves nothing), saves a proposal with a nonce, and prints a marker
   line. It changes no record.
3. **Commit from `tool_result`.** The extension's `tool_result` handler for
   the Bash tool starts `lucid _pi-hook tool-result` with the capture and
   the tool output. The helper finds proposal markers in the output,
   checks parent identity and role, and commits each proposal through the
   same host operations the Claude PostToolUse hook uses. A command run
   by a Pi subagent process, an RPC client, or a background job has no
   `tui` parent callback, so its proposal is never committed.
4. **Listen at `agent_settled`.** When listening is requested for a bound
   record, the extension starts `lucid _pi-hook settled` at
   `agent_settled` and does not await it. The helper runs
   `listenAtNativeStop` with RFC 26's 45-second bound. If it returns an
   offer, the helper prints the offer instruction and exits.
5. **Inject when idle.** On the helper's result, the extension calls
   `pi.sendUserMessage(offer, {deliverAs: "followUp",
   expandPromptTemplates: false})` if `ctx.isIdle()`. If Pi is busy
   because the person typed, the extension still delivers with `followUp`,
   so Pi queues the offer after the current run. Transport is not receipt:
   the model records receipt with `lucid connection receipt` before work
   and the outcome with `respond` after, both committed in step 3.
6. **Cancel.** Person input (`input` with `source: "interactive"`) while a
   helper waits, `session_shutdown`, or session replacement kills the
   waiting helper (SIGTERM, then SIGKILL after 2 s) and awaits its exit.
   A helper killed before it recorded an offer leaves the input saved. A
   helper killed after it recorded `offer-started` leaves the offer
   delivery-uncertain, as RFC 26 defines; a later `agent_settled` MUST NOT
   replay it.

### Headless role (verify-after-open)

7. On confirmed interactive departure (RFC 26 section 6), Lucid resumes
   through hcn with the stored session ID and folder, and passes the
   extension explicitly: `hcn run pi --resume <id> ... -- -e <extension
   path>`, with environment `LUCID_PI_EXPECTED_SESSION=<id>`. `-e` loads
   the extension even when hcn disables discovery (`-ne`).
8. In `session_start`, the extension compares
   `sessionManager.getSessionId()` and `getHeader().id` with the expected
   ID, and counts entries of type `message`.
   - Both IDs equal the expected ID and at least one message exists:
     allow.
   - An ID differs: refuse with `session-id-mismatch`.
   - No message entries: refuse with `session-empty`. A new session has 2
     non-message entries (`model_change`, `thinking_level_change`), so
     "no entries" is the wrong test.
9. On refusal, the extension writes one marker line to stderr, sets exit
   code 3, and its `input` handler returns `{action: "handled"}`, so the
   prompt never reaches the model. Pi writes no session file for a
   session with no content (E7).

## Message Formats

Helper stdin, one UTF-8 JSON object, at most 64 KiB; a larger input is
refused before parsing:

```json
{
  "v": 1,
  "event": "session-start | session-shutdown | tool-result | settled",
  "mode": "tui",
  "nativeSessionId": "<id>",
  "sessionFile": "/abs/path.jsonl",
  "workingDirectory": "/abs/folder",
  "toolCallId": "<id, tool-result only>",
  "output": "<Bash tool output, tool-result only, at most 48 KiB>"
}
```

The helper refuses unknown `event` values, unknown fields, and any `mode`
other than `tui`. IDs and paths use RFC 26's validators.

Helper stdout, one JSON object: the existing `NativeListenerResult` for
`settled`, the existing registration and proposal results for the other
events. A missing, malformed, or truncated result is unconfirmed; the
extension reads current state and does not repeat the operation.

Refusal marker (headless role), one stderr line:

```
lucid-pi-session: {"v":1,"refused":"session-empty","expected":"<id>","opened":"<id>"}
```

hcn maps a Pi exit code 3 whose stderr contains exactly one such line to a
new failure class `session-substituted`, `retryable: false`, carrying the
parsed fields. Other output keeps the existing `native` class.

Per-operation mapping (v1 F4). Each Pi operation is the RFC 26 CLI command
itself, run in Pi's Bash tool; only the commit point differs:

| Operation | RFC 26 command | Validators | Commit point |
|---|---|---|---|
| publish | `lucid artifact publish --request FILE` | existing publication validators | `tool_result` helper, as Claude PostToolUse |
| resume-listen | `lucid connection resume-listen ID` | existing | same |
| receipt | `lucid connection receipt ID --offer O` | existing offer/epoch checks | same |
| respond | `lucid connection respond ID --offer O --request FILE` | existing | same |

Lock order is unchanged: registration lock before record append lock.
Repeats use the existing exact offer and result identities.

## State Machine

Integration states; the durable host keeps authority.

- `none -> registered`: `session_start` in `tui` mode, helper accepted.
- `registered -> waiting`: `agent_settled` with a listen request for a
  bound record; helper started.
- `waiting -> offered`: the helper recorded `offer-started` and returned
  the instruction; the extension delivered it.
- `waiting -> registered`: 45-second expiry, person input, or helper
  failure before an offer. Input stays saved.
- `offered -> registered`: receipt and outcome recorded; continuation
  follows RFC 26.
- any state `-> none`: `session_shutdown` or replacement; waiting helper
  killed and awaited first.

Headless role: `opened -> allowed` or `opened -> refused`; no other
states.

## Error Handling

| Condition | Behavior |
|---|---|
| Helper parent is not a Pi interpreter process | Refuse registration: `native-context-unverified`. |
| `mode` is not `tui` in an interactive-role event | The extension does not start a helper. |
| Helper input over 64 KiB or malformed | Refuse before parsing or mutation. |
| Helper result lost | Read current state; do not repeat. Offers follow RFC 26 uncertainty rules. |
| `session-substituted` from hcn | Lucid records a proven pre-model refusal for the attempt (Amendment 1 below) and holds the input with reason `native-session-missing`. No retry, no fresh session. |
| Session outside Pi's default store | hcn's guard refuses before spawn; input stays held. |
| Extension missing at resume time | Lucid refuses the Pi continuation before invoking hcn: `native-extension-unavailable`. |

No error authorizes a fresh session, a different model, or a fallback to
the ordinary managed driver for a bound record.

## Amendments to RFC 26

1. RFC 26 accepts as proven pre-start refusal only hcn
   `spawn-not-attempted` and Lucid `dispatch-not-called`. This RFC adds
   hcn `session-substituted` for the Pi lane: the process started, but the
   extension stopped it before the prompt reached the model, and Pi wrote
   no session file. It counts as a pre-model refusal. It is not evidence
   that the original session is gone; the input stays held.
2. RFC 26 section 5 lists Pi CLI integration as pending native acceptance.
   This RFC is that acceptance contract for `pi-cli`.

## Security Considerations

- Same-user native code is outside the boundary, as in RFC 26: an
  installed Pi extension already has the user's authority. This RFC does
  not claim that a malicious same-user process cannot impersonate the
  extension.
- A model cannot nominate an owner. Bash commands only propose; commits
  need the parent callback in `tui` mode. `PI_SESSION_ID` locates a
  registration and proves nothing.
- Helper input is bounded and closed. The capture never travels in tool
  parameters, artifacts, or browser requests.
- The verify-after-open check reads session metadata only. It never reads
  or copies history.
- Session file paths are private record metadata.

## Versioning

No new execution payload version. `pi-cli` bindings use the existing
`bound` fact; no locator is stored. The helper protocol has `v: 1`;
unsupported versions refuse. The extension and Lucid ship in one package,
so they share one version. hcn's `session-substituted` class is additive;
an older hcn reports `native`, which Lucid treats as an uncertain outcome
and holds, which is safe. The Lucid hcn pin moves deliberately with
re-captured fixtures.

## Implementation Notes

Each slice has an observable outcome before the next depends on it.

1. **hcn: store root.** The Pi resume guard uses `store-root.ts`
   resolution (`PI_CODING_AGENT_DIR` or `~/.pi/agent`, then `sessions`).
   Test with a non-default agent folder.
2. **hcn: `session-substituted`.** Map the marker to the typed class.
   Recorded fixture from a real refused run.
3. **Lucid: headless role.** Ship the extension; pass `-e` and
   `LUCID_PI_EXPECTED_SESSION` on Pi resume through the harness seam; map
   `session-substituted`. Fake-hcn tests plus the P1 fault-injection lane
   as a live script.
4. **Lucid: interactive role, registration and commits.** `_pi-hook
   session-start | session-shutdown | tool-result`; proposal commit reuses
   the Claude proposal store. Tests with injected process facts; live Pi
   TUI publish in a Herdr pane.
5. **Lucid: listening and idle injection.** `_pi-hook settled`, cancel on
   person input, delivery. Live: a browser note reaches the Pi TUI, the
   model records receipt and outcome.
6. **Setup and docs.** `lucid connection setup --interface pi-cli` adds the
   extension to Pi settings; `docs/native-pi.md`; skill text.

Activation gates (v1 F6): TUI, RPC, JSON, print, and terminal-less
controls (P2, P4) are recorded. A live Pi TUI publish, note delivery,
receipt, response, departure, and verified headless resume must all pass
before `pi-cli` is enabled.

## Alternatives Considered

- **Upstream Pi strict-open option.** Not needed: verify-after-open inside
  Pi closes the race without it. Still welcome; it would let the refusal
  happen before process start.
- **v2 extension tool with a 45-second wait in `agent_end`.** `agent_end`
  fires per retry, and a blocking handler stalls the TUI. Replaced by the
  Bash-plus-`tool_result` commit and non-blocking `agent_settled` helper.
- **v2 session-file locator with payload version 4.** Only needed for
  non-default stores. Dropped; those sessions stay held.
- **A long-lived broker process per session.** Per-event helpers keep host
  ownership unchanged.

## Open Questions

1. Should the extension also inject when a helper returns an offer while
   Pi is busy (queued `followUp`), or hold it until the next
   `agent_settled`? This draft queues it. Queuing delivers sooner; holding
   keeps one offer per idle point.
2. Should `lucid connection setup --interface pi-cli` install the extension
   through `pi install` or by editing Pi settings directly? This draft
   prefers `pi install npm:@dungle-scrubs/lucid` if the package layout
   supports it.

## Response to v1 review

| Finding | Disposition |
|---|---|
| F1 locator wire revision | Removed: no locator, no new payload version. |
| F2 hcn strict lookup undefined | Replaced by verify-after-open and the typed `session-substituted` class, with the store-root fix. |
| F3 45-second `agent_end` wait | Replaced by non-blocking `agent_settled` helper and idle injection (P3). |
| F4 per-operation mapping | Table in Message Formats: the operations are the RFC 26 commands. |
| F5 trust composition | Stated in Protocol Overview: process, role, work; none substitutes. |
| F6 provenance controls | P2 and P4 recorded; live TUI acceptance remains the activation gate. |
| F7 locator bounds | Removed with the locator. |
| F8 helper lifecycle | Protocol Overview step 6 and State Machine: kill, await, then re-register. |

## References

Normative:

- [RFC 26](26_interactive-artifact-conversation-continuity.rfc.md): continuity, publication, delivery, handoff.
- [RFC 27](27_native-approvals-during-headless-continuation.rfc.md): native settings during continuation.
- [ADR 0005](../adr/0005-hcn-owns-harness-differences.md): hcn owns harness differences.
- [ADR 0003](../adr/0003-kernel-locks-divide-append-authority-from-execution.md): lock model.

Informative:

- [RFC 34](34_unbound-publication-headless-fallback.rfc.md): headless fallback for unconnected publishers.
- [v1 review](28_pi-native-extension-bridge-and-strict-session-locators.review-v1.md).
- Pi docs `extensions.md`, `environment-variables.md` (Pi 0.87.1).

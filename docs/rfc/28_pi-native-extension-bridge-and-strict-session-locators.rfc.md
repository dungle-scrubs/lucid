---
number: 28
title: "Pi native extension bridge and verified headless resume"
type: protocol
status: Accepted
author: "Claude Opus 5.5"
date: 2026-09-27
version: 6
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
headless run, checks the session and folder that Pi opened. Its `input`
handler lets the prompt reach the model only after that check passes. It
records the result in an attestation file that only Lucid can name. That
closes the lookup/open race that blocked v2, without a change to Pi.

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

v3 replaced v2 with a design built on native probes. The v3 review (G1-G7)
found three blocking defects: subagent commits, a verification that failed
open, and a missing folder check. v4 answered them with a third probe round
(Evidence, R1-R12). v5 answers the v4 review (Response to v3 review) with
two readings of Pi's source (R13, R14) and an ancestry rule for proposals.
v6 applies the v5 review's minor fixes and is Accepted. The changes since
v3:

- Only the `input` handler stops a prompt before the model. It now denies
  by default and cannot throw. `ctx.shutdown()` in `before_agent_start` is
  not a gate (R5, R7).
- Proof of the verification moves from a stderr marker, which hcn would
  have to parse, to an attestation file keyed by a per-attempt nonce. The
  model cannot read the nonce. hcn needs no new failure class.
- The check compares the working folder as well as the session ID.
- A commit requires the proposal's session to be the registered session.
  Pi gives each session, and each subagent process, its own
  `PI_SESSION_ID` (R8, R9). A proposal made under a nested Pi process
  refuses, even when that process resumed the parent session. In-process
  SDK sessions stay behind an activation gate.

The design reuses the Claude Code adapter's proven shape instead of the
v2 extension tool and 45-second in-handler wait. That removes v2's session
file locator and its payload version 4.

The person using this is the reader who annotates agent-authored artifacts
(`CONTEXT.md`). Lucid routes a live agent conversation into a durable
record and back to that reader. For a Pi author, this RFC makes the notes
reach the author's own session. It holds the scope RFC 26 accepted for
native interfaces.

Out of scope, with reasons:

- Sessions stored where hcn cannot see the store: the `--session-dir` flag
  and the `sessionDir` setting. hcn resolves `PI_CODING_AGENT_SESSION_DIR`,
  `PI_CODING_AGENT_DIR`, and the default (slice 1). Other sessions stay
  held. This removes v2's locator.
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
  mode, process ID and executable, session ID, session file, working
  folder, and for `tool_result` the tool call ID and the proposal marker
  tokens from the output.
- **Supervisor**: the extension's single module-level handle on its
  running helper. It owns spawn, kill, and await.
- **Verify-after-open**: the headless-role check. Pi opens a session; the
  extension compares it with the expected session and folder before the
  prompt can reach the model.
- **Attestation file**: a file at a Lucid-private path, named per resume
  attempt, where the headless role records `verified` or `refused` with
  the attempt nonce.
- **Idle injection**: the extension calls `pi.sendUserMessage` with
  `deliverAs: "followUp"`.

## Evidence

Pi 0.87.1, hcn 0.7.3, 2026-09-27. Provider: a closed local port, so a
model attempt appears as `Connection error.` and no traffic leaves the
machine. Implementation slice 2 turns P1 and R4 into a repeatable live
script (`scripts/smoke-pi-resume.ts`).

Rounds 1 and 2 (v3):

| Probe | Observation |
|---|---|
| E1 | Extensions load in `-p --mode json` (`ctx.mode: "json"`). Order: `session_start`, `input` (`source: "interactive"`), `before_agent_start`. |
| E3 | Resume of an existing session with the expected ID: allowed; model reached. |
| E4, E7 | Missing session file: Pi creates a new session with the same ID, 2 entries, 0 message entries. Extension refuses; 0 model attempts; exit 3; no session file written. |
| E6 | Opened session ID differs from expected: refused; 0 model attempts. |
| P1 | The real race through `hcn run pi --resume`: hcn's guard passes, a shim moves the file aside, Pi creates a new session. Refused through `input` returning `handled`; 0 model attempts; hcn reports `class: "native"`, `nativeExitCode: 3`. Control run without the shim reached the model. |
| P2 | TUI (Herdr pane): `mode: "tui"`. RPC: `mode: "rpc"`, `hasUI: true`. |
| P3 | TUI: a timer 1.5 s after `session_start` saw `isIdle: true`, called `sendUserMessage(text, {deliverAs: "followUp", expandPromptTemplates: false})`; Pi recorded `input` with `source: "extension"` and ran. Retries: 4 `agent_end`, 1 `agent_settled`. `ctx.shutdown()` in `agent_settled` exited Pi. |
| P4 | No terminal and no `-p`: `mode: "print"`. A Pi started from another agent's Bash tool cannot report `tui`. |

Round 3 (v4, answering the v3 review):

| Probe | Exit | Model attempts | Observation |
|---|---|---|---|
| R1 `-e` names a missing file | 1 | 0 | Pi refuses to start. |
| R2 extension factory throws | 1 | 0 | Pi refuses to start. |
| R3 `session_start` throws; `input` denies unless verified | 0 | 0 | Deny-by-default holds. |
| R4 `input` handler throws | 0 | 20 | Pi reports the error and runs the prompt. |
| R5 `input` throws; `before_agent_start` calls `ctx.shutdown()` | 3 | 20 | `shutdown()` there does not stop the model in print mode. |
| R6 `before_agent_start` throws | 0 | 20 | Pi continues. |
| R7 `before_agent_start` calls `ctx.shutdown()` only | 3 | 20 | Not a gate. |

- R8: Pi's Bash tool builds each child environment from `process.env` at
  spawn time. It deletes `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`,
  `PI_MODEL`, and `PI_REASONING_LEVEL`, then sets them from the calling
  session (`dist/core/tools/bash.js`). An extension that deletes its own
  variables from `process.env` in its factory hides them from every tool.
- R9: Pi's bundled subagent example starts `pi --mode json -p
  --no-session` as a separate process with piped stdio. That process has
  its own session ID and its own extension runtime in `json` mode.
- R10: Pi's own exit codes are 0, 1, and 129 (search of `dist`). Exit 3
  is unused.
- R11: hcn passes native arguments given after its own `--` to the child
  with no separator. The P1 spawn line reads `pi --session-id <id> -p
  --mode json ... -e <path>`.
- R12: hcn 0.7.1 refused an existing session under a non-default
  `PI_CODING_AGENT_DIR` (`no pi session <id> found at ~/.pi/sessions/...`).
  With the slice 1 fix, the same resume passed the guard and reached Pi.
  With `PI_CODING_AGENT_SESSION_DIR` set, Pi stores sessions flat, with
  no per-folder directory.

The v3 prototype's `before_agent_start` shutdown never ran in P1: `input`
had already returned `handled`. R5 and R7 show it would not have stopped
the model.

Source readings (v5, Pi 0.87.1):

- R13: `ExtensionRunner.emitInput` (`dist/core/extensions/runner.js`) runs
  every extension's `input` handlers in order and returns on the first
  `{action: "handled"}`. No later handler runs, so none can undo it. A
  handler that throws is reported and skipped. A prompt reaches the model
  only when no handler returns `handled`. `AgentSession.prompt`, and so
  `pi.sendUserMessage` from any extension, runs `emitInput` before any
  model call. Extension slash commands dispatch before `emitInput`, and
  queued `nextTurn` custom messages ride on the next approved prompt;
  both need installed extension code.
- R14: `AgentSession.sendCustomMessage` with `triggerTurn: true`
  (`dist/core/agent-session.js`) starts a model turn without an `input`
  event. Only an installed extension can call it.

## Protocol Overview

### Roles by mode

The extension reads `ctx.mode` in `session_start`:

| Mode | Role |
|---|---|
| `tui` | Interactive: registration, command commits, idle injection. |
| `json` or `print`, with `LUCID_PI_ATTEMPT` set | Headless resume: verify-after-open only. |
| `rpc` (with or without `LUCID_PI_ATTEMPT`), `json` or `print` without it, anything else | None. The extension does nothing. |

Three independent proofs compose; none substitutes for another (v1 F5):

1. The kernel identity of the helper's direct parent proves which process
   started the helper.
2. `ctx.mode === "tui"`, read in the extension callback, proves the role.
3. Registration generation, offer ID, and epoch prove the specific work,
   as in RFC 26.

A parent match alone MUST NOT be treated as role proof. Same-user code is
outside the boundary (Security Considerations), so the parent check is a
consistency check: the helper requires its parent PID to equal the
captured `pid`, and the parent executable to equal the captured
`execPath`, whose base name is `node` or `bun`.

### Interactive role

1. **Register.** On `session_start` in `tui` mode, the extension starts
   `lucid _pi-hook session-start` with the capture. The helper checks the
   parent, then calls `registerNativeSession` with interface `pi-cli`,
   harness `pi`, the captured session ID, and the captured working folder.
   The owner is the Pi process. A `session_start` with reason `new`,
   `resume`, `fork`, or `reload` replaces the registration with a new
   generation, after step 6's cancellation completes. `session_shutdown`
   runs `lucid _pi-hook session-shutdown`, which removes it. Replacement
   never moves a record binding: a record bound to the old registration
   keeps that binding, and later commits that name the old
   `registrationId` refuse with `registration-replaced`, as RFC 26
   requires.
2. **Propose from Bash.** The model runs ordinary Lucid commands in Pi's
   Bash tool: `lucid artifact publish`, `lucid connection resume-listen`,
   `receipt`, `respond`. As for Claude Code, a command run inside Pi only
   proposes. It reads `PI_SESSION_ID` (a locator that proves nothing).
   It walks its own process ancestry up to the registered owner. It
   refuses with `proposal-ancestry-unverified`, and prints that refusal in
   the tool output, when the owner is not an ancestor, or when any process
   between the command and the owner runs a JavaScript runtime (base name
   `node`, `bun`, or `deno`), an executable with base name `pi`, or the
   owner's executable. The `pi` clause covers a standalone Pi binary
   nested under an npm-installed Pi. A nested Pi,
   including one that resumed the parent session with the parent's
   `PI_SESSION_ID`, is such a process: Pi runs under a JavaScript runtime.
   Otherwise the command saves a proposal that carries the session ID and
   a nonce, and prints a marker. It changes no record. The model must
   run the `lucid` binary directly; a JavaScript launcher (`npx`, `bunx`,
   `pnpm`, `node <script>`) puts a runtime in the chain and refuses. The
   skill text says so (slice 5).
3. **Commit from `tool_result`.** For a `tool_result` whose `toolName` is
   `bash`, the extension extracts marker tokens (the prefix and a nonce)
   wherever they appear in the output, including inside `--json` output
   (at most 16 distinct tokens; more refuses the batch) and starts `lucid
   _pi-hook tool-result`. The helper commits a proposal only when all of
   these hold:
   - the parent and role checks pass;
   - the proposal's session ID equals the captured session ID;
   - the captured session ID is the session of the current registration
     generation for this owner;
   - the proposal nonce appears in this tool call's output.

   It commits through the same host operations the Claude PostToolUse
   hook uses. Claude needs `agent_id` because its subagents share the
   parent's session ID. Pi's do not: a Pi subagent process has its own
   session ID (R8, R9), so its proposals fail the session check, and its
   output reaches the parent as a non-`bash` tool result. A nested Pi
   that resumed the parent session passes the session check, so step 2's
   ancestry rule refuses it instead. A proposal from a headless or RPC Pi
   is never committed, because no `tui` callback exists there. In-process
   sessions that another extension creates through Pi's SDK are not
   covered by R8 or R9. They stay behind the
   `subagent-provenance-unverified` activation gate (Implementation
   Notes). As for Claude, a refused bind proposal is claimed, and its
   refusal is saved beside the publication, so the browser explains why
   the record did not connect.
4. **Listen at `agent_settled`.** When listening is requested for a bound
   record, the extension starts `lucid _pi-hook settled` at
   `agent_settled` and does not await it. The helper runs
   `listenAtNativeStop` with RFC 26's 45-second bound. If it returns an
   offer, the helper prints the offer instruction and exits. Because the
   extension never blocks Pi, there is no native hook deadline to fit
   inside: 45 seconds is the listener bound only, as RFC 26 already states
   for Pi. The supervisor runs at most one helper. An `agent_settled`
   while a helper runs, or while an offer is outstanding, starts nothing.
5. **Inject.** On the helper's result, the extension calls
   `pi.sendUserMessage(offer, {deliverAs: "followUp",
   expandPromptTemplates: false})`. When Pi is idle, the offer starts a
   run. When the person has started a run, Pi queues the offer after it.
   If `sendUserMessage` throws, or the runtime has gone, the offer is
   delivery-uncertain as RFC 26 defines, and nothing replays it.
   Transport is not receipt: the model records receipt with `lucid
   connection receipt` before work and the outcome with `respond` after,
   both committed in step 3. The offer stays outstanding until receipt
   and outcome, or until RFC 26's uncertainty rules settle it.
6. **Cancel.** Person input (`input` with `source: "interactive"`),
   `session_shutdown`, or `session_start` with a replacing reason, while
   a helper runs: the supervisor sends SIGTERM, then SIGKILL after 2 s,
   and awaits exit before re-registration or shutdown continues. A helper
   killed before it recorded `offer-started` leaves the input saved. A
   helper that recorded `offer-started` and was killed before it returned
   leaves the offer delivery-uncertain. The next `agent_settled` MUST NOT
   replay it. Reload replaces the extension runtime; the old runtime's
   `session_shutdown` handler kills its helper, so no helper outlives its
   supervisor. Cleanup is idempotent, as Pi requires.

### Headless role (verify-after-open)

7. On confirmed interactive departure (RFC 26 section 6), Lucid records
   launch intent, which projects RFC 26's `No interactive session
   detected. Resuming headlessly with session <id>.` notice (existing
   behavior). It then resumes through hcn with the stored session ID and
   folder: `hcn run pi --resume <id> --cwd <folder> ... -- -e <extension
   path>`. hcn passes `-e <path>` to Pi with no separator (R11). `-e`
   loads the extension even when discovery is off (`-ne`). Environment:
   - `LUCID_PI_ATTEMPT`: `<attempt ID>.<nonce>`. The attempt ID passes
     RFC 26's ID validator; the nonce is 64 lowercase hexadecimal
     characters from a cryptographic source. A value that does not parse
     is treated as a failed check.
   - `LUCID_PI_EXPECTED_SESSION`: the session ID.
   - `LUCID_PI_EXPECTED_CWD`: the stored folder, as a real path.
   - `LUCID_PI_ATTESTATION`: the attestation file path,
     `<record private directory>/pi-attestation/<attempt ID>.json`. One
     file per attempt, so exclusive create never meets an earlier file.
8. The extension factory reads the four variables and deletes them from
   `process.env`, so no tool the model runs can read them (R8).
9. In `session_start`, the extension checks, in order:
   - `sessionManager.getSessionId()` and `getHeader().id` equal the
     expected ID; else `session-id-mismatch`;
   - `getHeader().cwd` and `ctx.cwd` each match the stored folder: equal
     to its original spelling, or equal after both sides resolve to real
     paths (RFC 26 keeps the original spelling and does not let a real
     path replace it); else `folder-mismatch`;
   - at least one entry of type `message` exists; else `session-empty`. A
     new session has 2 non-message entries (`model_change`,
     `thinking_level_change`), so "no entries" is the wrong test. A bound
     session always has messages: Lucid binds from a committed Bash tool
     call, so the session already holds the user message and the
     assistant's tool call.

   The checks run inside a `try`/`catch`. A thrown error is a refusal with
   reason `verification-failed`. The extension writes the attestation
   file (`verified` or `refused` with the reason) before `session_start`
   returns. On refusal it sets exit code 3. If the write itself fails,
   the `input` gate stays closed and the outcome is uncertain.
10. The `input` handler is the only pre-model gate (R4-R7). It returns
    `{action: "continue"}` only when step 9 wrote `verified`. In every
    other case, including a `session_start` that threw (R3), it returns
    `{action: "handled"}`. Its body is a single comparison inside a
    `try`/`catch` whose catch returns `handled`, so it cannot throw. Other
    extensions' `input` handlers cannot open the gate: the first `handled`
    ends the chain (R13). This covers the resume prompt, which never
    starts with `/`, and every `prompt` call. It does not cover a turn
    that another installed extension starts with `sendCustomMessage` and
    `triggerTurn` (R14), or through its own slash command. With a
    `refused` attestation, such a turn emits agent events, so the outcome
    table classifies it as uncertain, never as a proven refusal. With a
    `verified` attestation it runs in the verified session and counts as
    part of the continuation; that is the user's own installed code, in
    the trust model of Security Considerations. Lucid does not pass `-ne` to shut other extensions
    out: a session can depend on a provider or tool that one of them
    registers.
11. A missing or broken extension stops Pi before any session opens (R1,
    R2). Lucid also refuses before invoking hcn when the extension file is
    absent: `native-extension-unavailable`.

## Message Formats

Helper stdin, one UTF-8 JSON object, at most 64 KiB. The extension
builds the capture; the helper refuses a larger input before parsing:

```json
{
  "v": 1,
  "event": "session-start | session-shutdown | tool-result | settled",
  "mode": "tui",
  "pid": 12345,
  "execPath": "/abs/node",
  "nativeSessionId": "<id>",
  "sessionFile": "/abs/path.jsonl",
  "workingDirectory": "/abs/folder",
  "toolCallId": "<id, tool-result only>",
  "markers": ["<proposal marker token>", "... at most 16, tool-result only"]
}
```

The helper refuses unknown `event` values, unknown fields, and any `mode`
other than `tui`, before any mutation. IDs and paths use RFC 26's
validators.

Helper stdout, one JSON object, at most 48 KiB: the existing
`NativeListenerResult` for `settled`, the existing registration and
proposal results for the other events. The extension treats a missing,
malformed, or oversized result as unconfirmed; it reads current state and
does not repeat the operation.

Attestation file (headless role), one JSON object, written with
exclusive create:

```json
{"v":1,"attempt":"<attempt ID>","nonce":"<nonce>","outcome":"verified | refused","reason":"session-id-mismatch | folder-mismatch | session-empty | verification-failed","expected":"<id>","opened":"<id>"}
```

`reason` appears only when `outcome` is `refused`. Lucid reads the file
after hcn returns and ignores any file whose nonce or attempt differs.
When `LUCID_PI_ATTEMPT` does not parse, the extension has no attempt to
name, so it writes no file; the `input` gate stays closed, and the
outcome is uncertain.

Headless outcome, as Lucid classifies it:

| hcn result | Attestation | Agent events in the stream | Classification |
|---|---|---|---|
| success | `verified`, nonce matches | at least one | Continuation in the bound session. |
| `native`, `nativeExitCode: 3` | `refused`, nonce matches | none | Proven pre-model refusal (Amendment 1). |
| any other combination | any, or none | any | Uncertain. The attempt holds under RFC 26 uncertainty; the turn's output is not accepted as the bound continuation. |

Agent events are every hcn event kind except `identity`, `progress`,
`error`, `failure`, and `done`. A kind Lucid does not know counts as an
agent event, so an hcn release that adds kinds can only move an outcome
toward uncertain.

hcn needs no change for this table. The marker is Lucid's own protocol,
not a Pi behavior, so it does not belong in hcn (ADR 0005).

Per-operation mapping (v1 F4). Each Pi operation is the RFC 26 CLI command
itself, run in Pi's Bash tool; only the commit point differs:

| Operation | RFC 26 command | Validators | Commit point |
|---|---|---|---|
| publish | `lucid artifact publish --request FILE` | existing publication validators | `tool_result` helper, step 3 checks; a refused bind is saved beside the publication |
| resume-listen | `lucid connection resume-listen ID` | existing | same |
| receipt | `lucid connection receipt ID --offer O` | existing offer/epoch checks | same |
| respond | `lucid connection respond ID --offer O --request FILE` | existing | same |

Every row also carries step 2's ancestry rule and step 3's session rule;
their refusals are `proposal-ancestry-unverified` and
`proposal-session-mismatch`. Lock order is unchanged: registration lock
before record append lock.
Repeats use the existing exact offer and result identities.

## State Machine

Integration states; the durable host keeps authority.

- `none -> registered`: `session_start` in `tui` mode, helper accepted.
- `registered -> waiting`: `agent_settled` with a listen request for a
  bound record, no helper running, no offer outstanding; helper started.
- `waiting -> offered`: the helper recorded `offer-started` and returned
  the instruction; `sendUserMessage` returned.
- `waiting -> uncertain`: `offer-started` recorded, then the helper was
  killed, its result was lost, or `sendUserMessage` threw.
- `waiting -> registered`: 45-second expiry, person input, or helper
  failure before an offer. Input stays saved.
- `offered -> registered`: receipt and outcome recorded; continuation
  follows RFC 26.
- `uncertain -> registered`: RFC 26 settles the offer. Nothing replays it.
- any state `-> none`: `session_shutdown` or replacement; a running
  helper is killed and awaited first.

Headless role: `opened -> verified` or `opened -> refused`; no other
states. `refused` never reaches `input` with `continue`.

## Error Handling

| Condition | Behavior |
|---|---|
| Helper parent PID or executable does not match the capture | Refuse registration: `native-context-unverified`. |
| Owner has no parent shell, runs under a JavaScript runtime or Pi process, or the session file header disagrees | Refuse registration: `native-context-unverified`. |
| `mode` is not `tui` in an interactive-role event | The extension does not start a helper. |
| Helper input over 64 KiB, malformed, or with unknown fields | Refuse before parsing or mutation. |
| More than 16 distinct marker tokens in one tool result | Refuse the batch; nothing commits. |
| Proposal session is not the registered session | Refuse the proposal: `proposal-session-mismatch`. |
| A JavaScript runtime or the owner's executable sits between the command and the owner | Refuse the proposal: `proposal-ancestry-unverified`. |
| A Bash command runs without `PI_SESSION_ID` | No proposal is made; the publication reports `owner-unknown`. Pi sets the variable only when its Bash tool receives the tool context. An extension that replaces the Bash tool must pass that context to Pi's built-in tool. |
| A bind proposal is refused | Claim it and save the refusal beside the publication, as for Claude. |
| Commit names a replaced registration | Refuse: `registration-replaced`. The record binding is unchanged. |
| Helper result lost | Read current state; do not repeat. Offers follow RFC 26 uncertainty rules. |
| Proven pre-model refusal (outcome table) | Record a pre-start harness refusal (`E-HUB-05`, `harness-refusal`) naming the reason. No automatic retry and no fresh session. |
| Uncertain headless outcome | Hold under RFC 26 uncertainty. No automatic retry. |
| Session in a store hcn cannot see | hcn's guard refuses before spawn; the input stays held. |
| Extension file missing at resume time | Refuse before invoking hcn: `native-extension-unavailable`. |

No error authorizes a fresh session, a different model, or a fallback to
the ordinary managed driver for a bound record.

## Amendments to RFC 26

1. RFC 26 accepts as proven pre-start refusal only hcn
   `spawn-not-attempted` and Lucid `dispatch-not-called`. This RFC adds a
   proven pre-model refusal for the Pi lane. Its definition is the outcome
   table's second row: hcn `native` with exit 3, a `refused` attestation
   whose attempt and nonce match, and no agent events in the stream. It
   proves that this attempt did not reach the model. It does not prove the
   original session is gone, so the input stays held. RFC 26's retry rule
   applies unchanged: no automatic retry; an operator-admitted retry after
   repair uses the same input and session with a new attempt ID and a new
   notice. Pi writing no session file for a refused run (E7) is observed
   Pi 0.87.1 behavior, not part of the definition.
2. RFC 26 section 5 lists Pi CLI integration as pending native acceptance.
   This RFC is that acceptance contract for `pi-cli`. Until the live lanes
   in Implementation Notes pass, `pi-cli` has no entry in the listener's
   verified transports, and delivery stays `transport-unverified`.
3. RFC 26 requires native identity and folder for a headless resume. The
   Pi lane checks both twice: hcn's guard before spawn, and step 9 after
   Pi opens the session.

## Security Considerations

- Same-user native code is outside the boundary, as in RFC 26: an
  installed Pi extension already has the user's authority. This RFC does
  not claim that a malicious same-user process cannot impersonate the
  extension.
- A model cannot nominate an owner or a session through Lucid's commands:
  Bash commands only propose, and commits need the parent callback in
  `tui` mode and a proposal session equal to the registered session.
  Registration also refuses an owner with no parent shell, an owner that
  runs under a JavaScript runtime or a Pi process, and a session file whose
  header names another session or folder. These checks stop accidental
  nesting and simple owner substitution. They are not a boundary against a
  model that runs arbitrary code as the user: that code is same-user code,
  outside the boundary, as the first bullet states. `PI_SESSION_ID` locates
  a registration and proves nothing.
- The model cannot forge an attestation. The nonce and the file path
  leave `process.env` before any tool runs (R8). A refusal also requires
  exit 3 and a stream with no agent events, which a run that reached the
  model cannot produce.
- The ancestry rule in step 2 targets nested agents, not a hostile
  model. A command that disguises a JavaScript runtime under another
  executable name is same-user code, outside the boundary, as it is for
  the Claude adapter.
- An in-process SDK session that an extension forces to the parent's
  session ID can save a proposal. Nothing commits it on its own. It would
  commit if the parent's own Bash output repeated its marker before the
  proposal expires (10 minutes). Reusing the parent's ID takes extension
  code the user installed, which is same-user code, outside the boundary.
- Helper input is bounded and closed. The capture never travels in tool
  parameters, artifacts, or browser requests.
- The verify-after-open check reads session metadata only. It never reads
  or copies history.
- Session file paths and attestation files are private record metadata.

## Versioning

No new execution payload version. `pi-cli` bindings use the existing
`bound` fact; no locator is stored. The helper protocol and the
attestation file have `v: 1`; unsupported versions refuse. The extension
and Lucid ship in one package, so they share one version. hcn needs only
the slice 1 store fix; the Lucid hcn pin moves deliberately with
re-captured fixtures.

## Implementation Notes

Each slice has an observable outcome before the next depends on it.

1. **hcn: store root.** The Pi store resolves as Pi does:
   `PI_CODING_AGENT_SESSION_DIR` (flat), else
   `<PI_CODING_AGENT_DIR>/sessions/<slug>`, else
   `~/.pi/agent/sessions/<slug>`. Tests with a non-default agent folder
   and a flat session folder. Status: shipped in hcn 0.7.4.
2. **Lucid: headless role.** Ship the extension; pass `-e` and the four
   variables on Pi resume through the harness seam; read the attestation;
   classify per the outcome table. Fake-hcn tests, plus
   `scripts/smoke-pi-resume.ts` with four live cases: control resume,
   raced resume (P1), folder mismatch, and a second extension whose
   `input` handler returns `continue`, run in both load orders. Each case
   records the full list of hcn event kinds, and the refused cases must
   match outcome table row 2. Status: implemented; the extension loads
   through hcn `--extension` (RFC 35), and `scripts/smoke-pi-resume.ts`
   passes all five runs on hcn 0.7.6.
3. **Lucid: interactive role, registration and commits.** `_pi-hook
   session-start | session-shutdown | tool-result`; proposal commit reuses
   the Claude proposal store with the session check. Tests with injected
   process facts; live Pi TUI publish in a Herdr pane.
4. **Lucid: listening and injection.** Supervisor, `_pi-hook settled`,
   cancel on person input, delivery. Live: a browser note reaches the Pi
   TUI; the model records receipt and outcome. Live: a reload while a
   helper waits leaves no helper process.
5. **Setup and docs.** `lucid connection setup --interface pi-cli` adds the
   extension's absolute path to the `extensions` array in Pi's user
   settings. It does not use `pi install`, which would load a whole
   package. `docs/native-pi.md`; skill text.

Activation gates (v1 F6). `pi-cli` stays unavailable until all pass:

- Recorded: TUI, RPC, JSON, print, and terminal-less controls (P2, P4).
- `subagent-provenance-unverified`: a negative-control lane in which
  (a) a nested `pi` run from the TUI's Bash tool proposes, (b) a nested
  `pi` that resumed the parent session with `PI_SESSION_ID` proposes, and
  (c) an extension creates an in-process SDK session that proposes.
  Nothing may commit in any case; (a) and (b) refuse with
  `proposal-ancestry-unverified` or `proposal-session-mismatch`.
- Live Pi TUI publish, note delivery, receipt, response, departure, and
  verified headless resume.

Gate results, 2026-09-27, Pi 0.87.1, local Qwen through LM Studio. The
helper command was wrapped in a script that logs every start; a TUI run
confirmed the log records a real `session-start`.

- Mode controls: print, JSON, RPC, and no-terminal runs each reached the
  model, started no helper, and registered nothing.
- (a) A nested `pi -p --no-session` publish reported
  `registration-missing`: its own session is not registered, so no
  proposal was saved.
- (b) A nested `pi -p --session "$PI_SESSION_ID"` publish refused with
  `proposal-ancestry-unverified`; nothing was saved.
- (c) An in-process SDK session with its own ID behaved as (a). One forced
  to the parent's session ID saved a proposal, and nothing committed it:
  the SDK session's Lucid extension is not in `tui` mode, and the parent's
  extension does not see the SDK session's tool results.
- Live TUI lanes: a `--json` publish bound its record; a browser note
  arrived as a follow-up, and the model recorded receipt and an answer;
  `/reload` while listening left no helper and disabled the listener; a
  quit Pi closed its bound record. `scripts/smoke-pi-resume.ts` passed
  for the headless resume.

## Alternatives Considered

- **Upstream Pi strict-open option.** Not needed: verify-after-open inside
  Pi closes the race without it. Still welcome; it would let the refusal
  happen before process start.
- **Stderr refusal marker mapped by hcn to `session-substituted` (v3).**
  Dropped. hcn would parse a Lucid-private format, a process-wide stderr
  stream is shared with Pi's own warnings, and the model's tools might
  reach it. The attestation file carries the same fact with a nonce.
- **`before_agent_start` shutdown as a second gate.** Does not stop the
  model (R5, R7).
- **v2 extension tool with a 45-second wait in `agent_end`.** `agent_end`
  fires per retry, and a blocking handler stalls the TUI. Replaced by the
  Bash-plus-`tool_result` commit and the non-blocking `agent_settled`
  helper.
- **v2 session-file locator with payload version 4.** Dropped; sessions
  hcn cannot see stay held.
- **A long-lived broker process per session.** Per-event helpers keep host
  ownership unchanged.
- **Hold a busy-time offer in extension memory until the next
  `agent_settled`.** The offer is already recorded as started; memory is
  lost on exit, which turns every busy-time offer into an uncertain one.
  Pi's `followUp` queue delivers it after the person's run instead. The
  supervisor's one-outstanding-offer rule prevents stacking.

## Open Questions

None.

## Response to v1 review

| Finding | Disposition |
|---|---|
| F1 locator wire revision | Removed: no locator, no new payload version. |
| F2 hcn strict lookup undefined | Replaced by verify-after-open with folder check and the attestation file; hcn store-root fix in slice 1. |
| F3 45-second `agent_end` wait | Replaced by the non-blocking `agent_settled` helper and injection (P3); supervision in step 6. |
| F4 per-operation mapping | Table in Message Formats, with the step 3 session check. |
| F5 trust composition | Protocol Overview: process, role, work; the parent check is pinned to the captured PID and executable. |
| F6 provenance controls | Mode controls recorded; the subagent control is an activation gate. |
| F7 locator bounds | Removed with the locator; folder identity is checked in step 9. |
| F8 helper lifecycle | Supervisor, singleton, kill order, reload, and bounds owners in steps 4-6 and Message Formats. |

## Response to v2 review (of v3)

| Finding | Disposition |
|---|---|
| G1 subagent commits | Step 3: the proposal session must be the registered session; Pi subagent processes have their own session ID (R8, R9). In-process SDK sessions are an activation gate. |
| G2 verification fails open | A missing extension or a throwing factory stops Pi (R1, R2). A throwing handler does not (R3, R4); step 10's deny-by-default `input` handler, which cannot throw, contains it. Uncertain outcomes never count as success. |
| G3 argv and folder | The hcn `--` delimits hcn's own options; the child argv has none (R11). Folder check added (step 9). Slice 1 is a prerequisite; it is committed on an hcn branch, with release and pin pending. |
| G4 marker spoofing | Marker replaced by the nonce-keyed attestation file plus exit 3 plus an empty agent stream. Exit 3 is unused by Pi (R10). |
| G5 injection races | Supervisor with one helper and one outstanding offer; `sendUserMessage` failure is delivery-uncertain; reload handled by the old runtime's `session_shutdown`; 45 seconds is a listener bound with no native deadline. |
| G6 Amendment 1 overclaims | Narrowed to this attempt; RFC 26 retry rule restated; lazy write is observation, not definition. |
| G7 RFC 26 deviations | Launch notice is existing behavior (step 7); folder (Amendment 3); transport stays unverified until acceptance (Amendment 2); binding kept across replacement (step 1); headless proposals never commit (step 3). |

## Response to v3 review (of v4)

| Finding | Disposition |
|---|---|
| M1 verified with no agent events | Outcome table row 1 requires at least one agent event. |
| M2 agent events undefined | Defined below the outcome table; unknown kinds count. |
| M3 attestation path | One file per attempt ID (step 7). |
| M4 multi-extension semantics | R13: the first `handled` ends the chain. R14's custom-message turn is named in step 10 and classified uncertain. `-ne` rejected, with the reason. |
| M5 `session_start` throws before writing | Checks run in `try`/`catch`; a throw writes `refused` with `verification-failed` (step 9). |
| M6 nested Pi resumes the parent session | Step 2 ancestry rule; activation gate case (b). |
| M7 bind refusal | Step 3 and the error table: claimed and saved beside the publication. |
| N1 per-operation table | Ancestry and session rules stated for every row. |
| N3 empty bound session | Step 9 states why a bound session has messages. |
| N4 folder spelling | Step 9 accepts the original spelling or real-path equality. |
| N5 G2 row overclaims | Row corrected. |
| N6 slice 1 status | Implementation Notes and the G3 row state branch status. |
| N7 attempt format | Step 7 defines the format and validators. |

## Response to v4 review (of v5)

Verdict: accept with minors.

| Finding | Disposition |
|---|---|
| D1 attestation reasons | `verification-failed` added; an unparsable attempt writes no file and stays uncertain. |
| D2 coverage wording | R13 and step 10 name the slash-command and `nextTurn` paths, and the verified-attestation case. |
| D3 row 2 at the hcn level | Slice 2 records full kind lists and runs the second extension in both load orders. |
| D4 ancestry caveats | `pi` base name added to the refused set; direct-binary requirement stated. |

## References

Normative:

- [RFC 26](26_interactive-artifact-conversation-continuity.rfc.md): continuity, publication, delivery, handoff.
- [RFC 27](27_native-approvals-during-headless-continuation.rfc.md): native settings during continuation.
- [ADR 0005](../adr/0005-hcn-owns-harness-differences.md): hcn owns harness differences.
- [ADR 0003](../adr/0003-kernel-locks-divide-append-authority-from-execution.md): lock model.

Informative:

- [RFC 34](34_unbound-publication-headless-fallback.rfc.md): headless fallback for unconnected publishers.
- [v1 review](28_pi-native-extension-bridge-and-strict-session-locators.review-v1.md).
- [v2 review](28_pi-native-extension-bridge-and-strict-session-locators.review-v2.md), of v3.
- [v3 review](28_pi-native-extension-bridge-and-strict-session-locators.review-v3.md), of v4.
- [v4 review](28_pi-native-extension-bridge-and-strict-session-locators.review-v4.md), of v5.
- Pi docs `extensions.md`, `settings.md`, `environment-variables.md` (Pi 0.87.1).

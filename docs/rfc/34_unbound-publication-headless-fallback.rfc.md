---
number: 34
title: "Unbound publication falls back to headless with the producer's settings"
type: feature
status: Accepted
author: "Claude Opus 5.5"
date: 2026-09-27
version: 3
---

# RFC-34: Unbound publication falls back to headless with the producer's settings

## Abstract

An agent session with no Lucid integration can publish an artifact through
`lucid artifact publish`. RFC 26 v9 then records a native requirement, the
binding fails, and the record holds every browser note permanently. No
action ends the hold, and the saved driver preference cannot select a
driver for it. The record also takes the built-in `claude` / `opus`
defaults, because the publisher did not send its own settings. This RFC
makes four changes. The skill tells a non-integrated publisher to send its
settings, working folder, and origin. A publication whose binding fails
with `registration-missing` records a terminal `publication-fallback`
fact, and browser chat then runs as an ordinary headless conversation on
those settings. A fresh headless session gets a pointer to the origin
session's transcript. The ancestry check reads parent PIDs of root-owned
processes, so an unregistered caller gets `registration-missing` and not
`owner-unknown`.

## Introduction

Observed on 2026-09-26. An interactive Pi session running `zai/glm-5.3` in
a Herdr pane published `golden-email-classifier` from
`~/dev/harness/rolodex`. Record `40cf7112-6dab-485b-b099-e1b306570dac`
shows this sequence:

1. `publication-requested`, then artifact version 1.
2. `publication-connection-failed`, reason `owner-unknown`, message "The
   calling native session could not be verified."
3. A browser note, saved as `managed-input`, never dispatched.

The connection projection reports `setup-required` with
`nativeConnectionRequired: true` and `nativeSessionId: null`. The saved
preference is `pi / zai / glm-5.3 / headless-turn`, revision 2. The person
set that preference in Settings, and it has no effect.

Three defects produce this result:

- **The hold has no exit.** `requiresNativeConnection` is true for any
  record with `nativePublication !== null` (`src/protocol/connection.ts:328`).
  `managedCandidates` then returns `[]` (`src/store/managed-readiness.ts:36`).
  RFC 26 v9 defines no clear-requirement or convert-to-managed action, and
  states "Saved preference never selects this state." Pi has no
  integration (RFC 28 is parked), so the record can never bind.
- **The record takes the wrong settings.** The publication request already
  accepts `settings` and `workingDirectory`
  (`src/cli/artifact-publish.ts:163-176`). Creation writes `settings` as the
  initial driver preference at revision 1 (`src/store/creation.ts:84`).
  The Pi session sent neither field. So the record took
  `readUserConfig().defaults`, which are the built-ins `claude` / `opus` /
  `high` (`src/config/user-config.ts:22`), and a managed workspace inside
  the record folder, not `~/dev/harness/rolodex`.
- **The failure reason is wrong.** The caller was not registered, so the
  result should be `registration-missing`. `callerAncestryOwns`
  (`src/store/native-registration.ts:73-86`) walks the caller's parent
  processes once for each live registration. The Pi process descends from
  `/usr/bin/login` (pid 872), which root owns. `readProcessOwner` uses
  `proc_pidinfo` with `PROC_PIDTBSDINFO`, which fails for a root-owned
  process, so the walk returns `undefined`. Three live Claude Code
  registrations exist on the machine, so `withNativeRegistration` reports
  `owner-unknown` (`src/store/native-registration.ts:288`). Every session
  started in a Ghostty terminal has this ancestry.

The Lucid skill tells an interface with no integration not to publish.
The Pi session published anyway. A skill instruction does not hold at the
boundary, so the fix belongs in the publish path.

The person using this is the reader who annotates agent-authored artifacts
(`CONTEXT.md`). Lucid routes a live agent conversation into a durable
record and back to that reader. A record that accepts notes and never
answers them breaks that purpose. This RFC removes a dead end. It adds no
interface support and holds scope.

Out of scope, with reasons:

- Pi native integration. RFC 28 owns it.
- Resuming the original native session headlessly. It needs a strict
  session locator, which RFC 28 has not settled.
- Transcript import. RFC 26 ruled it out. Section 4 passes a pointer only.
- Records held for any reason other than `registration-missing`. Those
  holds protect a session that may be alive, and RFC 26 keeps them.
- Returning a fallback record to native delivery. Section 3 explains why
  fallback is terminal.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD
NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted
as described in RFC 2119.

- **Native requirement**: RFC 26's `nativePublication` state. It holds
  queued input until a verified binding exists.
- **Unbound publication**: a publication with a native requirement and no
  binding.
- **Fallback**: the durable `publication-fallback` fact, and the state it
  produces. It ends a native requirement that never bound. The word
  "release" is not used, because `hold-released` already names the
  detach/handoff fact (`src/protocol/connection.ts:343`).
- **Producer settings**: the harness, provider, model, effort, and profile
  that the publishing session sends for itself in `settings`.
- **Origin**: the publishing session's declared harness, native session ID,
  and native session file. Lucid stores it as unverified provenance.

## Motivation

Every interactive session that is not a registered Claude Code or Codex
CLI session produces this dead end when it publishes: Pi, Muse, Cursor,
and any delegated worker. The reader sees a working chat input, types a
note, and gets "Saved" with no answer and no action that changes it. The
Settings panel offers a model choice that does nothing. The page does not
say why.

Upkeep after this ships: one fact kind and one state field in the
connection reducer, one predicate term, one projection state, one metadata
field, one prompt line, one probe fallback, and one label. The existing
managed dispatch path does the execution. That upkeep is small against a
failure that affects every non-integrated publisher.

## Design

### 1. The publisher sends producer settings, working folder, and origin

`settings` and `workingDirectory` already exist on the publication
request. The only new request field is `origin`:

```json
{
  "creationId": "golden-email-classifier-20260926-a01",
  "workingDirectory": "/Users/kevin/dev/harness/rolodex",
  "settings": {
    "harness": "pi",
    "provider": "zai",
    "model": "glm-5.3",
    "effort": "high",
    "profile": "headless-turn"
  },
  "origin": {
    "harness": "pi",
    "nativeSessionId": "<id>",
    "sessionFile": "/abs/path/to/session.jsonl"
  },
  "artifact": { "...": "unchanged" },
  "serverUrl": "http://127.0.0.1:17454/"
}
```

Rules:

1. `settings` and `workingDirectory` keep their current validation and
   their current creation path. Creation already writes `settings` as the
   initial driver preference (`createConversationRecord`,
   `src/store/creation.ts:84`). Managed preparation reads that preference
   (`src/modes/managed-preparation.ts:265`).
2. When `settings` is absent, current behavior holds: user-config
   defaults. Publishers that use an older skill still get those defaults.
   This RFC fixes the settings defect only for publishers that send
   `settings`, which the skill change in section 6 makes normal.
3. Lucid MUST NOT infer settings from artifact text, the process table, or
   harness session files. ADR 0005 and ADR 0009 govern. The declaration is
   a preference, not a claim about what ran. The log records what ran.
4. `settings` applies only on creation. A publication into an existing
   conversation MUST NOT change the driver preference. The person's choice
   in Settings wins after creation.
5. `origin` is optional and applies only on creation. Lucid validates it
   only on a creation publish and ignores it on a publication into an
   existing conversation, like `settings`. Its shape is closed:
   `harness` is a known harness name, `nativeSessionId` is at most 128
   characters from the wire-ID alphabet, and `sessionFile` is an absolute
   path of at most 4096 bytes with no control characters (the rules of the
   existing `path()` validator, `src/protocol/connection.ts:572-576`).
   Every field is optional. On a creation publish, an invalid `origin`
   refuses the request with `E-HUB-03` before any durable write.
6. Lucid stores `origin` inside the creation request in record metadata
   (`creation.request.origin`). The creation receipt compares the whole
   request, so a retry with the same creation ID must send the same
   `origin`. It is provenance only. It grants no execution authority,
   selects no harness, and MUST NOT be passed to hcn as a resume target.
7. The `driver-preference.ts` module comment that names the server as the
   only writer gains the creation carve-out that already exists in code.

### 2. The `publication-fallback` fact and state

The connection protocol gains one fact kind on the existing envelope
`{v: 1, src: "execution", payloadVersion: 2, at, connection: body}`. Its
body is exactly:

```json
{ "kind": "publication-fallback", "actionId": "<uuid>", "failureActionId": "<uuid>" }
```

Both IDs pass the existing `connectionId` validator. `parseConnectionFact`
reads these three keys, following the convention of the other connection
facts.

`NativePublication` (`src/protocol/connection.ts:312-326`) gains one field:

```ts
readonly fallback: {
  readonly actionId: string;
  readonly failureActionId: string;
  readonly at: number;
} | null;
```

Its initial value is `null`. The fold of a record written before this
amendment produces `null`. `ChannelState.holdRelease` and the
`hold-released` fact are unchanged.

The reducer accepts `publication-fallback` only when all of these hold.
Otherwise it refuses with the reason shown:

| Condition | Refusal |
|---|---|
| `state.nativePublication !== null` | `connection-not-admitted` |
| `state.connection === null` (never bound) | `connection-not-admitted` |
| `nativePublication.failure?.actionId === failureActionId` | `connection-not-admitted` |
| `nativePublication.failure.reason === "registration-missing"` | `connection-not-admitted` |
| `hasUnsettledPublicationDelivery(state) === false` | `execution-blocked` |
| `nativePublication.fallback === null` | `connection-conflict` |

The fact's `actionId` goes into `nativePublication.actions`, like the
other publication facts. The existing top-of-reducer rule then makes an
identical repeat a no-op and a reused ID with different content a
`connection-conflict` (`src/protocol/connection.ts:996-1002`).

The v1 guard "no reconnect reservation exists" is dropped. It is vacuous:
a reconnect needs a binding (`src/protocol/connection.ts:1080-1082`), and
the table already requires `connection === null`.

`requiresNativeConnection` (`src/protocol/connection.ts:328`) becomes:

```ts
export function requiresNativeConnection(state: ChannelState): boolean {
  return (
    state.connection !== null ||
    (state.nativePublication !== null && state.nativePublication.fallback === null)
  );
}
```

Every RFC 26 admission check uses this predicate, so a fallback record is
an ordinary managed record for admission. Section 3 covers what happens
after that.

### 3. Fallback is terminal

After fallback, the record stays a managed record. Three reducer rules
enforce this:

1. `bound` is refused with `connection-conflict` when
   `nativePublication.fallback !== null`. A native session cannot take
   over a record that has already dispatched, or may dispatch, managed
   work.
2. `publication-connection-failed` is refused with
   `connection-not-admitted` when `nativePublication.fallback !== null`.
   The failure that caused the fallback stays the current failure.
3. `publication-requested` keeps its current rule. The host reuses
   `requestedActionId` (`src/store/conversation-host.ts:1186-1188`), so a
   later publication writes an identical fact, and the reducer treats it
   as a no-op.

The v1 "re-arm" rule is removed. It conflicted with the second-request
refusal (`src/protocol/connection.ts:1008-1013`). It also required a
native session to take over a record whose managed session may already
hold history, which RFC 26's binding guards refuse
(`src/protocol/connection.ts:1044-1048`). A person who wants native
delivery starts a new conversation from an integrated session.

`connectPublication` reads the record state first. When `fallback` is not
null, it skips registration lookup and returns the fallback projection
from section 5. A later publication into a fallback record therefore
writes its artifact and changes no connection state.

### 4. Writing the fallback: two ordered appends

The fallback write follows the failure write. These are two separate host
transactions, because `writeConnection` appends one fact for each
`transactDynamic` call (`src/store/conversation-host.ts:1048-1084`):

1. `saveConnectionFailure` appends `publication-connection-failed` through
   `recordNativePublication`, as it does today. The host reuses the
   previous failure's ID when reason and message are unchanged
   (`src/store/conversation-host.ts:1178-1181`).
2. When step 1 is accepted and the reason is `registration-missing`,
   `saveConnectionFailure` calls a new host operation,
   `recordPublicationFallback()`. Inside one `writeConnection`
   transaction, it reads the current `nativePublication.failure` and
   produces `{kind: "publication-fallback", actionId, failureActionId:
   failure.actionId}`. The `actionId` is the existing `fallback.actionId`
   when one exists, otherwise a new UUID. The reducer table in section 2
   decides the result.

Another writer can append between the two transactions. Each fact is
validated alone against the state at its own append, so the interleave
is safe. If another failure with a different reason lands in between, the
fallback's `failureActionId` no longer names the current failure, and the
reducer refuses it. The record stays held.

A crash between the two appends leaves the record held. Recovery is a
repeat of the same publication (same conversation ID, same artifact
identity, version, and bytes). The artifact write is an idempotent
repeat. The failure write reuses its ID, and the fallback write then
succeeds. This also heals an existing record whose last failure is
`owner-unknown` from the ancestry defect: after section 8 ships, the
repeat produces a new `registration-missing` failure, and then the
fallback.

Healing fixes the hold, not the settings. Section 1 rule 4 keeps the
driver preference unchanged on a publication into an existing record. A
healed record that was created without `settings` therefore falls back
with the user-config defaults, unless the person already changed the
preference in Settings. The Settings control is the remedy for a model
mismatch. If the saved model is unavailable, managed preparation refuses
with `change-settings`.

A verified binding and a fallback can race on one never-bound record, for
example when an integrated session publishes into a record that a
non-integrated publisher created. The append lock orders them. The first
fact to commit decides, and the guard tables refuse the other: `bound`
after fallback is refused (section 3), and `publication-fallback` after
`bound` fails the `connection === null` row. Both outcomes are safe.

### 5. Admission after fallback, and what the connection panel shows

At the next admission check, `managedCandidates`
(`src/store/managed-readiness.ts:31`) no longer returns `[]` because of the
predicate. The remaining fences still apply unchanged:

- `state.holdRelease !== null` still holds the record.
- A managed attempt that ended with an `uncertain` outcome still holds the
  record (`src/store/managed-readiness.ts:40-44`).
- Every entry point still takes the presence lock and executor lease, and
  rechecks the predicate at attempt creation and at the dispatch boundary
  (RFC 26 F2, F4).

No managed attempt can be in flight when the fallback is written. Two
rules cover the two cases. An attempt that started before the
requirement is captured in `legacyDelivery` at the request transition
(`src/protocol/connection.ts:1024-1035`), and the guard row
`hasUnsettledPublicationDelivery(state) === false` refuses the fallback
until it settles. An attempt after the requirement cannot start: RFC 26
F2 and F4 recheck the predicate at attempt creation, executor
acquisition, and the dispatch boundary, and the predicate was true until
the fallback append. A pre-requirement attempt that ends `uncertain`
never retires its captured count, so that record stays held, as RFC 26's
no-reset rule requires.

Notes dispatch once each. A note saved before the fallback is a queued
input with no execution entry. After the fallback it becomes an eligible
managed candidate, like any queued input on an ordinary record. The input
ledger and delivery cursor that dispatch every ordinary input once also
govern these notes. A note saved after the fallback takes the same path.

The connection projection gains one state, `headless-fallback`.
`observeConnection` (`src/store/connection-view.ts:66`) checks
`nativePublication.fallback` first, before the `uncertainInputs` and
`inFlight` checks of its unbound branch, and returns directly. The order
is safe because the write-time guard requires settled legacy delivery,
and the captured counts cannot grow after the requirement:

- `state`: `headless-fallback`
- `reason`: `registration-missing`
- `message`: "No live session is connected. Notes get replies from a new
  headless session with this conversation's settings."
- `actions`: `[]`
- `nativeConnectionRequired`: `false`, from the predicate.

`awaitingNativeBinding` is false for a fallback record, because it calls
the predicate. `lucid connection status` returns the same projection.

RFC 26 section 8's status table gains one row: `headless-fallback`, "No
live session is connected; replies come from a new headless session",
no actions.

### 6. Skill and browser

The skill (`~/dev/skills` source for `~/.agents/skills/lucid`) replaces
"Other ordinary native interfaces have no enabled authoring integration
yet" with this rule. An interface with no integration MAY publish through
the CLI. The request MUST carry `settings` for its own harness and model,
and `workingDirectory` for its current folder. It SHOULD carry `origin`
when the harness exposes those values. The reply tells the person that a
new headless session on the same model answers notes, not the live
session.

Browser: when the connection state is `headless-fallback`, the connection
panel is hidden (as for any ordinary managed record), and the chat input
works. A label near the input reads:

> Replies come from a new headless {harness} / {model} session. [?]

`{harness}` and `{model}` come from `savedPreference`. The `?` control
opens an accessible tooltip on hover and keyboard focus. It says that the
session that published this artifact has no Lucid integration, so Lucid
cannot send notes back into it, and that the Settings control changes the
model.

### 7. Fresh headless sessions get a pointer to the origin transcript

A fallback record has no native session to resume. Until RFC 28 lands, a
headless turn starts a new session on the saved driver preference in the
record's working folder.

When managed preparation starts a **fresh** native session (the
dispatch's native intent is not `resume`,
`src/modes/managed-preparation.ts:224-227`) and record metadata has
`origin.sessionFile`, the `reference` block
(`src/modes/managed-preparation.ts:331-341`) gains one line, after the
fresh-attempt note and before the context reading command:

> This conversation began in a {origin.harness} session. Its transcript is
> at {origin.sessionFile}. Read it only if the note needs earlier context.

`{origin.harness}` is "native" when absent. The rule is based on the
native intent, not on a turn count, so a later `continue-fresh` also gets
the line. A resumed turn does not. When `origin` or `sessionFile` is
absent, the line is omitted and nothing fails.

The line is a pointer, not a payload. Lucid does not read, copy, or
size-check the file. The file can be large, so the line tells the agent to
read it only when the note needs it. A missing file at read time, for
example in a record copied to another machine, is the agent's normal tool
failure.

### 8. Registration check reports the right reason

`callerAncestryOwns` changes how it handles an ancestor that
`readProcessOwner` cannot read:

1. On Darwin, a new parent-only probe reads `proc_pidinfo` with flavor
   `PROC_PIDT_SHORTBSDINFO` (13, 64 bytes, parent PID at offset 4).
   Measured on this machine on 2026-09-27: it returns `872 → 741` for the
   root-owned `/usr/bin/login`, where `PROC_PIDTBSDINFO` fails. It returns
   0 bytes for a PID that does not exist.
2. When `readProcessOwner(pid)` returns `undefined`, the walk calls the
   parent-only probe. On success it continues from the parent PID. The
   unreadable process itself MUST NOT match a registered owner: a match
   still needs PID, start time, and executable.
3. The walk returns `undefined` only when the parent-only probe also
   fails, a cycle occurs, or the 64-step depth limit is reached.
4. A walk that ends at PID 1 with no match returns `false`.

Trust assumption. A registered owner is always fully readable by the
publishing user. Registration corroborates the owner's PID, start time,
and executable at write time (`src/store/native-registration.ts:235-239`),
and the registration store is private to the same user
(`src/store/native-registration.ts:131-138`). So a process the walk cannot
read fully cannot be a registered owner, and skipping it cannot hide a
match. If an owner process becomes unreadable after registration, the
walk now passes through it and returns `false` for that registration,
where it returned `undefined` before. The caller then gets
`registration-missing`, and section 2 can fall back. That case needs a
registered owner to change user or privilege, which Claude Code and Codex
do not do.

On Linux the parent-only probe reads field 4 of `/proc/<pid>/stat`, which
is readable for processes of every user, where `readlink
/proc/<pid>/exe` fails for a root-owned process. On other platforms the
probe returns unknown, and the walk keeps its current behavior: a caller
with an unreadable ancestor stays `owner-unknown` and held.

## Amendments to RFC 26

This RFC changes these RFC 26 v9 sentences for the `registration-missing`
case only. Every other RFC 26 rule stays normative.

1. "There is no clear-requirement or convert-to-managed action in this
   amendment." `publication-fallback` is a convert-to-managed fact,
   limited to `registration-missing` failures on never-bound records.
2. F1: "The wire bodies are exactly `publication-requested` and
   `publication-connection-failed`." A third body, `publication-fallback`,
   is added. `NativePublication` gains `fallback`.
3. F2: "`requiresNativeConnection(state)` ... is true exactly when
   `state.nativePublication !== null || state.connection !== null`." The
   predicate gains the `fallback === null` term.
4. "Saved preference never selects this state." After fallback, the saved
   preference selects the driver, because the record is managed.
5. F6: "Unbound required records use `setup-required`." A fallback record
   uses `headless-fallback`, with `nativeConnectionRequired: false`.
6. Section 8 status table: the `headless-fallback` row is added.
7. "Only verified binding admits the already specified native continuation
   workflow." Unchanged for native continuation. Fallback admits managed
   dispatch, not native continuation.
8. F1: distinct failed attempts "replace only the latest failure
   projection, including after binding." After fallback, a new
   `publication-connection-failed` is refused (section 3 rule 2).
9. Section 8's "Publication succeeded, integration missing" row now
   applies only to failure reasons other than `registration-missing`, or
   to a `registration-missing` hold whose fallback was refused. Such
   holds include `owner-unknown`.

## State Machine

```
requested ──failure(registration-missing)──> held ──publication-fallback──> fallback (terminal)
    │                                         │
    │                                         └──(crash before fallback)──> held; repeat publication retries
    ├──failure(any other reason)──> held (RFC 26, unchanged)
    └──bound──> bound (RFC 26, unchanged)

fallback: bound refused; failure refused; requested repeat is a no-op.
```

## Error Handling

- The failure append fails: RFC 26 F7 applies unchanged, and no fallback
  is attempted.
- The fallback append is refused or fails after the failure is stored: the
  record stays held. The command returns the failure result with
  `persistence: saved`. Its message adds that the headless fallback did
  not save and that repeating the same publication retries it.
- `origin` is invalid: the command refuses with `E-HUB-03` before any
  durable write.
- The saved model is unavailable at dispatch: the existing managed
  preparation refusal applies and shows `change-settings`.
- A pre-amendment reader folds a fallback record: it refuses the unknown
  kind with `invalid-connection`, as RFC 26 F5 requires. No downgrade
  conversion exists.

## Security Considerations

- `registration-missing` proves that no verified registration is an
  ancestor of the caller. It does not prove that no live native session
  exists. One false-fallback case remains: a session with a working
  integration that publishes before its registration is written. Claude
  Code and Codex register at session start through their hooks, before the
  model can run a command, so the window is the hook's own startup. If it
  occurs, the record falls back and its notes go to a headless session and
  not to the live session. The notes are not lost, and no second native
  process receives them. A second case has the same shape: registration
  lookup unlinks a registration whose owner probe reads as confirmed
  absent (`src/store/native-registration.ts:269-274`). A false absent
  reading, for example after PID reuse, removes a live session's
  registration, and its next publication falls back. Recovery: the person publishes again from the
  live session into a new conversation. This RFC accepts that residual
  risk. The alternative keeps every non-integrated publication in a dead
  end.
- Fallback cannot start a second writer for a live native session. A
  never-bound record has no native session attached, and rule 1 of section
  3 refuses a later binding.
- The parent-only probe reads one PID and grants no match authority
  (section 8).
- `origin.sessionFile` is a path that the publisher chose. Lucid never
  opens it. The headless agent reads it with its own tool permissions in
  the same account, which is the same access the publisher had. Record
  copies carry the path. On another machine it fails as a missing file.
- The trust boundary is unchanged: one person on one machine, local
  filesystem access (RFC 32).

## Alternatives Considered

- **A "continue headless" button in the setup panel.** It keeps the dead
  end as the default and puts an unexplained decision in front of a
  first-time reader. The `registration-missing` case has one correct
  answer, so the fallback is automatic.
- **Re-arm the requirement on a later publication (v1).** It conflicted
  with the second-request refusal and with RFC 26 binding guards once
  managed history exists. Section 3 makes fallback terminal.
- **Heal held records on a status read.** A status read is a read of
  durable facts with no writes (RFC 26 F7). Healing uses a repeat
  publication instead (section 4).
- **Treat the saved preference as the exit.** ADR 0009 forbids a
  preference that changes execution state, and RFC 26 rejected it.
- **Read the producer's model from the Pi session file.** That re-derives
  harness behavior in Lucid, which ADR 0005 forbids.
- **Resume the original Pi session headlessly.** RFC 28 is blocked on the
  native strict-open race.

## Implementation Plan

Each unit has an observable outcome before the next unit depends on it.

1. **Probe.** Parent-only probe and walk change (section 8). Test with an
   injected probe that has an unreadable ancestor, and confirm that the
   live Pi ancestry returns `false`.
2. **Protocol.** `publication-fallback` parse, reducer table, `fallback`
   field, predicate, terminal rules, and the `headless-fallback`
   projection (sections 2, 3, 5).
3. **Publish path.** `recordPublicationFallback`, `saveConnectionFailure`
   ordering, `connectPublication` short-circuit, `origin` validation and
   metadata (sections 1, 4).
4. **Managed context.** The origin line on fresh dispatch (section 7).
5. **Browser.** Label and tooltip, verified at 390, 768, and 1440 pixels
   in both themes (section 6).
6. **Skill.** Update in `~/dev/skills`, then its link script.
7. **Live confirmation.**
   a. A fresh publication from an interactive Pi session with declared
      `pi / zai / glm-5.3` settings falls back, and a browser note gets a
      reply from a headless turn on those settings in the publisher's
      folder.
   b. A repeat publication into record `40cf7112` falls back and keeps
      that record's saved preference. That record's preference is already
      `pi / zai / glm-5.3`, because the person changed it in Settings.

## Acceptance

- The Pi-under-`login` ancestry returns `false`, and publication reports
  `registration-missing`.
- Fallback is written only for `registration-missing` on a never-bound
  record with no unsettled publication delivery. Each other reason, a
  bound record, and an uncertain legacy delivery keep the hold.
- A fallback whose `failureActionId` is not the current failure is
  refused.
- After fallback: `bound` is refused, a new failure is refused, and a
  repeated `publication-requested` is a no-op.
- A crash between the failure and the fallback leaves the record held. A
  repeat publication writes the fallback.
- A note saved before the fallback and a note saved after it each dispatch
  once.
- An uncertain managed outcome still holds a fallback record.
- The projection for a fallback record is `headless-fallback`,
  `nativeConnectionRequired: false`, actions `[]`.
- A fresh dispatch with `origin.sessionFile` includes the origin line. A
  resumed dispatch does not. A record without `origin` dispatches without
  the line.
- A publication into an existing record does not change the driver
  preference or `origin`, and an invalid `origin` on it is ignored.
- The pre-amendment reader refuses a fallback record on fold.
- The existing RFC 26 acceptance suite passes unchanged.

## Open Questions

1. Can hcn report the model, provider, and native session file of the
   calling session, so the skill copies values and does not recall them?
   Not blocking: the skill can read them from the harness where it
   exposes them.
2. Should the tooltip link to Pi integration status (RFC 28)? Not
   blocking.

## Response to v1 review

Every finding in
[review v1](34_unbound-publication-headless-fallback.review-v1.md) is
answered here.

| Finding | Disposition |
|---|---|
| R34-01 `released` field missing, name collides with `hold-released` | Applied. Fact `publication-fallback`, field `NativePublication.fallback`, exact shapes in section 2. `holdRelease` untouched. |
| R34-02 re-arm conflicts with second-request refusal; repeat rules underived | Applied. Re-arm removed; fallback is terminal (section 3). Action ID derivation and repeat rules in section 4. |
| R34-03 "same transaction" is false | Applied. Two ordered appends, interleave and crash analysis in section 4. |
| R34-04 `registration-missing` overstates the signal | Applied. Claim narrowed; false-fallback case, window, and recovery in Security. |
| R34-05 guard set vacuous and incomplete | Applied. Reconnect guard dropped; F2/F4 cited; surviving fences listed in section 5. |
| R34-06 request schema and writer path misdescribed | Applied. Section 1 names `origin` as the only new field and `createConversationRecord` as the writer. |
| R34-07 RFC 26 amendments not listed | Applied. New "Amendments to RFC 26" section. |
| R34-08 probe trust assumption unstated | Applied. Section 8 states it, with the measured probe. |
| R34-09 origin line undermarked | Applied. Section 7: fresh-intent rule, bounds in section 1, placement, absent-origin rule, size note. |
| R34-10 once-each dispatch argument missing | Applied. Section 5. |
| R34-11 projection state needs a mapping | Applied. Section 5, and the RFC 26 table row. |
| R34-12 residual defaults | Applied. Section 1 rule 2. |
| R34-13 driver-preference comment | Applied. Section 1 rule 7. |
| R34-14, R34-15 ADR consistency | No change needed; fencing sentence kept in section 1 rule 6. |
| R34-16 Open Question 3 should be decided | Applied. Repeat publication heals (section 4); status-read healing rejected in Alternatives. |
| R34-17 copied-record portability | Applied. Section 7 and Security. |

## Response to v2 review

Every finding in
[review v2](34_unbound-publication-headless-fallback.review-v2.md) is
answered here.

| Finding | Disposition |
|---|---|
| R34-18 healing fixes the hold, not the settings; plan step 7 | Applied. Section 4 states it; plan step 7 split into a fresh publication and a repeat publication. |
| R34-19 prune path is a second false-fallback vector | Applied. Security, first bullet. |
| R34-20 section 5 credits F2/F4 for the legacyDelivery guard | Applied. Section 5 names both cases and the uncertain-count consequence. |
| R34-21 origin validation on existing-record publishes | Applied. Section 1 rule 5: validated only on creation. Rule 6 records the storage location as implemented. |
| R34-22 F1 sentence and old section 8 row | Applied. Amendments 8 and 9. |
| R34-23 Linux keeps the defect | Applied. Linux gets a `/proc/<pid>/stat` parent read; other platforms stay held, stated. |
| R34-24 check order in `observeConnection` | Applied. Section 5. |
| R34-25 bind-versus-fallback race | Applied. Section 4. |

## References

Normative:

- RFC 26: interactive artifact conversation continuity, v9 native
  publication amendment.
- ADR 0005: hcn owns harness differences.
- ADR 0009: a preference is not an event or a claim about reality.

Informative:

- RFC 28: Pi native extension bridge (parked).
- RFC 30: native feedback context by reference.
- RFC 32: any-session handoff to Lucid (trust boundary).
- Record `40cf7112-6dab-485b-b099-e1b306570dac`, the observed failure
  (local machine only; the facts are quoted in the Introduction).

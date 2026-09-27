---
number: 34
title: "Unbound publication falls back to headless with the producer's settings"
type: feature
status: Draft
author: "Claude Opus 5.5"
date: 2026-09-27
version: 1
---

# RFC-34: Unbound publication falls back to headless with the producer's settings

## Abstract

An agent session with no Lucid integration can publish an artifact through
`lucid artifact publish`. The publication records a native requirement,
binding fails, and the record then holds every browser note forever. No
action releases the hold, and the saved driver preference cannot select a
driver for it. The record also takes the built-in `claude` / `opus`
defaults, because the publisher did not declare its own settings. This RFC
makes three changes. The publisher declares its harness, model, and working
folder. A publication whose binding fails because no integration exists
releases the native requirement, so browser chat runs as an ordinary
headless conversation on the declared settings. The native registration
check stops reporting "could not be verified" when the real result is "not
registered".

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

Three separate defects produce this result:

- **The hold has no exit.** RFC 26 v9 makes `requiresNativeConnection`
  true for any record with `nativePublication !== null`. It defines no
  clear-requirement or convert-to-managed action, and it states "Saved
  preference never selects this state." Pi has no integration (RFC 28 is
  parked), so the record can never bind.
- **The record takes the wrong settings.** `publishArtifact` uses
  `readUserConfig().defaults` when the request has no `settings` field
  (`src/cli/artifact-publish.ts`). The built-ins are `claude` / `opus` /
  `high` (`src/config/user-config.ts`). The request also sent
  `workingDirectory: null`, so the record uses a managed workspace inside
  the record folder and not the folder the artifact came from.
- **The failure reason is wrong.** The caller was not registered. The
  result should be `registration-missing`. `callerAncestryOwns` walks the
  caller's parent processes for each live registration. The Pi process
  descends from `/usr/bin/login` (pid 872), which root owns.
  `proc_pidinfo` cannot read it, so the walk returns `undefined` for every
  registration. Three live Claude Code registrations exist on the machine,
  so `withNativeRegistration` reports `owner-unknown`. Every session
  started in a Ghostty terminal has this ancestry.

The Lucid skill tells an interface with no integration not to publish.
The Pi session published anyway. A skill instruction does not hold at the
boundary, so the fix belongs in the publish path.

The person using this is the reader who annotates agent-authored artifacts
(`CONTEXT.md`). Lucid's purpose is to route a live agent conversation into
a durable record and back to that reader. A record that accepts notes and
never answers them breaks that purpose. This RFC narrows a dead end. It
adds no new interface support and holds scope.

Out of scope, with reasons:

- Pi native integration. RFC 28 owns it. When a Pi binding exists, RFC 26
  continuation applies and this fallback does not fire.
- Resuming the original native session headlessly. It needs a strict
  session locator, which RFC 28 has not settled.
- Transcript import. RFC 26 ruled it out. Section 3 passes a pointer only.
- Records held for any reason other than a missing registration. Those
  holds protect a session that may be alive, and RFC 26 keeps them.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD
NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted
as described in RFC 2119.

- **Native requirement**: RFC 26's `nativePublication` state. It holds
  queued input until a verified binding exists.
- **Unbound publication**: a publication whose binding attempt failed.
- **No-integration failure**: a binding failure with reason
  `registration-missing`. The calling process descends from no live
  registered native owner. This class excludes `owner-unknown`,
  `native-identity-conflict`, `registration-store-unavailable`,
  `registration-busy`, `stale-registration`, and
  `connection-result-unrecorded`.
- **Release**: a durable fact that ends a native requirement which never
  bound.
- **Producer settings**: the harness, provider, model, effort, and profile
  that the publishing session declares for itself.
- **Origin**: the publishing session's declared harness, native session ID,
  and native session file, recorded as unverified provenance.

## Motivation

Every interactive session that is not a registered Claude Code or Codex
CLI session produces this dead end when it publishes: Pi, Muse, Cursor,
and any delegated worker. The reader sees a working chat input, types a
note, and gets "Saved" with no answer and no action that changes it. The
Settings panel offers a model choice that does nothing. From the reader's
side, the product is broken, and nothing on the page says why.

Upkeep after this ships: one fact kind in the connection reducer, one
predicate term, one metadata field, one probe fallback, and one label. The
existing managed dispatch path does the execution. That upkeep is small
against a failure that affects every non-integrated publisher.

## Design

### 1. The publisher declares producer settings, working folder, and origin

The publication request gains one optional object and uses two existing
fields:

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

1. `settings` keeps its existing `settingsShape` validation. On creation,
   Lucid writes it as the creation settings (as today) and also as the
   initial driver preference at revision 1, through the existing
   `driver-preference` writer. Managed preparation reads the driver
   preference (`src/modes/managed-preparation.ts`), so this is the value a
   later headless turn uses.
2. When `settings` is absent, current behavior holds: user-config defaults.
   The skill change in section 5 makes the field normal for agent callers.
3. Lucid MUST NOT infer settings from artifact text, the process table, or
   harness session files. ADR 0009 governs: the declaration is a
   preference, not a claim about what ran. The log records what ran.
4. `settings` applies only on creation. A publication into an existing
   conversation MUST NOT change the driver preference. The person's choice
   in Settings wins after creation.
5. `workingDirectory` keeps its existing validation. The skill sends the
   publisher's current folder.
6. `origin` is optional. Every field is optional, bounded, and free of
   control characters. `sessionFile` MUST be absolute. Lucid stores
   `origin` in record metadata beside `creation.request`. It is provenance
   only. It grants no execution authority, selects no harness, and is
   never passed to hcn as a resume target.

### 2. A no-integration failure releases the native requirement

The connection protocol gains one fact on the existing envelope
`{v: 1, src: "execution", payloadVersion: 2, at, connection: body}`:

```json
{ "kind": "publication-released", "actionId": "<uuid>", "failureActionId": "<uuid>" }
```

Rules:

1. `connectPublication` appends `publication-released` in the same host
   connection transaction as the failure, and only when all of these hold:
   - the failure reason is `registration-missing`;
   - `state.connection === null` (never bound);
   - `hasUnsettledPublicationDelivery(state)` is false;
   - no reconnect reservation exists.

   Any other failure keeps the RFC 26 hold unchanged.
2. The reducer requires a current `publication-requested` and a matching
   `publication-connection-failed` whose `actionId` equals
   `failureActionId`. It sets `nativePublication.released =
   {actionId, failureActionId, at}`. An identical repeat changes nothing.
   A reused ID with different content gets `connection-conflict`.
3. `requiresNativeConnection(state)` becomes:

   ```ts
   state.connection !== null ||
     (state.nativePublication !== null && state.nativePublication.released === null)
   ```

   Every RFC 26 admission check uses this predicate, so a released record
   is an ordinary managed record. Queued input becomes a managed candidate
   at the next admission check. The existing presence lock, executor lease,
   and dispatch-boundary rechecks apply unchanged.
4. A later publication into a released record appends a new
   `publication-requested`. That fact clears `released` and re-arms the
   requirement, because a new publisher may have an integration. If that
   binding succeeds, RFC 26's native flow governs. If it fails with a
   no-integration failure, rule 1 releases it again.
5. Release clears nothing else. Failure history, artifacts, inputs, and
   the driver preference stay unchanged.
6. The record now contains a new fact kind inside payload version 2. A
   pre-amendment reader refuses it on fold with `invalid-connection`, the
   same as the RFC 26 F5 behavior. The released record needs a supporting
   reader. No downgrade conversion exists.

The new fact is necessary for this reason. RFC 26 records the requirement
before the artifact write and before registration lookup, so a crash
cannot leave queued input dispatchable. This RFC keeps that order. The
requirement exists for the whole publication, and the release is a
separate, later, durable decision.

### 3. The first headless turn knows where the conversation began

A released record has no native session to resume. Until RFC 28 lands, the
first headless turn starts a **new session** on the producer settings. It
runs in `workingDirectory`, with the artifact and the note as context.

When `origin.sessionFile` exists, the first managed dispatch context adds
one reference line:

> This conversation began in a {harness} session. Its transcript is at
> {sessionFile}. Read it only if the note needs earlier context.

The reference is a pointer, not a payload. Lucid does not read, copy, or
size-check the file. RFC 30's offered-copy mechanism is not used, because
this is a managed dispatch and not a native offer. A missing file at read
time is the agent's normal tool failure. Later turns resume the managed
session that the first turn created, and they do not repeat the line.

### 4. Registration check reports the right reason

`callerAncestryOwns` changes how it handles a process it cannot read:

1. The walk reads each ancestor with `readProcessOwner`. When that returns
   `undefined`, the walk reads only the parent PID with a parent-only probe
   (`sysctl` `KERN_PROC_PID` / `kinfo_proc`). `ps -o ppid= -p 872` returns
   `741` in the observed case, so the kernel exposes the parent PID of a
   root-owned process to this user.
2. A process that the walk cannot read fully MUST NOT match a registered
   owner. An owner match still needs PID, start time, and executable.
3. The walk returns `undefined` only when the parent-only probe also fails,
   a cycle occurs, or the depth limit is reached.
4. A walk that ends at PID 1 with no match returns `false`. With no
   `undefined` results and no match, `withNativeRegistration` reports
   `registration-missing`, and section 2 applies.

A registered Claude Code or Codex session is unaffected. Its walk reaches
the owner before it reaches `login`.

### 5. Skill and UI

The skill (`~/dev/skills` source for `~/.agents/skills/lucid`) replaces
"Other ordinary native interfaces have no enabled authoring integration
yet" with this rule. An interface with no integration MAY publish through
the CLI. The request MUST carry `settings` for its own harness and model,
`workingDirectory`, and `origin` where the harness exposes it. The reply
tells the person that notes get an answer from a new headless session on
the same model, not from this live session.

Browser, for a released record: the connection panel shows no setup
state. The chat input works. The label near the input reads:

> No live session is connected. Replies come from a new headless
> {harness} / {model} session. [?]

The `?` tooltip explains that the publishing session has no Lucid
integration, so Lucid cannot deliver notes back into it. It names the
Settings control that changes the model. `lucid connection status` returns
a new state `released`, reason `registration-missing`, actions `[]`, and
`nativeConnectionRequired: false`.

## State Machine

```
publication-requested ──fail(registration-missing, guards pass)──> released
        │                                                           │
        ├──fail(other reason)──> held (RFC 26, unchanged)           │
        └──binding verified────> bound (RFC 26, unchanged)          │
released ──publication-requested──> requested (re-armed) ───────────┘
```

## Error Handling

- The release append fails after the failure fact was stored: the record
  stays held. The command returns the failure with `persistence: saved`
  and a message that the release did not save. Repeating the same
  publication retries the release under the host transaction.
- The failure append fails: RFC 26 F7 applies unchanged, and no release is
  attempted.
- The settings declaration is invalid: the command refuses with
  `E-HUB-03` before any durable write, as `settingsShape` does today.
- The declared model is unavailable at dispatch: the existing managed
  preparation refusal applies and shows `change-settings`.

## Security Considerations

- Release weakens nothing that protects a live session. A no-integration
  failure means no live registration is an ancestor of the caller, so no
  native session exists that could also receive the input. `owner-unknown`
  and conflicts still hold.
- The parent-only probe reads a PID and nothing else. It creates no match
  authority.
- `origin.sessionFile` is a path that the publisher chose. Lucid never
  opens it. The headless agent reads it with its own tool permissions in
  the same account, which is the same access the publisher had.
- The trust boundary is unchanged: one person on one machine, local
  filesystem access (RFC 32).

## Alternatives Considered

- **A "continue headless" button in the setup panel.** It keeps the dead
  end as the default and puts an unexplained decision in front of a
  first-time reader. The no-integration case has one correct answer, so
  the fallback is automatic.
- **Treat the saved preference as release.** ADR 0009 forbids a preference
  that changes execution state, and RFC 26 rejected it.
- **Read the producer's model from the Pi session file.** That re-derives
  harness behavior in Lucid, which ADR 0005 forbids. If hcn gains an
  operation that reports a session's model, the skill can use it (Open
  Question 1).
- **Resume the original Pi session headlessly.** RFC 28 is blocked on the
  native strict-open race. This RFC gives that path its upgrade point: when
  a Pi binding exists, RFC 26 continuation applies and no release occurs.

## Implementation Plan

1. Protocol: the `publication-released` fact, the reducer, the predicate
   change, and the `released` projection state. Fake-hcn oracle for each
   case in Acceptance.
2. Registration: parent-only probe and ancestry walk change. Tests use an
   injected probe with an unreadable ancestor.
3. Publish: `settings` → driver preference on creation, and `origin`
   metadata.
4. Managed context: the origin reference line on the first dispatch.
5. UI: connection panel, chat label, and tooltip. Verify at 390, 768, and
   1440 pixels in both themes.
6. Skill update in `~/dev/skills`, then its link script.
7. Live confirmation: an interactive Pi session publishes, a browser note
   gets an answer from a headless `pi / zai / glm-5.3` turn in the
   publisher's folder.

## Acceptance

- The Pi-under-`login` ancestry reports `registration-missing`, not
  `owner-unknown`.
- Release happens only for `registration-missing` with all guards passing.
  Each excluded reason and each failed guard keeps the hold.
- A released record dispatches a note saved before release and a note
  saved after it, once each.
- A crash between the failure fact and the release leaves the record held.
  A repeat publication releases it.
- A publication into a released record re-arms, and then binds or releases
  again.
- Creation writes the declared settings as driver preference revision 1.
  A later publication into the record does not change the preference.
- The first dispatch includes the origin line. The second does not.
- The pre-amendment reader refuses a released record on fold.
- The existing RFC 26 acceptance suite passes unchanged.

## Open Questions

1. Can hcn report the model, provider, and native session file of the
   calling session, so the skill copies values and does not recall them?
2. Should the tooltip link to Pi integration status (RFC 28) so the reader
   can see when same-session replies become possible?
3. Should an existing held record with only no-integration failures
   release on its next status read, or only on a new publication? This
   draft requires a new publication. Record `40cf7112` would need one
   republish.

## References

Normative:

- RFC 26: interactive artifact conversation continuity, v9 native
  publication amendment.
- ADR 0005: hcn owns harness differences.
- ADR 0009: a preference is not an event or a claim about reality.

Informative:

- RFC 28: Pi native extension bridge (parked).
- RFC 30: native feedback context by reference.
- Record `40cf7112-6dab-485b-b099-e1b306570dac`, the observed failure
  (local machine only; the facts are quoted in the Introduction).

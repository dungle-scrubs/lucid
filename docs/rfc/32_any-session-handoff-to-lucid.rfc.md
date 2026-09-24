---
number: 32
title: "Any-session handoff to Lucid"
type: feature
status: Accepted
version: v2
author: "Kevin Frilot"
date: 2026-09-24
---

# RFC-32: Any-session handoff to Lucid

## Abstract

A plain agent session, one with no Lucid record and no protocol marker,
cannot publish a document or meet its reader in the browser today. This
RFC defines one local operation that closes that gap: a handoff command
that takes artifact bytes plus continuation text, creates a Lucid record,
attaches its invoker as the source, and holds that source through a
review window so browser chat reaches the invoker's session. The remote
origin supplies text and receives back the artifact URL; it never
attaches, never writes, and never receives annotations. All verification
stays on-machine under the existing filesystem-access boundary.

## Introduction

Lucid owns the record first and the agent attaches to it. Supported
starts are `lucid chat`, `lucid run`, the serve hub plus a managed
worker, and native Codex CLI or Claude Code sessions with hooks setup.
A session that started anywhere else, an API thread with a folder
attached, a headless run Lucid did not start, has no record, no secret,
no epoch, and no binding. Its prompt carries no `[lucid artifact
protocol]` marker, so the authoring skill forbids the artifact fence and
the session answers in plain chat.

This RFC covers the path from such a session to a Lucid record: the
payload it supplies, the local command that creates the record, the
trust boundary around that creation, and the hold window that keeps the
source attached for review. It does not cover transcript import, dual
live writers, Lucid pulling a live session, or multi-user operation.

Out of scope, with reasons:

- Full transcript import. RFC 26 ruled importing unrelated native
  history out of scope. This RFC moves a continuation summary, not
  replayed events.
- Dual live writers. One conversation holds one active source under
  epoch fencing. The hold keeps exactly one holder.
- Lucid pulling a live session. The handoff starts when the invoker
  runs the command, never by Lucid attaching outward.
- Multi-user or remote operation. Lucid serves one person on one
  machine; the trust boundary in this RFC depends on that.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD,
SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be
interpreted as described in RFC 2119.

Use the existing conversation, record, log, source, artifact, input,
executor lease, presence lock, epoch, and driver preference terms from
CONTEXT.md.

- **Origin**: the plain session that wants a Lucid record. It holds no
  record, no secret, and no epoch. It supplies text and receives the
  artifact URL. It never attaches.
- **Invoker**: the local process that runs the handoff command under
  the user's filesystem access. It creates the record, attaches as its
  source, and holds the executor lease through the review hold.
  Browser chat reaches this session, never the origin.
- **Handoff command**: the local CLI operation this RFC defines. It
  takes a request file, creates the record, and attaches its invoker.
- **Continuation input**: the single accepted prompt carried in the
  handoff request. It holds the current task, key decisions, and
  pending inputs as plain text. Running the command authorizes it as
  the record's first task.
- **Review hold**: the interval after publish during which the invoker
  stays attached and browser chat reaches it. It ends by detach or
  timeout.

## Motivation

The observed failure: a graybox API thread was asked for a Lucid
walkthrough, refused correctly under the skill (no marker, no fence),
and wrote a Markdown substitute with no record behind it. A
deep-research thread started through Lucid published a real document
the same day. Same skill, same rules, different start path, different
result. The wayfinding map
([#299](https://github.com/dungle-scrubs/lucid/issues/299)) resolved
six decision tickets to one result: any plain thread supplies text, one
local command creates the record and attaches, the source holds through
a review window, then detaches. This RFC renders those decisions.

## Design

### 1. Payload

The handoff request MUST contain exactly these fields:

- `creationId` XOR `conversationId`: a wire-valid id for a new
  record, or the id of an existing record, with the same semantics as
  publication (`src/cli/artifact-publish.ts`). Both MUST NOT be
  present. For an existing record the continuation MUST carry an
  `inputId` not already present, else `input-id-reused`.
- `serverUrl`: the local Lucid server origin at
  `http://127.0.0.1:<port>`, validated as publication validates it.
- `artifact`: `artifactId` valid per `validArtifactId`,
  `contentType: "text/html"`, complete HTML bytes with one inline
  stylesheet, `version: 1` for a fresh handoff. Length MUST NOT exceed
  1,000,000 UTF-16 code units (the unit the host actually compares;
  see finding F9). Oversize MUST be refused, never truncated.
- `continuation`: `{ inputId, text }`. The text holds the current
  task, key decisions, and pending inputs. Length MUST NOT exceed
  1,000,000 UTF-16 code units. It becomes the record's first pending
  input and dispatches through the normal queue boundary. Running the
  command authorizes it as a task; it is not quoted reference
  material.
- `workingDirectory`: an absolute path or null, validated as
  publication validates it today: absolute, no control characters.
- `settings` (optional): the harness, model, effort, and profile
  bundle per `settingsShape`. When omitted, user defaults apply.

Retry equality: a retry sharing a `creationId` MUST be byte-identical
in artifact bytes, continuation `inputId` and text, settings, and
working directory, and MUST return the same conversation id. Any
difference MUST be refused as a conflicting request; it MUST NOT
create a second record. This matches existing creation idempotency
(`docs/architecture.md`).

The request MUST NOT contain transcript history, a foreign native
session id, or credentials. `projectConversationContext` projects
history only from the record's own log; session recall resumes only
sessions the record itself minted. A foreign session id MUST never be
resumed.

### 2. Command

The handoff command, `lucid handoff --request FILE [--json]`, takes
the JSON request file and runs this ordered protocol:

1. Create the record shell through the existing atomic staging
   rename (metadata, settings, log, and secret publish together or
   not at all).
2. Acquire the record's presence lock in the command process and
   retain it across attach, so no managed worker can win the gap
   between creation and attach.
3. Append the artifact version, then append the continuation input.
4. Attach as source through the ordinary `openDrivenConversation`
   path: `attach` mints epoch 1 and becomes executor.
5. Print the artifact URL.

The handoff path MUST NOT record the native-publication requirement
(`recordNativePublication`). That requirement fences records awaiting
a native binding; a handoff record has no native binding coming, and
its continuation input is a legitimate ordinary candidate. Presence
held by the command across steps 2 to 4 is the race guard, not an
admission fact. If the invoker never arrives (crash between steps 1
and 4), ordinary eligibility applies: a managed worker MAY dispatch
the continuation. That fallback is intended.

Commit boundary and crash recovery:

- Crash before step 3 finishes: a held draft with no artifact
  version. A retry with the same creation key resumes it.
- Crash after the artifact append but before attach: the record is
  readable with a queued continuation and no source
  (PUBLISHED_UNATTACHED in the state machine). A later local attach
  adopts it, or managed dispatch proceeds.
- Crash after attach but before URL output: the attached record
  exists. The URL is re-derivable from the conversation id, which
  the retry returns.

The command MUST wait for creation and print exactly one of:

- success: the artifact result plus the artifact URL; or
- failure: the refusal reason, with nothing half-made beyond the
  recovery states above.

Artifact and continuation results are reported separately, mirroring
the publication/connection separation: saved artifact success can
coexist with a held continuation, and the command MUST say so rather
than merging the two.

Refusal reasons MUST reuse the existing vocabulary: E-HUB-01
(availability), E-HUB-02 (conflicts), E-HUB-03 (bad request), E-HUB-04
(folder), E-HUB-06 (context preparation held),
`registration-missing` where a native binding was expected. No new
error family is introduced.

### 3. Attach

The new record starts sourceless: no source, no epoch, no lease
holder. The invoker attaches fresh: `attach` mints epoch 1, acquires
the presence lock, and becomes executor. No transfer protocol is
needed because the origin holds nothing to transfer.

A second attach while presence is held MUST be refused `lease-held`.
Detach uses the existing frame: `detach { epoch, reason: yield |
shutdown }` at a turn boundary.

Attempt outcome distinguishes two cases that input ids alone cannot:

- Never-dispatched input: no `attempt-started` fact exists. The input
  stays queued and redelivers safely on next attach.
- Uncertain attempt: `attempt-started` exists without terminal
  evidence (`deriveAttemptOutcome` classifies this `uncertain`).
  Automatic dispatch stays blocked; recovery needs explicit fresh
  authorization through the existing execution-recovery path, never
  silent replay.

If the holder dies without detach, the kernel releases presence; the
next attacher takes over, the epoch increments, and the dead writer is
fenced `stale-epoch`.

### 4. Review hold

After publish the invoker MUST stay attached for 30 minutes past its
last activity unless configuration sets another value. The idle clock
resets only on durable log appends: a dispatched input applied, or a
lossless event emitted. Heartbeats MUST NOT reset it. Preparation
counting as busy inside the current worker is an implementation
detail; the hold tracks appends, not busy-state.

The hold ends by:

- the user's explicit detach command naming the exact conversation:
  new inputs are refused or held at once, and the source detaches at
  the turn boundary. If the turn does not end within the abort grace
  bound, the worker aborts and the reason is `shutdown`, not
  `yield`; or
- timeout with no active turn: detach at once with `yield`. With an
  active turn: the same boundary path as explicit detach.

At timeout the record MUST stay readable. Later input resumes under
these conditions: when the holder was a non-native source, ordinary
redelivery applies; when the holder was native-bound, the RFC 26
section 6 admission applies (confirmed owner departure, exact
identity and folder, eligible input, no conflicting reservations).
"Gone" in the browser describes the local holder (presence released),
never a claim about a native session. No new record is created.

This is a parameter change on `runManagedWorker`
(`src/cli/managed-worker.ts`, `idleMs` default 3000 ms) plus
append-based idle tracking, heartbeat retention, and one projection
state, not a new mechanism. The countdown state derives from
`lastActivity + holdMs - now`, read from durable log facts.

### 5. Browser state

While held, the connection panel MUST show the session connected and
listening plus the remaining hold time. At timeout it MUST show the
session gone with reconnect instructions. While detaching it MUST
show detach in progress. This extends the connection projection table
(RFC 26 section 8) with hold states; no other labels change.

## State Machine

```
SOURCLESS → PUBLISHED_UNATTACHED  (on: record created, artifact + input appended, no source yet)
PUBLISHED_UNATTACHED → HELD       (on: invoker attaches, epoch 1)
PUBLISHED_UNATTACHED → RUNNING    (on: managed worker attaches first; ordinary eligibility)
HELD → HELD                       (on: log append of applied input or emitted event; resets idle clock)
HELD → DETACHING                  (on: explicit detach intent or idle timeout; new inputs refused/held)
DETACHING → DETACHED              (on: turn boundary reached; reason yield)
DETACHING → DETACHED              (on: abort past grace bound; reason shutdown)
DETACHED → RUNNING                (on: later accepted input AND (holder was non-native OR RFC 26 section 6 admission passes))
HELD/DETACHING → UNCERTAIN        (on: holder loss with attempt-started but no terminal evidence)
UNCERTAIN → RUNNING               (on: explicit fresh authorization only; never automatic)
```

Heartbeats keep the lease alive inside HELD but MUST NOT reset the
idle clock. A second attach while HELD MUST be refused `lease-held`.
`DETACHED → RUNNING` for a native-bound holder MUST pass the same
admission as RFC 26 automatic continuation; the unconditional form is
rejected.

## Error Handling

```
E-HUB-01 - Handoff availability failure (severity: warning)
       Recovery: print the reason; retry with the same creation key
E-HUB-02 - Creation conflict, differing request on an existing key (severity: warning)
       Recovery: print the reason; reconcile the request and retry with a fresh key
E-HUB-03 - Bad handoff request (severity: warning)
       Recovery: print the reason; nothing half-made persists beyond the recovery states; retry corrected
E-HUB-04 - Working folder missing or invalid (severity: warning)
       Recovery: print the reason; choose a working folder and retry
E-HUB-06 - Context preparation held (severity: info)
       Recovery: continuation stays queued until its recorded recovery action completes; no automatic release
lease-held - Second source attempted attach during hold (severity: info)
       Recovery: refuse; the holder continues
registration-missing - Native binding expected but absent (severity: warning)
       Recovery: set up the native integration and reconnect
```

Retry policy: creation retries reuse the same creation key and are
idempotent per the equality rule. Dispatch retries follow existing
input redelivery for never-dispatched inputs; uncertain attempts need
explicit fresh authorization. No synthetic chunk inputs are permitted.

## Security Considerations

- **Trust boundaries**: the only boundary is local filesystem access.
  Possession of read access to the record IS authorization. The origin
  never crosses it; it supplies text to the human, who runs the local
  command.
- **Authorization**: running the handoff command authorizes the
  continuation input as the record's first task. Artifact bytes remain
  quoted data with no executable force. The existing Lucid request
  guidance applies to the driver (model guidance, not code
  enforcement); harness permissions stay unchanged.
- **Input validation**: artifact length, continuation length, folder
  path, and settings shape are validated as publication validates
  them today. Lengths are UTF-16 code units, the unit the host
  compares. Oversize is refused, never truncated.
- **Permissions model**: the handoff command needs what `lucid
  artifact publish` needs today: local user filesystem access. No new
  credential, token, or remote access is introduced.
- **Blast radius**: a malformed request fails closed into the stated
  recovery states. A malicious payload is quoted data inside the
  record; it cannot resume a foreign session and cannot write without
  the executor lease.
- **Data sensitivity**: the record secret (mode 0600) never leaves the
  machine. Record paths, secrets, and protocol envelopes never enter
  projected context.
- **Injection resistance**: the continuation is an authorized task
  from the local invoker, not from the remote origin. Artifact and
  history content stay quoted. The distinction is recorded in the
  projection: pending input outside the quoted history JSON.

## Alternatives Considered

1. **The origin receives the record secret and attaches remotely.**
   Attractive because it removes the human relay step. Rejected because
   it widens the trust boundary past the local machine and breaks the
   filesystem-access authorization model.
2. **Full transcript import into the new record.** Attractive because
   the new driver would hold complete history. Rejected because RFC 26
   ruled importing unrelated history out of scope, and no import path
   exists in `projectConversationContext`.
3. **Immediate detach at publish; review happens headlessly.**
   Attractive because it reuses today's managed-worker path unchanged.
   Rejected because the user asked to keep the invoking session
   attached through review, and the hold is a small parameter change.
4. **Polling creation (return at once, poll for URL).** Attractive for
   slow creation paths. Rejected because record creation is local and
   fast; one synchronous round trip is simpler and matches
   publish-then-connect behavior.
5. **Reuse the native-publication admission for handoff records.**
   Attractive because the machinery exists. Rejected because that
   requirement fences records awaiting a native binding, which a
   handoff record never gets; it would block the ordinary attach the
   handoff depends on. Presence held across creation is the race
   guard instead.

## Implementation Plan

- Phase 1: handoff command and payload validation (design sections 1
  to 3). Verify: `bun run check` green; publish-plus-continuation
  round trip against a disposable record; oversize (including a
  multibyte case past the code-unit limit) and bad-folder refusals
  observed; conflicting-retry refusal observed; crash injection
  before artifact write and before attach recovers into the stated
  states.
- Phase 2: review hold and projection state (design sections 4 to 5).
  Verify: hold keeps presence for the configured window measured
  against log appends; timeout detaches with `yield` at a boundary
  and `shutdown` past the grace bound; browser shows connected with
  time left, detaching, then gone; later input resumes under the
  stated admission.
- Phase 3: skill documentation for the handoff path. Verify: the
  authoring skill states the marker rule, the fence shape, and the
  handoff command for markerless sessions.

Go/no-go between phases: the prior phase's verification evidence is
recorded before the next begins. Rollback at each phase is the phase's
own revert; no phase migrates existing records.

## Review response

Review-v1 (gpt-6-astra@codex, cross-family) filed 10 findings; v2
answers them:

- F1 (actor ambiguity): Origin and Invoker are now separate defined
  terms; the Abstract states browser chat reaches the invoker.
- F2 (publication admission blocks attach): the handoff path MUST NOT
  record the native-publication requirement; presence held across
  creation is the race guard (alternative 5 records the rejection).
- F3 (handoff not atomic): commit boundary and three crash-recovery
  states specified; PUBLISHED_UNATTACHED added to the state machine.
- F4 (request identities): full field list with `creationId` XOR
  `conversationId`, `serverUrl`, continuation `inputId`, equality
  and conflict rules, and the command invocation. Open question 1
  decided: top-level `continuation` key.
- F5 (continuation vs quoted claim): running the command authorizes
  the continuation as a task; artifact bytes stay quoted. Security
  section rewritten around that line.
- F6 (hold/detach conflict): append-based idle clock; DETACHING
  state with boundary-vs-abort semantics; `yield` vs `shutdown`
  assigned. Open question 2 decided: no new reason.
- F7 (expiry vs departure): DETACHED to RUNNING qualified by holder
  kind; "gone" describes local presence release.
- F8 (redelivery vs uncertainty): never-dispatched vs uncertain
  attempt distinguished by `attempt-started`; UNCERTAIN state with
  explicit-only recovery.
- F9 (bytes vs code units): limits specified as UTF-16 code units
  with the demonstrated multibyte case; no byte-based admission
  introduced; multibyte case added to Phase 1.
- F10 (E-HUB-06 auto-release, missing codes): E-HUB-01 and E-HUB-02
  added; E-HUB-06 held until recorded recovery; separate
  artifact/continuation results.

## Open Questions

1. The heartbeat interval during a 30-minute hold (`expires` /
   `renewEvery` tuning). Criterion: measured lease-lapse behavior
   under idle review load.
2. The configuration key and file location for the hold length.
   Criterion: consistency with existing user-defaults handling in
   `docs/drivers.md`.

## References

Normative:

- [Source protocol](https://github.com/dungle-scrubs/lucid/blob/main/docs/skill-chat-substrate.md) - attach, epoch, input, detach contract.
- [Record, protocol, and lifecycle](https://github.com/dungle-scrubs/lucid/blob/main/docs/architecture.md) - atomic creation, locks, fold and append.
- [RFC 26: Interactive artifact conversation continuity](https://github.com/dungle-scrubs/lucid/blob/main/docs/rfc/26_interactive-artifact-conversation-continuity.rfc.md) - binding, listening, continuation, projection.
- [Drivers and harness selection](https://github.com/dungle-scrubs/lucid/blob/main/docs/drivers.md) - creation retry, idle steer, session recall.

Informative:

- [Wayfinding map: Any-session handoff to Lucid](https://github.com/dungle-scrubs/lucid/issues/299) - the six decisions this RFC renders, with per-ticket evidence.
- [HCN operation feedback](https://github.com/dungle-scrubs/lucid/blob/main/docs/compatibility.md) - operation-result authority at the harness seam.
- [Review-v1](32_any-session-handoff-to-lucid.review-v1.md) - the cross-family review v2 answers, finding by finding.

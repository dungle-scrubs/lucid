---
number: 03
title: "Resume: the record remembers which harness held the session"
type: protocol
status: Draft
author: Kevin Frilot
date: 2026-08-23
---

# RFC-03: Resume: the record remembers which harness held the session

## Abstract

A lucid conversation survives losing its process: the durable log is reopened
and folded, and every turn from before the restart is there. The harness's own
context does not survive. lucid cannot resume a harness session because the
record does not say which harness held one. `identity` events carry a
`sessionId` into the log, but nothing in the protocol says whether that id
belongs to claude, pi, codex, or muse, so a successor has no safe way to reuse
it - and reusing claude's id on pi is worse than not resuming at all. This RFC
adds the harness name to the attach frame and to the attachment the reducer
holds, defines how a source finds a resumable session for its own harness, and
specifies what happens when it finds none, finds one from a different harness,
or is refused. It does not add automatic context replay for a harness that
never held the session; that stays the caller's job, as RFC-02 left it.

## Introduction

### Problem

`scripts/smoke-resume.ts` fails on purpose today. It establishes a fact, loses
the process, reopens the record, and asks the harness to recall the fact. Both
halves of the conversation land in one durable fold, so lucid's own record is
intact. The harness answers from nothing.

Two causes were isolated, in two different places.

**Below lucid**, `hcn session --session-id <existing>` re-entered the id but
not the context. Reported as hcn issue #86 and fixed in hcn ticket #97:
`hcn session <harness> --json --resume <id>` now restores a conversation, and
an unknown id refuses before spawn instead of silently starting fresh. That
half is done and awaiting release; lucid pins 0.5.4 and cannot consume it yet.

**In lucid**, the harness session id is never usable on reopen:

- Turn mode captures the id off the first turn's `identity` event and holds it
  in a local variable for the life of ONE source (`turnStrategy`'s `resumeId`).
  A new source starts with `resume` undefined.
- Session mode is handed an id up front and passes it as the session id, which
  names a session rather than continuing one.
- The id IS in the durable log, on every `identity` event. Nothing reads it
  back.

And the reason nothing reads it back safely is the protocol gap this RFC
closes: **`Attachment` has no harness.** It carries `profile`, `lastN`, and
`lease` (`src/protocol/reducer.ts:53`), and `frames.ts` never mentions a
harness at all. A source folding the log finds `identity` events with session
ids and cannot tell which harness produced them.

That matters because cross-harness handoff is now a supported capability, not
a hypothetical. `spikes/evidence/cross-harness-handoff.md` records claude→pi,
pi→claude, codex→muse, and claude→codex all passing. In a record with that
history, the most recent `identity` is routinely from a different harness than
the one now attaching.

### Scope

In scope:

- A `harness` field on the `attach` frame and on `Attachment`.
- A rule for finding the resumable session id for a given harness from the
  folded log.
- The `attach-ok` frame reporting the id lucid found, so the source does not
  re-derive it.
- What a source does with that id in each headless profile.
- The refusal and fallback behaviour when resume is impossible.

Out of scope:

- **Automatic context replay into a harness that never held the session.**
  Cross-harness handoff works today by composing the prior transcript into the
  prompt, explicitly, at the caller. That stays where it is; making it
  automatic is a separate decision with its own tradeoffs about prompt size
  and truncation.
- **The interactive profile.** A human owns that process and lucid does not
  resume it.
- **Changing the reducer's epoch fencing, lease, or single-writer rule.**
  Resume happens at attach, under the existing rules.
- **Anything in hcn.** Its half is ticket #97.

### Motivation

Resume is the difference between a conversation and a transcript. Without it
every restart starts the harness from nothing, and lucid's durable log becomes
a record of work rather than a thing work continues from. It is also the last
piece of the substrate that a failing lane already specifies, so the work is
defined; what is missing is the protocol decision about where the harness
identity lives.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD
NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted
as described in RFC 2119.

- **harness**: one of `claude`, `codex`, `pi`, `muse`, named as hcn names it
  (`HarnessName`, `src/harness/runner.ts`).
- **harness session**: the conversation state a harness holds in its own
  store, addressed by a session id. Distinct from lucid's conversation.
- **session id**: the harness's id for a harness session. Carried on hcn's
  `identity` event and, after this RFC, findable in lucid's log.
- **conversation record**: lucid's durable directory - `log.ndjson`,
  `meta.json`, the secret, the locks.
- **source**: the process speaking protocol frames to the store host on a
  harness's behalf (`SourceChannel`).
- **profile**: `headless-session`, `headless-turn`, or `interactive`
  (`AttachProfile`).
- **resume**: continuing a harness session the same harness held before, so
  the harness answers from its own context. NOT the same as a successor
  reading lucid's transcript, which is cross-harness handoff.
- **fold**: replaying `log.ndjson` to rebuild state.

## Protocol Overview

```
source (claude)                          lucid store
   |                                          |
   |  attach { profile, harness: "claude",    |
   |           secret, version }              |
   |----------------------------------------->|
   |                          fold the log; find the newest
   |                          identity whose attachment named
   |                          harness "claude"
   |  attach-ok { epoch, lease, replayFrom,   |
   |              resumeSessionId?: "abc-123" }|
   |<-----------------------------------------|
   |                                          |
   |  the source opens hcn with --resume abc-123
   |  (or, absent the field, opens a fresh session)
   |                                          |
   |  event { identity, sessionId: "abc-123" }|
   |----------------------------------------->|  recorded under
   |                                          |  harness "claude"
```

Rules:

1. An `attach` frame MUST carry `harness` when its profile is
   `headless-session` or `headless-turn`. The field is OPTIONAL for
   `interactive`, where lucid does not own the process and never resumes it.
2. The reducer MUST record the harness on the `Attachment` it creates, and
   MUST keep it for the life of that attachment.
3. An `event` frame carrying an `identity` event is attributed to the harness
   on the attachment that was live when it was accepted. The protocol does not
   re-derive this later; the fold does it as it goes.
4. On a successful attach, lucid MUST report `resumeSessionId` in `attach-ok`
   when, and only when, the folded log holds an `identity` event attributed to
   the SAME harness the attach frame named. When several exist, lucid MUST
   report the most recent by `seq`.
5. A source MUST NOT use a `resumeSessionId` it derived itself from the
   transcript. The value comes from `attach-ok` or the source does not resume.
   Two readers of the same log deriving the same answer separately is a
   divergence waiting to happen, and only the reducer sees attribution.
6. A source that receives no `resumeSessionId` MUST open a fresh harness
   session. A conversation with no prior turn from this harness is the normal
   case, not an error.
7. Resume is an attach-time decision. A source MUST NOT change its harness
   session mid-attachment.

## Message Formats

### `attach`, extended

```ts
{
  kind: "attach";
  conversationId: string;
  profile: AttachProfile;
  secret: string;
  version: number;
  resumeFrom?: number;
  harness?: HarnessName;   // NEW. REQUIRED for the two headless profiles.
}
```

`harness` is OPTIONAL in the type so an interactive attach omits it, and so a
frame written by an older source still decodes. A headless attach without it
is refused; see Error Handling.

### `attach-ok`, extended

```ts
{
  kind: "attach-ok";
  epoch: number;
  lease: Lease;
  replayFrom: number;
  version: number;
  resumeSessionId?: string;   // NEW. Present only when one was found.
}
```

Absent means "no harness session of yours in this record". It does not mean
the record is empty, and it does not mean an error.

### `Attachment`, extended

```ts
interface Attachment {
  readonly profile: AttachProfile;
  readonly lastN: number;
  readonly lease: Lease;
  readonly harness?: HarnessName;   // NEW, from the attach frame
}
```

### Finding the id

lucid MUST derive `resumeSessionId` from the folded log alone, with no state
outside the record:

1. Walk accepted `event` frames in descending `seq`.
2. Skip any whose payload is not an `identity` event.
3. Skip any whose attributed harness is not the harness the attach names.
4. Take the first remaining event's `sessionId`. That is the answer.
5. If none remains, report nothing.

The walk MUST consider only events accepted under an attachment that named a
harness. Events recorded before this RFC have no attribution and MUST be
skipped, which makes an old record simply un-resumable rather than wrong.

## State Machine

Attachment states, from the source's view:

```
DETACHED  -> ATTACHING   (on: attach frame sent)
ATTACHING -> FRESH       (on: attach-ok with no resumeSessionId)
ATTACHING -> RESUMING    (on: attach-ok with resumeSessionId)
ATTACHING -> REFUSED     (on: refused; issue says why)
RESUMING  -> ATTACHED    (on: the harness accepted the id; identity observed)
RESUMING  -> FRESH       (on: the harness refused the id - see E003)
FRESH     -> ATTACHED    (on: identity observed for a new session)
ATTACHED  -> DETACHED    (on: detach, or the source's process ending)
```

Invalid transitions:

- A source MUST NOT move from ATTACHED back to RESUMING. Resume is decided
  once, at attach.
- A source that never observes an `identity` event MUST still be treated as
  ATTACHED for lease purposes. Some harnesses announce identity late, and the
  lease cannot wait on the harness.

## Error Handling

```
R001 - headless attach with no harness (severity: critical)
       An attach frame whose profile is headless-session or headless-turn and
       which carries no `harness`. Refused with issue `invalid-grant`.
       Recovery: the source names its harness. This is a programming error,
       not a runtime condition.

R002 - resumeSessionId names a session the harness no longer has
       (severity: warning)
       hcn refuses an unknown id before spawn (its ticket #97), so this
       surfaces as a HarnessRefusal at open, not as a silent fresh session.
       Recovery: the source MUST fall back to a fresh session, and MUST record
       an error event naming the id that could not be resumed. It MUST NOT
       fail the attach - a stale id is not a reason to refuse a conversation.
       Escalation: none; the conversation continues without harness context.

R003 - the record's newest identity belongs to a different harness
       (severity: info)
       Not an error. lucid reports no resumeSessionId and the source opens
       fresh. Cross-harness handoff then works as it does today: the caller
       composes prior context into the prompt if it wants continuity.

R004 - two identities from the same harness with the same seq
       (severity: critical, unreachable)
       seq is lucid's authority and strictly increasing, so this cannot occur
       in a well-formed log. A fold that observes it MUST refuse the record as
       `corrupt-log` rather than pick one.

R005 - the harness reports a session id different from the one resumed
       (severity: warning)
       The identity event carries an id lucid did not ask for. lucid MUST
       record the new id as the current session (it is what the harness
       actually has) and MUST emit an error event noting the substitution.
       Silently accepting it would make the next resume target a session that
       was never confirmed.
```

Retry policy: lucid never retries a resume. A refused id falls back to fresh,
once, and the conversation proceeds.

## Security Considerations

- **Trust boundaries.** Unchanged. The attaching source already proves itself
  with the record's secret, and `harness` is an additional field on an
  already-authenticated frame. It grants nothing.
- **Input validation.** `harness` MUST be validated against the closed set of
  known names before it reaches the reducer, the same way `profile` is. An
  unvalidated harness name would become a key that partitions the log's
  attribution, so a typo would silently make a record un-resumable rather than
  fail loudly.
- **What a session id is.** It is an opaque identifier for a conversation held
  in the harness's own store, under the same user. It is not a credential and
  grants nothing across users: possessing it lets a process on this machine
  ask that harness to continue a conversation the same user already owns.
- **Blast radius of the wrong id.** The failure this RFC exists to prevent -
  resuming one harness's session on another - is prevented by attribution, and
  backstopped by hcn refusing an unknown id before spawn. Both would have to
  fail for a conversation to be joined to the wrong context.
- **Cross-record leakage.** `resumeSessionId` MUST be derived from the record
  being attached to, never from a global index of sessions. There is no such
  index and this RFC does not add one; that would be the store index hcn's ADR
  0007 already ruled out for itself, and it is no better on lucid's side.
- **Log growth as an oracle.** A record now states which harnesses have
  touched it. Anyone who can read the record can already read the whole
  transcript, so this adds no exposure.

## Versioning

- `PROTOCOL_VERSION` MUST be incremented. `attach` and `attach-ok` both gain a
  field, and a source that sends the old attach against a new reducer is
  refused by R001 rather than silently un-resumable.
- Both new fields are OPTIONAL in the wire types, so an existing `log.ndjson`
  still decodes and folds. Events recorded before this RFC carry no
  attribution and are skipped by the search, so an old record loses nothing it
  had - it simply cannot resume, which is its behaviour today.
- The reducer MUST NOT infer a harness for an unattributed historical
  attachment. Guessing "it was probably claude" would resume the wrong session
  in exactly the cross-harness records this RFC is written for.

## Implementation Notes

Ordered so each step is green before the next, as RFC-02's steps were.

1. **`frames.ts`**: add `harness` to `attach` and `resumeSessionId` to
   `attach-ok`, with validators. `harness` validates against the closed name
   set. Bump `PROTOCOL_VERSION`.
2. **`reducer.ts`**: carry `harness` onto `Attachment`; refuse a headless
   attach without it (R001). Attribute accepted `identity` events to the live
   attachment's harness, and add the descending-seq search that produces
   `resumeSessionId` for `attach-ok`.
3. **`sequencer.ts` / `host.ts`**: pass the harness on attach, and surface the
   `resumeSessionId` from `attach-ok` to the strategy.
4. **`host.ts` strategies**: session mode passes it to `openSession` as a
   resume; turn mode seeds `resumeId` with it instead of `undefined`, which
   makes turn-mode resume work with the currently released hcn. Session mode
   needs the hcn release carrying ticket #97.
5. **`src/harness/runner.ts`**: `OpenSessionOptions` gains `resume`, distinct
   from `sessionId`. They are different requests and conflating them is the
   bug hcn issue #86 reported.
6. **Tests**: the reducer's search over a synthetic cross-harness log; R001,
   R002, R005; and `scripts/smoke-resume.ts` flipping from its documented
   failure to a pass, first for turn mode, then for session mode when hcn
   ships.

The turn-mode half is testable against hcn 0.5.5 today. The session-mode half
is blocked on the hcn release, and the RFC is written so that landing steps
1-4 delivers turn-mode resume without waiting for it.

## Open Questions

1. **Where the harness name is written: the attach frame, or the identity
   event?** This RFC puts it on the attach frame and attributes events to the
   live attachment. The alternative is a `harness` field on the identity event
   payload itself, which is more local but makes the harness a property of an
   opaque event body the protocol otherwise does not read. Recommended: the
   attach frame, because the protocol already owns attachment state and
   already refuses on it. Machine-made default: attach frame.
2. **Should lucid resume automatically, or only when asked?** This RFC resumes
   whenever an id is found. The alternative is an explicit opt-in on the
   attach frame, so a caller can deliberately start fresh in an existing
   record. Recommended: automatic, with the opt-out deferred until something
   needs it - a caller that wants a fresh start can use a new record today.
   Machine-made default: automatic.
3. **Does `resumeSessionId` belong in `attach-ok`, or should the source read
   it from the replayed frames?** `attach-ok` is chosen so exactly one party
   derives it (rule 5). The alternative saves a field but puts the same search
   in every source. Recommended: `attach-ok`. Machine-made default:
   `attach-ok`.
4. **What happens to a record whose harness attributions predate this RFC?**
   Specified as un-resumable. The alternative is a migration that re-attributes
   historical identities from some heuristic. Recommended: leave them; the
   only records that exist are development ones, and a wrong guess resumes the
   wrong conversation. Machine-made default: leave them.

## References

### Normative

- `src/protocol/frames.ts` - `attach`, `attach-ok`, `AttachProfile`,
  `PROTOCOL_VERSION`, `ProtocolIssue`.
- `src/protocol/reducer.ts` - `Attachment`, the attach path, the fold.
- `src/modes/host.ts` - `sessionStrategy` and `turnStrategy`, where a resume
  id is consumed.
- `src/harness/runner.ts` - `OpenSessionOptions`, `StreamTurnOptions`,
  `HarnessName`.
- harness-cli-normalizer ticket #97 - `hcn session --resume`, the half of this
  that lives below lucid.
- harness-cli-normalizer ADR 0007 - the scope test that put session re-entry
  in hcn and cross-run correlation in the caller.

### Informative

- `spikes/evidence/resume.md` - the failing lane and its diagnosis.
- `spikes/evidence/cross-harness-handoff.md` - why attribution is needed
  rather than "take the newest identity".
- harness-cli-normalizer issue #86 - what was reported and how it was split.
- harness-cli-normalizer issue #99 - why pi behaved differently under a direct
  probe than under lucid, which is the stdin-lifetime difference.
- `docs/rfc/02_consume-the-normalizer-through-hcn.rfc.md` - the seam this
  builds on.

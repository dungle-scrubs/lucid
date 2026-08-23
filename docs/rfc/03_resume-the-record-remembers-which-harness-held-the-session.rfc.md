---
number: 03
title: "Resume: the record remembers which harness held the session"
type: protocol
status: Implemented
author: Kevin Frilot
date: 2026-08-23
---

# RFC-03: Resume: the record remembers which harness held the session

> Revision 2. Answers the review
> `03_resume-the-record-remembers-which-harness-held-the-session.review-draft-2026-08-23.md`
> (validator pass; one cross-family reviewer, muse). Two blocking findings.
> One was that the search this RFC specified had nowhere to read from -
> `ChannelState` keeps only the current attachment, so the harness that held a
> prior epoch is gone the moment the epoch increments. That is fixed by
> attributing during the fold, into the transcript, which is derived rather
> than stored. The other was the version bump, already corrected before the
> review arrived and by running it rather than reading it. The per-point log
> is at the end.

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
5. Two different ids exist and MUST NOT be conflated.
   - **The requested id** is `resumeSessionId` on `attach-ok`. Only lucid
     derives it, from the folded transcript. A source MUST NOT derive one
     itself: two readers of the same log deriving the same answer separately
     is a divergence waiting to happen, and only the fold sees attribution.
   - **The reported id** is `sessionId` on the harness's `identity` event. The
     harness chooses it. It flows to lucid as an ordinary event and is
     attributed like any other. R005 is about this one, and reading it is not
     a source deriving a resume id - it is a source reporting what the harness
     said.
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
frame written by an older source still decodes. It MUST be validated at the
codec against the closed `HarnessName` set (`src/harness/runner.ts`), the same
way `profile` is, so an unknown name is `wrong-type` at decode (R007) and a
missing one on a headless attach is `invalid-grant` at reduce (R001). Those
are different faults and stay distinguishable.

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

`resumeSessionId` MUST be validated as a wire id (`isWireId`,
`src/protocol/frames.ts:249`, bounded at `ID_MAX`), the same as every other id
that crosses this boundary. A harness id longer than that is refused rather
than truncated.

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

The attribution has to outlive the attachment that produced it, and
`ChannelState` does not keep it: it holds one `attachment`, and a new attach
replaces it (`src/protocol/reducer.ts`). After an epoch increment the harness
that held the previous epoch is gone from state entirely. A search over
`ChannelState` would therefore match everything or nothing, and in a
cross-harness record it would resume the wrong session - the exact failure
this RFC exists to prevent.

Revision 2 specified walking the folded transcript in descending `seq`.
Implementation replaced that with an equivalent and simpler mechanism, and
this section records what was built:

**`ChannelState` gains `harnessSessions`**, a map from harness name to the
newest session id that harness announced.

- On an accepted `event` frame whose payload `kind` is `identity` and whose
  live attachment names a harness, the reducer MUST set
  `harnessSessions[harness] = payload.sessionId`.
- On attach, lucid MUST read `harnessSessions[frame.harness]`. Present means
  resume it; absent means open fresh.

Why the map rather than the walk:

- The reducer is pure over `ChannelState` and never sees the transcript, so a
  transcript walk could not live in the reducer at all - and only the reducer
  builds `attach-ok`.
- The lookup is O(1) at attach instead of a scan of the whole history.
- It costs one entry per harness, bounded by four.
- It folds naturally: replaying the log rebuilds the map, because the map is
  built by the same reduce the fold replays.

The reducer already reads `frame.event.kind` to classify droppable events, so
reading `sessionId` off an identity is an extension of an existing read rather
than a new dependency on an opaque payload.

Records written before this RFC have no attribution: their events were
accepted under attachments with no harness, so the map stays empty and they
are un-resumable rather than guessed at.

## State Machine

Attachment states, from the source's view:

```
DETACHED  -> ATTACHING   (on: attach frame sent)
ATTACHING -> FRESH       (on: attach-ok, no resumeSessionId - see R003/R006)
ATTACHING -> RESUMING    (on: attach-ok with resumeSessionId)
ATTACHING -> REFUSED     (on: refused; the issue says why)
RESUMING  -> ATTACHED    (on: the harness accepted the id; identity observed)
RESUMING  -> FRESH       (on: the harness refused the id - R002)
RESUMING  -> DETACHED    (on: takeover - this source's epoch went stale)
FRESH     -> ATTACHED    (on: identity observed for a new session)
FRESH     -> DETACHED    (on: takeover)
ATTACHED  -> DETACHED    (on: detach, the process ending, or takeover)
```

REFUSED keeps every issue the reducer already produces, unchanged. This RFC
adds no refusal issue and renames none: `auth-failed`, `wrong-conversation`,
`version-unsupported`, `lease-held`, `presence-holds`, and
`resume-ahead-of-log` (`src/protocol/reducer.ts:382-408`) behave exactly as
today. R001 is `invalid-grant`, which already exists.

Takeover during RESUMING is a real state, not a corner. A source can sit in
RESUMING while it waits for the harness to announce identity, and a second
source can win the next attach once the lease lapses. The straggler's epoch is
then stale and its next event is refused `stale-epoch`
(`src/protocol/reducer.ts:476`). It MUST treat that as DETACHED and end its
harness process rather than continue driving one nobody is reading.

Invalid transitions:

- A source MUST NOT move from ATTACHED back to RESUMING. Resume is decided
  once, at attach.
- A source that never observes an `identity` event MUST still be treated as
  ATTACHED for lease purposes. Some harnesses announce identity late and the
  lease cannot wait on the harness.

### Two attachers, one harness session

Rule 7 stops one attachment changing its mind. It does not stop two
attachments deciding the same thing. After a lease lapses, a second source of
the same harness folds the same log, is told the same `resumeSessionId`, and
opens the same harness session while the first is possibly still inside it.

lucid MUST NOT rely on the harness to arbitrate this. The protocol already
has the answer and it is the epoch: only one attachment holds the lease, and
the loser's events are refused `stale-epoch`. So:

- A source MUST NOT open its harness process until its attach has been
  accepted. Opening first and attaching second would let a refused source
  drive a session anyway.
- A source whose epoch goes stale MUST end its harness process, as above.

That bounds the overlap to the window between the lease lapsing and the
straggler noticing, which is the same window the single-writer rule already
tolerates for every other frame.

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

R006 - no session of this harness in the record (severity: info)
       Two causes that look the same on the wire and MUST stay
       distinguishable to the source: the record has no identity at all
       (a new conversation), or its identities belong to other harnesses
       (R003). Both produce an absent `resumeSessionId`, because the answer
       to "is there a session of mine" is no in both cases.
       A source that wants to tell them apart reads the folded transcript it
       already has - that is a presentation question, not a protocol one, and
       it is what a caller composing cross-harness context does today.

R007 - unknown harness name on attach (severity: critical)
       A name outside the closed set. Refused at the CODEC, as `wrong-type`,
       the same way a bad `profile` is - not at the reducer. Keeping the
       layer boundary means a typo surfaces identically to every other
       malformed field instead of as a grant problem.
       R001 stays `invalid-grant`: a MISSING harness on a headless attach is
       a well-formed frame making an unsupportable request, which is what
       that issue means.

R008 - an interactive attach carrying a harness (severity: warning)
       The reducer MUST ignore it and MUST NOT store it. lucid does not own
       an interactive process and never resumes it, so attributing its events
       would put ids in the search that no source may use. Ignoring rather
       than refusing keeps a caller that sets the field uniformly from being
       broken by it.

R005 - the harness reports a session id different from the one resumed
       (severity: warning)
       The identity event carries an id lucid did not ask for. lucid MUST
       record the new id as the current session (it is what the harness
       actually has) and MUST emit an error event noting the substitution.
       Silently accepting it would make the next resume target a session that
       was never confirmed.
```

### `resumeFrom` and `resumeSessionId` are orthogonal

They answer different questions and MUST NOT be coupled:

- `resumeFrom` is about LUCID's log - the watermark below which the source
  already has the frames, gating input replay
  (`src/protocol/reducer.ts:404-417`).
- `resumeSessionId` is about the HARNESS's store - which conversation the
  harness should continue.

A source MAY send `resumeFrom` and receive `resumeSessionId` in the same
attach. Neither constrains the other, and the reducer MUST NOT adjust one
because of the other. In particular, falling back to a fresh harness session
(R002) MUST NOT rebase `resumeFrom`: lucid's replay obligation is unchanged by
the harness having lost its context, and rebasing it there would drop the
un-applied input queue, which is the failure the replay gating already warns
about.

The error event R002 and R005 require is an ordinary event frame at the next
`seq` under the current attachment. It carries `kind: "error"`, so the search
skips it by step 2 and it cannot become a resume target.

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

**`PROTOCOL_VERSION` MUST NOT be bumped for this change.** An earlier draft of
this RFC said to bump it and claimed an existing `log.ndjson` would still fold.
That is false, and the cost of being wrong is every record in existence.

The reducer checks `frame.version !== PROTOCOL_VERSION` and refuses
`version-unsupported` (`src/protocol/reducer.ts:385`) - an exact match, not a
floor. The fold replays every entry back through the reducer and throws
`fold-refused` the moment one is refused (`src/store/log.ts:241-245`). So a
bump does not make old records un-resumable; it makes them **unopenable**.
Measured, not reasoned: folding a record whose attach frame carries
`PROTOCOL_VERSION - 1` throws `log entry at byte 0 refused on fold
(version-unsupported)`.

Both new fields are additive and OPTIONAL, so no bump is needed:

- An old source omits `harness` on a headless attach and is refused by R001,
  which is the outcome a bump was wanted for, reached by the rule that
  actually describes the problem.
- An old record folds unchanged. Its attachments carry no harness, its
  identity events are unattributed, and the search skips them - the record
  opens and simply cannot resume, which is its behaviour today.
- A new source attaching to an old record works: attribution starts from this
  attachment forward.

The reducer MUST NOT infer a harness for an unattributed historical
attachment. Guessing "it was probably claude" would resume the wrong session
in exactly the cross-harness records this RFC is written for.

A genuinely breaking protocol change still needs a version story, and this RFC
does not provide one. Before any such change, the version check has to become
a compatibility range and the fold has to tolerate an older accepted frame.
That is its own decision and out of scope here.

## Implementation Notes

Ordered so each step is green before the next, as RFC-02's steps were. The
read path is spelled out because the review showed the earlier draft waved at
it: an implementor following the old steps would have added `harness` to the
attach frame and still started every reopened turn with `resumeId` undefined.

1. **`frames.ts`**: add `harness` to `attach` and `resumeSessionId` to
   `attach-ok`. Validate `harness` against the closed `HarnessName` set and
   `resumeSessionId` with `isWireId`. Do NOT touch `PROTOCOL_VERSION` - see
   Versioning.
2. **`reducer.ts`**: carry `harness` onto `Attachment`; refuse a headless
   attach without it (R001); ignore one on an interactive attach (R008).
3. **`reducer.ts`, attribution**: `ChannelState` gains `harnessSessions`; an
   accepted identity event under a harness-bearing attachment records its
   session id there. The attachment MUST be carried, not rebuilt, on the
   event path - rebuilding it from profile/lastN/lease drops the harness and
   attribution then works exactly once per attachment.
4. **`reducer.ts`, the lookup**: `attach-ok` carries
   `harnessSessions[frame.harness]` when present. No walk, no transcript.
5. **`sequencer.ts`**: send `harness` on attach; read `resumeSessionId` off
   the `attach-ok` effect and expose it, next to `epoch` and `attachReplay`
   which it already exposes.
6. **`host.ts`**: `HeadlessDeps` gains the harness it already has as a name,
   and both strategies take the resume id from the sequencer BEFORE their
   first open. Turn mode seeds `resumeId` with it instead of `undefined`;
   `streamTurn` already forwards `--resume`, so **turn-mode resume works at
   this step against released hcn**. Session mode needs step 7.
7. **`runner.ts` and `hcn-runner.ts`**: `OpenSessionOptions` gains `resume`,
   distinct from `sessionId`, and `openSession` renders `--resume`. Blocked on
   the hcn release carrying ticket #97; until then session mode ignores the id
   and opens fresh, which is its behaviour today.
8. **Tests**: the search over a synthetic cross-harness transcript; R001,
   R002, R005, R007, R008; a takeover during RESUMING; and
   `scripts/smoke-resume.ts` flipping from its documented failure to a pass -
   turn mode at step 6, session mode at step 7.

The incremental claim, stated precisely this time: **steps 1-6 deliver
turn-mode resume against hcn 0.5.5.** Session mode needs step 7 and the hcn
release. The earlier draft claimed steps 1-4 sufficed; they do not, because
the sequencer never read `attach-ok` for anything but epoch and replay, and
nothing supplied `deps.resume`.

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

## What changed in revision 2

One line per review finding.

- F1 (blocking, the search had nowhere to read from): attribution accumulates
  into `ChannelState.harnessSessions` as the fold goes, because `ChannelState`
  keeps only the current attachment and the reducer never sees the
  transcript. "Finding the id" rewritten; steps 3 and 4 rewritten. Revision 2
  proposed a transcript walk and implementation replaced it with the map -
  recorded here rather than silently diverging.
- F2 (blocking, the version bump): already corrected before the review, and by
  running it - folding a record one version behind throws `fold-refused`.
  Versioning now says do not bump, and why.
- F3 (major, rules 3/5/R005 conflict): rule 5 now separates the id lucid
  REQUESTS from the id the harness REPORTS. Reading the second is not deriving
  the first.
- F4 (major, the incremental claim): Implementation Notes spell out the read
  path and the claim becomes steps 1-6, not 1-4.
- F5 (major, uncovered states): the state machine gains takeover during
  RESUMING and FRESH, states that every existing refusal issue is unchanged,
  and adds a section on two attachers resuming one session - answered by the
  epoch, with a rule that a source attaches before it opens.
- F6 (major, resumeFrom): a section saying the two are orthogonal, and that a
  fallback to fresh MUST NOT rebase `resumeFrom`.
- F7 (minor, harness validation): unknown name is `wrong-type` at the codec
  (R007), missing name is `invalid-grant` at the reducer (R001); an
  interactive attach carrying one is ignored (R008).
- F8 (minor, wire bound): `resumeSessionId` validated with `isWireId`. The
  no-session-versus-empty-record distinction is named as R006 and left to the
  source's own transcript read.

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

---
number: 10
title: "The record answers questions about itself"
type: protocol
status: Withdrawn
author: Kevin Frilot
date: 2026-08-27
---

# RFC-10: The record answers questions about itself

## Withdrawn

This RFC was withdrawn on 2026-08-27, after the cross-family review filed
beside it removed its premise. It is kept because the gap it found is real
and the reasons it failed are worth not repeating.

**What it proposed.** A read-only command answering four questions about a
conversation's record: what versions exist, why each exists, what a version
says, and what changed between two.

**Why it does not stand.**

1. **The main answer cannot be given.** "Why a version exists" was to be
   derived from ordering: the notes delivered after the previous version and
   before this one. That join is wrong. An artifact entry carries no
   `turnId`, no input id and no `seq`. The agent's reply is written after the
   version, not before. A turn can produce no version. One message can
   produce two, which `test/protocol/artifacts-emission.test.ts` already
   fixes. A save is not an input and starts no turn. Reproduced against
   `~/.lucid2/records/demo` before withdrawing.
2. **The other three answers already exist.** The loopback server returns
   conversation lines with their notes and replies, version catalogs, and
   complete version bytes; a caller can get a token from `/api/session`.
   Without the causal join this was a wrapper over projections that ship.
3. **The motivating case does not motivate.** Before the bad edit in the
   Problem statement, the agent already held the note, the exact selected
   snippet, the artifact id and the version. The query returns the same
   facts. That failure was not caused by missing data, so more access to the
   same data would not have caught it.

**What is left standing, and it is the useful part.** lucid does not record
*why* a version exists. The note, the reply and the version are all in the
log, and nothing links them. Closing that is a change to what an artifact
entry carries, not a read surface over what it carries today. A read command
becomes easy once causality is recorded and pointless before.

Two rules from the review belong in whatever replaces this:

- A read path appends nothing, takes no lock, moves no cursor, and starts no
  follow-up work. That is enforceable. "The conversation behaves identically"
  is not, because a query is a tool action and tool events enter the record.
- A projection cannot be a pure function of a folded record. The fold holds
  offsets, not bytes, and the catalog carries neither a timestamp nor
  `basedOn`.

And one thing the review misread, recorded so it is not re-litigated: it
treated a skill's guidance as lucid nudging the agent. The distinction is
that the **application** must never influence the agent, while a skill
carries recommendations and recipes. The invariant, which holds even after
the skill ships inside lucid, is that **with no skill loaded lucid's only
surface is a help command listing what exists.**

---

## Abstract

lucid keeps a complete account of how a document reached its current state,
and nothing can read it back. Every note carries the exact text it pointed
at, every agent reply says what it decided, and every version is stored
whole and hashed, all in one ordered log.

This adds a read-only command that answers questions about that account. The
agent calls it or never calls it, as it chooses. lucid does not ask it to, does not push
history into any prompt, and holds no opinion about when a query is worth
making.

Nothing about the command goes in the artifact preamble. A skill teaches
that it exists.

## Introduction

### Problem statement

**The refusals catch mechanical failure. Nothing catches semantic failure.**

RFC-08 refuses a patch whose anchor matches nothing (`E-PATCH-02`) or
matches twice (`E-PATCH-03`). Both are cases where lucid cannot tell where
the change goes. Neither is a case where lucid puts the change exactly where
the agent said and the result is wrong anyway.

That happened on 2026-08-27, and it is the case this RFC exists for. A drag
selected `ALPHA BRA`, ending mid-word. The note read "these two words only".
The agent took that as ALPHA and BRAVO, and rewrote a six-item list to two
items, dropping four. **The patch applied cleanly. Nothing refused.** It was
caught because a person read the agent's reply, where it happened to say
what it had done.

RFC-08 F-03 named the same hazard one level down, inside a single patch, and
weighed it the same way:

> a refusal costs a turn, a silent wrong-target costs a version nobody
> reviewed.

**The account of what happened is already complete.** For that change the
record holds the note and the snippet it pointed at, the agent's own
explanation, and the resulting version, whole and hashed, in order. For
`demo` today that is twenty versions of one document with the note behind
each one. None of it is reachable by anything except a person reading the
conversation.

### Scope

In scope:

- A read-only command over one record, and what it answers.
- The rule that lucid never pushes what the command returns.
- Where the agent learns the command exists, and where it does not.

Out of scope, and deliberately:

- **Asking the agent to check its work.** lucid MUST NOT prompt for a
  review, schedule one, or vary what it sends based on whether one happened.
  A capability the agent is free to ignore is the whole of this RFC; a
  capability lucid leans on is a different product.
- **Any agent-driven loop.** Nothing here re-runs a turn, retries, or
  reacts to what a query returned.
- **A new frame.** See R1.
- **A human-facing view.** `#124` compares two versions on the page. It
  reads the same data and it is not this.
- **Writing.** The command reads. Restore already exists (RFC-07 R8) and is
  how an older version becomes current.

### Motivation

The request is the user's, and its shape matters more than its subject:

> Really it's the on demand queryability that I'm interested in. I'm not
> suggesting that we nudge it or push it to check its own work, but it might
> decide to do so on its own, up to the agent.

lucid owns the record. Making the record answer questions is that job.
Deciding when the agent asks is not.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD
NOT, RECOMMENDED, MAY and OPTIONAL in this document are to be interpreted as
described in RFC 2119.

| Term | What it is |
|---|---|
| **the account** | What the record already holds about how the document reached its state: the notes, the agent's replies, and every version |
| **a query** | One invocation of the read command. Returns and exits |
| **projection** | What lucid chooses to return. Never the raw log |
| **the preamble** | `ARTIFACT_PREAMBLE`, shipped inside lucid and carried in the prompt to every harness |
| **the skill** | Guidance for a harness that supports skills. Outside lucid |

## Protocol Overview

### R1 - It is a command, not a frame

- The read surface MUST be a command on lucid's CLI, beside `send`, `watch`
  and `chat`.
- It MUST NOT be a new frame kind.

A frame is between a **driver** and the host. The agent does not speak
frames: its channel is a prompt in and hcn events out, which are `message`,
`token`, `done`, `identity` and their siblings. It cannot invent one. A
query frame would hand the question to lucid's own driver process, which
already holds the log and did not need to ask.

What the agent does have is the ability to run a command, which every
harness lucid drives already gives it. So the surface it can actually reach
is the one lucid should offer.

### R2 - lucid owns the projection

- The command MUST answer from a projection lucid builds.
- It MUST NOT direct any reader to the record on disk, and MUST NOT return
  the raw log.

The record directory holds `secret` beside `log.ndjson`. That secret
authenticates a source to the host. An agent told to read the log is an
agent told where the credential is, and although it could find that itself
on a machine it already has, lucid pointing at it is a different act from
lucid being unable to prevent it.

Owning the projection also means the answer is about the document rather
than about lucid's storage. A reader asking what changed in version 17
should not have to know what an entry looks like, that hashes exist, or that
frames and artifact entries share one file.

### R3 - Nothing is pushed

- lucid MUST NOT include the account, or any part of it, in a prompt because
  a query is available.
- The prompt MUST NOT change in any way as a result of this RFC.

This is the rule the whole design rests on, and it is the one most likely to
erode. RFC-08 exists because the document in every prompt is what made a
revision cost 108 seconds. History is larger than the document. Sending it
speculatively would undo that and more.

Two existing behaviours stay exactly as they are, and neither is a
precedent for a third:

- `composeArtifactState` carries a version's bytes when a **person** saved
  it, because the agent has never seen it.
- It carries them once after `E-PATCH-02`, because the agent has just
  demonstrated its picture of the document is wrong.

Both are answers to something that happened. Neither is speculative, and
this RFC adds no third case.

### R4 - lucid has no opinion about when to query

- lucid MUST NOT ask the agent to review, verify or check anything.
- lucid MUST NOT vary its behaviour according to whether a query was made.
- A conversation in which the command is never called MUST behave exactly as
  one in which it is called every turn.

An agent that never queries is not doing anything wrong. That is what makes
this a capability rather than a step.

### R5 - The preamble says nothing about it

- The artifact preamble MUST NOT mention the command.
- A skill MAY teach that it exists and when it is worth calling.

The two carry different things and reach different places.

| | The preamble | A skill |
|---|---|---|
| Ships in | lucid's binary | outside lucid |
| Reaches | every harness lucid drives | harnesses that support skills |
| Carries | the minimum needed to emit an artifact at all | judgement: when a patch is the wrong choice, what a good anchor looks like, when to query |
| Wire format | defines it | MUST point at it, never restate it |

The last row is the one that will be got wrong. Two documents teaching one
protocol drift, and the preamble is the one that is always right because it
ships with the binary that enforces it. A skill that restates the fence, or
`replaces`, or the patch body, is a second source of truth with no way to
stay true.

Keeping the command out of the preamble also keeps R4 honest. An agent
without the skill never learns the command exists, and nothing about its
conversation is worse for it.

## Message Formats

The command's answers, as a shape rather than a spelling. What each answer
contains is settled; how a query names what it wants is Open Question 2.

**What versions exist.** For each: its number, who wrote it, when, and for a
version a person saved, the version it was working from. This is what the
catalog already computes.

**Why a version exists.** The notes delivered before it, each with the text
it pointed at, and the agent's own reply for that turn. This is the answer
the ALPHA BRA case needed and could not get.

**What a version says.** Its bytes.

**What changed between two versions.** Open Question 1: either the two
versions, or a computed difference.

Every answer is scoped to one conversation, named on the command line, and
one artifact, because a conversation holds one (RFC-09 R1).

## State Machine

A query has no states. It reads, prints and exits, holding no lock and
changing nothing.

```
INVOKED  -> ANSWERED  (on: the record folds and the query resolves)
INVOKED  -> REFUSED   (on: no such conversation, or a query naming nothing)
```

That is the whole machine, and it is stated to make a property explicit: a
query MUST NOT take the append lock, MUST NOT take the presence lock, and
MUST NOT advance the delivery cursor. It is invisible to the conversation it
reads, and two of them running at once cannot interfere.

## Error Handling

```
E-READ-01  no-such-conversation           (severity: warning)
           The named conversation has no record.
           Recovery: exit non-zero, naming what was looked for. The
           caller has the wrong name.
           Escalation: none.

E-READ-02  no-such-version                (severity: warning)
           A query named a version the record does not hold.
           Recovery: exit non-zero, saying which versions it does hold.
           Escalation: none.

E-READ-03  record-unreadable              (severity: error)
           The record exists and cannot be folded.
           Recovery: exit non-zero with the fold's own reason. A query
           MUST NOT repair, truncate or write anything, whatever
           `readFoldRepair` does on the write path.
           Escalation: none. A damaged record is the driver's problem
           and a reader must not make it worse.
```

A refused query MUST have no effect on any conversation. Nothing is
appended, and no running turn learns that a query was attempted.

## Security Considerations

**The secret never travels.** R2 exists for this. The projection is built by
lucid from the record; the record's directory, and the `secret` in it, are
never named to a caller.

**A reader is not a writer.** The command takes no lock and appends nothing,
so it cannot corrupt a record, cannot take the executor lease from a running
driver, and cannot make a conversation appear active. A reader that could do
any of those would be a way to disrupt a conversation from outside it.

**A damaged record is not repaired by a reader.** `E-READ-03` says so
explicitly, because lucid's write path repairs a truncated log by truncating
to the last good byte. A reader doing that would discard entries a driver
might still recover, and it would do it without the append lock.

**The account contains what a person wrote.** Notes are a person's words, and
versions are their edits. This RFC does not change who can reach a record:
anyone who can run the command can already read the directory. It does mean
lucid now has a supported way to print that content, so the projection MUST
NOT be extended to anything the record does not already hold about this
conversation.

**Untrusted text is returned, not interpreted.** Notes and documents are
agent-authored and person-authored text. The command prints them. It MUST
NOT evaluate, render or resolve anything in them.

## Versioning

The command is additive. It reads records written by every build that came
before it, because it reads through the same fold, and it changes nothing
about what is written.

An older lucid is unaffected: nothing in the record changes, so a record a
newer lucid has been queried against is byte-identical to one it has not.

The skill and the binary version separately, which is the one place this can
go wrong. A skill describing a command a deployed lucid does not have will
send the agent to a failure. That is the skill's problem to manage, and it
is why R5 keeps the wire format out of it: a skill that is merely early
costs a failed command, while a skill that restates the protocol wrongly
costs a wrong document.

## Implementation Notes

Ordered so each step leaves the suite green.

1. **The projection.** A pure function from a folded record to the answers
   above. No I/O, so the oracle is a record and what comes back.
2. **The command.** Argument parsing, the three refusals, and exit codes.
3. **The skill.** Outside this repository, and outside this RFC.

Most of the risk is in step 1, and specifically in joining a version to the
notes that caused it. The record orders everything, but nothing links a note
to the version that answered it: the note is an input, the version is an
artifact entry, and the join is "the notes delivered after the previous
version and before this one". That is a projection decision, not a fact in
the record, and it should be written down where it is made.

## Open Questions

1. **Does a difference come back as two versions, or as a computed diff?**
   lucid stores every version whole and computes differences nowhere.
   v1 did the same and computed them only as a view (`src/diff/diff.ts`).
   Options: return both versions and let the caller do the work, which is
   honest and larger; return a computed difference, which is smaller and
   makes lucid own a diff algorithm and its choices; return a difference
   only on request.
   Decided by: whether an agent asking "what changed" can use two documents
   as well as it can use a diff. Measurable the way RFC-08 Open Question 1
   was, and cheaper to answer after the command exists than before.
   Recommended: two versions first. It cannot be wrong, and it defers owning
   a diff until something needs one.

2. **How does a query name a version it cannot see?** The agent knows the
   current version number, because the state block tells it. It does not
   know that v17 is the one it wants.
   Options: absolute numbers only, which is exact and hard to use;
   relative offsets from the current version; naming a turn or a note
   instead, since "the version that answered my last note" is closer to the
   question actually being asked.
   Decided by: the questions an agent actually asks, which nobody knows yet.
   Recommended: absolute numbers plus a way to list them, so the first query
   is always answerable and the second is exact.

3. **Should the human-facing half share the projection?** `#124` compares
   two versions on the page and reads the same data.
   Options: one projection serving both, which keeps them honest with each
   other; separate paths, since a page wants rendering and a command wants
   text.
   Decided by: whether `#124` survives the design pass in a shape that wants
   the same answers. It is held until then, so this cannot be settled now.

## Alternatives Considered

**Leave it.** The account stays complete and unreadable. The cost is the
class of failure this RFC opens with: a patch that applies perfectly and
does the wrong thing, found only if a person reads the reply. That is a real
cost and it is not obviously large, since the person usually is reading.
What makes it worth addressing is that the data is already there and the
surface is small.

**A new frame the agent sends.** Rejected in R1 on the ground that the agent
cannot send frames. Worth recording because it is the obvious design and it
is wrong for a structural reason rather than a preference.

**Tell the agent the record's path.** Cheapest of all: the agent has file
tools and the log is a file. Rejected in R2: the directory holds `secret`,
and the raw log is a bad interface besides, mixing frames, artifact entries
and cursors in one stream with no projection.

**Push the account into the prompt after a change.** lucid knows when it has
just applied a patch, so it could hand over the prior version and the note
that caused it, unasked. Rejected: it is the nudge the user explicitly did
not want, it costs context on every revision, and it decides for the agent
what is worth checking. R3 and R4 exist to keep this out.

**Have lucid verify the change itself.** lucid holds the note, the before
and the after, so it could compare them. Rejected on the fit check: lucid
routes a conversation into a record and back out. Judging whether a document
answers a note is neither, and it would need a model to do it, which lucid
does not have and should not acquire.

## References

### Normative

- RFC-06, "An artifact you can address" - the fence, the preamble, and what
  a version entry holds.
- RFC-07, "Many artifacts in one record and the history you can move
  through" - the version rules, restore, and `#124`.
- RFC-08, "Revising an artifact without retyping it" - the patch form,
  `E-PATCH-02` and `E-PATCH-03`, and F-03 on silent wrong targets.
- RFC-09, "One artifact per conversation" - one artifact, so a query names a
  conversation and not a document.
- RFC 2119, "Key words for use in RFCs to Indicate Requirement Levels".

### Informative

- `CONTEXT.md` - what lucid is, and the vocabulary this uses.
- `scripts/smoke-cross-harness.ts` - composes a successor's context by hand,
  and says lucid has no automatic replay.
- lucid v1, `src/diff/diff.ts` - differences computed as a view over stored
  snapshots, which is the shape Open Question 1 asks about.

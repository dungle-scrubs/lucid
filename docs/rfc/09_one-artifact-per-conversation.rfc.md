---
number: 09
title: "One artifact per conversation"
type: protocol
status: Draft
author: Kevin Frilot
date: 2026-08-27
---

# RFC-09: One artifact per conversation

## Abstract

A conversation holds one artifact. An emission whose `artifactId` differs
from the one the record already holds is refused, never folded in silently.

This narrows the contract RFC-06 established and RFC-07 extended, and it
reverses a decision that shipped. RFC-07 specified an artifact list, a
second artifact pane, and retire-and-un-retire on the premise that a record
holds several artifacts. The list and retire shipped. The second pane was
specified and never built. That premise was never a product decision. It fell out of
RFC-06 letting the agent choose `id` freely, and RFC-07 addressed the
resulting incoherence rather than a need anyone had.

`artifactId` stays in the log, in annotation batches and in the state block,
carrying one value per conversation. It survives as the name the agent gave
the document, shown when no person has written a title.

## Introduction

### Problem statement

RFC-07's first defect reads:

> Only one artifact is reachable. `viewArtifactCatalog` returns every
> artifact in the record; the client takes `artifacts[artifacts.length - 1]`
> and renders that. A second artifact hides the first. The first is still in
> the log and the agent can still revise it, so the page and the agent
> disagree about what exists.

That is a correctness floor. A page must not hide something the agent can
still change. It is not an argument that a conversation SHOULD hold several
artifacts, and RFC-07 never made one. The capability was already there,
because RFC-06 let the agent pick `id` and any new id starts a new artifact,
so RFC-07 built a list, panes and a tombstone to make the page honest about
a shape nobody had chosen.

Two things follow from carrying that premise.

**The surface pays for a case that has not occurred here.** Across fifteen
records on the machine this was built on, every record with two artifacts was
a test; every record from real use held exactly one. Those test records have
since been deleted, so no two-artifact record exists.

That is one user, one machine and fifteen records. It supports the claim that
this user has no use for sibling artifacts. It does not establish that nobody
could, and an earlier draft leaned on it as though it did. The decision rests
on the user's judgement about what lucid is for, which `CONTEXT.md` says is
one person on one machine. The sample corroborates it; it does not carry it.

RFC-07 gave one concrete use this RFC should answer rather than pass over:
reading one artifact while comparing another, which was its reason for two
panes. Comparison **within** one artifact survives, as version comparison.
Comparison **across** two documents is what is being declined, and the answer
to wanting it is two conversations and two windows.

**The product drifts.** An artifact is a rendering of what the agent
produced, read and marked up in the conversation that produced it. A record
holding several documents, with a list to move between them and a tombstone
to file them away, is a document manager. `CONTEXT.md` says what lucid is
for, and it is not that:

> The product on top of it is a place to **read what an agent produced, and
> mark it up** - an artifact rendered in the conversation, annotated in the
> same view.

The narrowing removes the drift and most of the surface with it.

### Scope

In scope:

- One artifact per conversation, and what happens when an agent emits a
  second `artifactId`.
- Withdrawing RFC-07 R2 (the artifact list), R3 (two artifact panes) and R12
  (retire and un-retire).
- What `artifactId` is for once it no longer distinguishes anything.

Out of scope, and deliberately so:

- **Removing `artifactId`.** It stays in the log, in annotation batches and
  in the state block. Taking it out is a protocol change with a migration,
  and it earns nothing: a field that always carries the same value costs one
  string per entry.
- **Grouping conversations.** There is no project, folder or tag in lucid and
  this RFC does not add one. A conversation is the only container.
- **A session-level "finished" state.** Considered and declined; see
  Alternatives Considered.
- **Version history, read-only old versions, restore and comparison.** These
  are about versions of one artifact and RFC-07's rules for them stand.

### Motivation

The decision is the user's, taken after using the delivered surface. The
reason given, in their words, is that an artifact "should really just be a
visualization of context" and that lucid is not "an application runner or a
task manager".

That is a scope judgement rather than a defect report, and it is the kind
this RFC exists to record: what the product does for its users is being
narrowed, deliberately, and the narrowing throws away working code.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD
NOT, RECOMMENDED, MAY and OPTIONAL in this document are to be interpreted as
described in RFC 2119.

| Term | What it is |
|---|---|
| **conversation** | One exchange, identified by a `conversationId`, living in one record |
| **artifact** | The document a conversation holds. One per conversation |
| **artifactId** | The agent's name for that document, chosen on first emission and immutable thereafter |
| **title** | A name a person wrote, which takes precedence over `artifactId` for display (RFC-07 R11) |
| **the list** | RFC-07 R2's row of artifacts in the conversation. Withdrawn by this RFC |

## Protocol Overview

### R1 - A conversation holds one artifact

- A record MUST hold at most one artifact.
- The first artifact emission in a conversation establishes it.
- Every later emission MUST name that same `artifactId`.

**A first emission of the whole form MAY carry a non-null `replaces`, and it
is still the first version.** This is RFC-06's rule and it is unchanged here.
It is scoped to the whole form on purpose: a first emission that is a patch
is refused `E-PATCH-01`, because a patch is a revision and never a
creation. An unknown id with
`replaces: 5` starts the artifact at version 1, which
`test/protocol/artifacts-emission.test.ts` fixes as
`unknown identity starts new artifact rather than failing`. An earlier draft
of this RFC said the first emission MUST use `replaces: null` and called that
unchanged from RFC-06. It was not, and it would have been a second reversal
smuggled in without being named.

`replaces` continues to do the work it always did. With one artifact,
`replaces: 12` is unambiguous without an id to disambiguate it.

### R2 - A second artifactId is refused

- An artifact emission whose `artifactId` differs from the one the record
  holds MUST be refused with `E-ART-09`, and nothing MUST be appended.
- The refusal MUST name the `artifactId` the record holds, so the agent can
  reuse it without asking.
- lucid MUST NOT fold the emission into the existing artifact, and MUST NOT
  start a second one.

Refusing rather than folding in is the same rule `E-PATCH-07` sets for an
unrecognised `form`: lucid refuses rather than assumes. Folding it in would
be worse here than there. The agent chose an id deliberately, so quietly
substituting a different one makes its own instruction mean something else,
and the document it lands in is not the one it named.

An agent that wants a different document does not need one. Replacing a
document wholesale is the next version of the same artifact, which keeps one
thread of versions rather than two parallel ones.

### R3 - artifactId keeps a smaller job

`artifactId` did four jobs. Three of them existed only because a
conversation could hold several artifacts:

| Job | After this RFC |
|---|---|
| Says which artifact an emission revises | `replaces` alone is unambiguous |
| Addresses an annotation batch | One artifact to point at |
| Addresses the URL | `/c/:conversationId` suffices; see Open Question 1 |
| **The name shown when no title exists** | **Survives** |

- `artifactId` MUST continue to be written on artifact entries, annotation
  batches and the artifact state block.
- It MUST remain immutable for the life of a record, on RFC-07 R11's terms.
- A person's `title` MUST take precedence over it for display, unchanged from
  RFC-07 R11.

The table is about what the id does **for a reader**. Inside lucid it keeps
working, and an earlier draft read as though the field went idle. It does
not. It is still the durable composite key the fold indexes versions by, it
still selects which artifact an emission revises and which document a patch
anchors against, it still binds an annotation batch to what the note points
at, it still addresses the URL and the artifact endpoints, it still
correlates messages arriving from the sandboxed frame, and it is still the
key a person's title is stored under and looked up by.

That distinction matters for the implementation. Nothing may drop a check on
`artifactId` on the grounds that it is now only a label: the checks are what
keep R5's older records readable, keep annotations bound, keep direct links
working, and keep an untrusted frame from being answered about a document it
did not name.

What changed is narrower. The id no longer distinguishes one artifact from
another for a person, because there is only one. It is the name the agent
gave the document, and a title is the name a person gave it.

### R4 - What RFC-07 withdraws

- **R2, the artifact list.** Withdrawn. A list of one is a label, and the
  page already suppresses the row below two artifacts.
- **R3, two artifact panes.** Withdrawn. Both panes existed to show two
  artifacts of one conversation.
- **R12, retire and un-retire.** Withdrawn entirely.

Retire deserves its reasoning written down, because it shipped and is being
removed rather than left unbuilt. Its behaviours were: take the artifact out
of the list, show a banner on its page, and tell the agent not to revise it.
The first is meaningless without a list.

The third is the one that could survive alone, and an earlier draft dismissed
it too fast. It claimed "do not revise this document" simply means "this
conversation is finished". A review pushed back, correctly: the shipped
behaviour does not end anything. The input endpoint stays open, the artifact
stays readable, and un-retiring restores it. What retire actually says is
"this artifact is obsolete and the conversation continues", which is a
different state from a finished conversation.

So the reason for withdrawing it is weaker than the earlier draft claimed,
and it is this: with one artifact per conversation, "this artifact is
obsolete and the conversation continues" describes a conversation whose only
document is obsolete. Nobody has named a use for that state, and it costs a
control, a confirmation, a banner and a flag on the wire. It is withdrawn on
those grounds, not because it is identical to a finished conversation.

That is a weaker argument, and it means retire can come back cheaply if a use
appears. The `artifact-meta` entry source stays, because RFC-07 R11's title
uses it.

What happens to `retired` needs saying precisely, because an earlier draft
said the fold "already ignores" it. It does not. Today the fold parses it
into `artifactRetired`, the catalog carries it, and the state block marks the
artifact `RETIRED` for the agent. It becomes ignored only after the
implementation removes those readers. After that, a `retired` field in a
record written by an older build is tolerated and unread, on R5's terms.

### R5 - The fold stays total

- The fold MUST NOT begin to throw on a log holding two artifacts.
- A record written by an older build, by hand, or by a build whose emission
  path had a defect MUST still open.

Reading such a record is not the whole question, and an earlier draft stopped
there. **Writing to one has to be defined too**, because `E-ART-09` compares
an emission against "the artifact the record holds" and a two-artifact record
holds two. `replaces: 1` is ambiguous when both artifacts have a version 1.

- In a record holding more than one artifact, an emission naming any
  `artifactId` the record already holds MUST be accepted as a revision of
  that artifact, on RFC-06's terms.
- An emission naming an `artifactId` the record does NOT hold MUST be refused
  with `E-ART-09`, and the refusal MUST name every id the record holds.
- The page MUST display one of them. Which one is unspecified here, because
  no such record exists; a reader MAY take the first in the fold's order.

This is the smallest rule that leaves an old record usable without inventing
a merge. It never applies to a record written under this RFC, because such a
record cannot acquire a second artifact.

The reason it beats opening such a record read-only is that it needs no
machinery beyond the guard R2 already requires. R2's guard is one predicate:
the record holds at least one id, and the emitted id is not among them. For a
one-artifact record that predicate IS R2. For a two-artifact record the same
predicate, unchanged, gives the rule above. Read-only needs a second branch,
and a different refusal, because `E-ART-09` tells the agent to reuse a held
id and read-only refuses that too.

An earlier draft justified this rule by saying that refusing gains nothing
and adds a way to make a record unopenable. That is false on the write path.
Openability is the fold's property, secured by the first two bullets above,
whatever the emission path does.

**The rule does have a cost, and it is this.** In an old two-artifact record
nothing stops the agent revising either artifact while the page displays
one, unspecified which. That is the page and the agent disagreeing about what exists, which
the Problem statement calls a correctness floor. It is accepted here because
no such record exists and none can now be created.

No such record exists on the machine this was built on. The rule is not about
migrating anything. It is that refusing gains nothing and adds a way to make
a record unopenable, and the fold has been total over records it did not
write since RFC-04 P1.

## Message Formats

The artifact fence is unchanged. RFC-06's header and RFC-08's `form` both
stand:

```
```lucid-artifact
{"id": "checklist", "replaces": 12, "contentType": "text/html", "form": "patch"}
...
```
```

What changes is which `id` is acceptable, not how one is written. An agent
that emits the id the record already holds sees no difference at all.

## State Machine

An artifact emission, from arrival to a version in the record. This extends
RFC-08's machine with one guard and changes nothing else.

```
ARRIVED   -> PARSED     (on: the fence body is valid for its form)
ARRIVED   -> REFUSED    (on: malformed header or body)

PARSED    -> FIRST      (on: the record holds no artifact, guard: form=whole)
PARSED    -> REFUSED    (on: the record holds no artifact, form=patch; E-PATCH-01)
PARSED    -> REVISION   (on: id equals the artifact the record holds)
PARSED    -> REFUSED    (on: id differs from the one the record holds; E-ART-09)

FIRST     -> APPENDED   (on: size within ARTIFACT_BYTES_MAX)
FIRST     -> REFUSED    (on: size over ARTIFACT_BYTES_MAX)
REVISION  -> ...        (RFC-08's APPLYING/RESOLVED path, unchanged)
```

The new edge is `PARSED -> REFUSED` on a differing id. It is checked before
the form is applied, because applying a patch against a document the agent
did not name would produce a version nobody asked for.

`FIRST` is a new state, so RFC-08's rules do not reach it by inheritance and
are written out. Its `form=whole` guard is RFC-08's "a patch is a revision,
never a creation", and its `REFUSED` edge is the size refusal Error Handling
has always carried. An earlier draft had neither, which read as though a
first-emission patch walked straight to `APPENDED`.

## Error Handling

```
E-ART-09  second-artifact                (severity: warning)
          An artifact emission named an `artifactId` other than the one
          the record holds.
          Recovery: refused, nothing appended. The reason names the
          artifactId the record holds. The agent reuses it, or emits the
          whole document under it if it means to replace the document.
          Escalation: none. A refused artifact has never ended a turn
          and does not start now.
```

The existing artifact refusals are unchanged: a stale `replaces`, an
oversize document, and RFC-08's `E-PATCH-01` through `E-PATCH-08` all keep
their meanings.

**Precedence, because more than one can apply to one emission.** A patch
naming a second id with `replaces: null` matches `E-ART-09` and
`E-PATCH-01`. An oversize whole form naming a second id matches `E-ART-09`
and the size refusal.

- Among the refusals that apply to a block whose header parsed, the identity
  check MUST run first, and `E-ART-09` MUST be reported in preference to the
  others.
- A refusal that prevents the header being read at all MUST still precede it.
  That is `ARRIVED -> REFUSED` in the state machine: a malformed block, and
  `E-PATCH-07` for an unrecognised `form`, which `parseHeader` reports as
  malformed. There is no id to check against until the header parses.

An earlier draft said `E-ART-09` takes precedence over any other refusal
whatever. That cannot be implemented and contradicted this RFC's own state
machine, which puts malformed before `PARSED`.

Identity runs first among the rest because its answer makes them moot: an
emission for a document this conversation does not hold does not need its
patch parsed or its size measured, and reporting a size refusal for an
artifact that was never going to be accepted tells the agent to fix the wrong
thing. It is not the cheapest check, which an earlier draft also claimed:
identity reads the durable artifact index, while malformed and size are local
string checks.

`E-ART-07` (a title outside the bound) survives with RFC-07 R11.

`E-ART-02` (`artifact-retired`) is withdrawn with R12, because nothing can be
retired any more.

**`E-ART-04` is NOT withdrawn.** An earlier draft withdrew it as a retirement
error. It is not one: RFC-07 defines it as `queue-full`, the annotation queue
bound from R10, which this RFC does not touch and which
`src/protocol/annotations.ts` still enforces.

**`E-ART-01` survives, and its recovery changes.** RFC-07 defined its
recovery as choosing another artifact from the list, and this RFC withdraws
the list. A URL naming an artifact the conversation does not hold MUST
instead offer the conversation's own artifact, or `/c/:conversationId` when
the conversation holds none.

## Security Considerations

This RFC removes surface rather than adding it, so most of its security
content is what stops being reachable.

**A refusal quotes agent-supplied text.** `E-ART-09` names the `artifactId`
the record holds, which lucid wrote, and MAY name the one the agent sent,
which it did not. Any quoted agent text MUST be bounded on RFC-08 R7's terms:
JSON-quoted so control characters cannot break the line, and cut to
`REFUSAL_QUOTE_MAX`. Unbounded, an emission with a very long id would be a
way to write arbitrary length into the record.

**The refusal must not become a way to probe.** `E-ART-09` is reported to the
agent driving the conversation, which already knows what the record holds
because the state block tells it. It carries no information the agent could
not already read.

**Removing the list removes a rendering surface.** RFC-07's list rendered
agent-chosen ids and person-written titles in lucid's own chrome. Both were
text, never markup. That rule stands for the one name still displayed.

**The fold staying total is a security property, not only a compatibility
one.** A fold that throws on an unexpected shape turns a malformed or
unfamiliar log into an unopenable record, which is a denial of service
against a person's own data.

## Versioning

The change is a narrowing of what lucid accepts, so the order matters.

A lucid with this RFC opens every record an older lucid wrote, including one
holding two artifacts: R5 requires it. What it will not do is accept a new
second artifact.

A record written under this RFC opens on an older lucid unchanged, because
nothing about the entries changes. An older lucid shows its list, finds one
artifact in it, and suppresses the row below two.

So there is no migration in either direction, and no ordering requirement
between deploying this and anything else.

## Implementation Notes

Ordered so each step leaves the suite green.

1. **Refuse a second id.** The guard in the emission path, its error, and its
   tests. This is the whole protocol change, and it can land before any UI is
   touched.
2. **Remove retire.** The controls, the banner, the reveal, the `retired`
   flag on the catalog, and the `RETIRED` marking in the state block. The
   `artifact-meta` entry source stays: RFC-07 R11's title uses it. After this
   step, and only after it, a `retired` field in an older record is tolerated
   and unread, per R5.
3. **Remove the list, and replace what it was doing for `E-ART-01`.** The
   unknown-artifact page's only way out today is `AlsoHere` plus its "Show
   what it does have" button. Deleting `AlsoHere` without putting the new
   recovery in its place leaves that page a dead end, so both happen in one
   step: the page offers the conversation's own artifact, or
   `/c/:conversationId` when it holds none.
4. **Close the two-pane ticket** as out of scope, with the reason.

Steps 2 and 3 are deletions. Step 1 is the only new behaviour, and most of
the risk is there.

## Open Questions

1. **Should the URL keep the artifact segment?** RFC-07 R1 serves
   `/c/:conversationId`, `/c/:conversationId/:artifactId` and
   `/c/:conversationId/:artifactId/:version`. With one artifact the middle
   segment names the only thing there is.
   Options: collapse to `/c/:conversationId` and
   `/c/:conversationId/v/:version`, which is honest but breaks every link
   anyone has; keep all three, where the artifact segment is redundant but
   harmless and existing links keep working; keep all three and stop
   generating the long form.
   Decided by: whether any link outside this machine exists. If none does,
   collapsing is free.
   Recommended: keep all three and stop generating the long form. It costs
   nothing and defers the choice.

2. **Does `E-ART-09` need to distinguish "the agent renamed its document"
   from "the agent meant a second document"?** Both arrive as a differing id
   and both are refused the same way. The first is a mistake the title
   mechanism already answers; the second is the thing this RFC declines.
   Options: one error, as specified; two errors, if the agent's next move
   should differ.
   Decided by: whether an agent, told only "reuse `checklist`", does the
   right thing. Measurable the way RFC-08 Open Question 1 was.

## Alternatives Considered

**Leave it.** The list, the panes and retire keep working, and the cost is
carrying a document manager inside a tool for reading one document. The
surface does not break anything on its own; it just is not what lucid is
for, and every future artifact decision would have to keep it coherent.

**Fold a second id into the existing artifact.** The agent never sees a
failure and the record stays single-artifact. Rejected: it makes the agent's
own instruction mean something else, silently, and lands a document under a
name the agent did not choose. RFC-08 rejected the same shape for unknown
fields on an edit, for the same reason.

**Keep retire as "do not revise this", without the list.** It is the one
retire behaviour that is not about the list, so it is the one that could
stand alone. Rejected on R4's grounds, which are weaker than an earlier draft
claimed and are stated as weaker there: nobody has named a use for a
conversation whose only document is obsolete, and the state costs a control,
a confirmation, a banner and a flag on the wire.

An earlier draft rejected it here by saying it means "this conversation is
finished". R4 retracts that equivalence, because the shipped behaviour ends
nothing: the input endpoint stays open and the artifact stays readable. This
entry said the retracted thing anyway, so the RFC argued both sides of one
question. The equivalence is not the reason. The absent use is.

**A session-level finished state**, as v1 has. v1's `Approve review` appends
`review_resolved`, which ends the agent's involvement: work sent afterwards
is never read. It fits v1, which was for making plans, where approval gates
execution. v2 has no plan-then-execute shape and its documents have many
purposes, so there is nothing for approval to gate. Declined, and recorded
here so the next person asking does not have to re-derive it.

**Type artifacts, and act on the type.** Considered: declare what kind of
document an artifact is, and let lucid behave differently for each.
Rejected: the type would be agent-declared, so it is the agent guessing what
a person intends to do with something it just wrote. Once the field exists,
code branches on it, and a mis-typed artifact behaves wrong in a way nobody
can see. It also needs maintaining, since every new kind of thing the agent
makes becomes a taxonomy decision. The signal it would carry is already
available, un-automated and impossible to get wrong: a person renames the
document, or writes a note.

## What this costs

Recorded because it is unusual for an RFC to delete working code.

- **#122, retire and un-retire**, shipped 2026-08-26, is reverted in full.
  About four hundred lines across the store, the endpoint, the page and its
  tests.
- **#123, two artifact panes**, is closed unbuilt.
- **The `artifact-meta` entry source survives**, because RFC-07 R11's title
  uses it. The record work behind #121 and #122 is therefore not wasted; the
  retire surface is.
- **#121, rename**, matters more after this than before. With no list, the
  title is the only name a person controls.

## What the review changed

One cross-family review, `gpt-5.6-sol@codex`, filed as
`09_one-artifact-per-conversation.review-draft-2026-08-27.md`. Ten findings,
all applied. Three were verified directly before being acted on.

| Finding | What changed |
|---|---|
| F-01 | `E-ART-04` is `queue-full`, not a retirement error. It is no longer withdrawn. Verified against RFC-07 and `src/protocol/annotations.ts` |
| F-02 | R5 said an old two-artifact record must still open and stopped there. Writing to one is now defined: any id the record holds is a revision, an unknown one is refused naming all of them |
| F-03 | The first-emission rule was a second reversal, unnamed. RFC-06 permits an unknown id with a non-null `replaces`, and a test fixes it. The rule is restored and the earlier error is recorded |
| F-04 | Refusal precedence was undefined when several errors apply. The identity check runs first and `E-ART-09` is reported in preference |
| F-05 | `E-ART-01`'s recovery was the list, which this RFC withdraws. Recovery redefined as the conversation's own artifact |
| F-06 | The claim that retire equals a finished conversation was too strong. The shipped behaviour ends nothing. The withdrawal now rests on a weaker, stated argument, and says retire can come back cheaply |
| F-07 | The second pane was specified and never built. The RFC no longer implies it deletes working code |
| F-08 | The four-job table read as though `artifactId` goes idle. It keeps every internal duty, and the RFC now forbids dropping its checks |
| F-09 | `REFUSAL_QUOTE_MAX` was called a byte bound and counts UTF-16 units. Verified: 128 characters of a three-byte code point quote to 386 bytes. Fixed in `src/protocol/artifacts.ts` and corrected in RFC-08 R7 |
| F-10 | The usage evidence is one user and one machine. It corroborates the decision rather than carrying it. RFC-07's cross-artifact comparison case is now answered instead of passed over |

### The second pass

`glm-5.3@pi` at `xhigh` effort, routed to share no family with the author or
the first reviewer, filed as
`09_one-artifact-per-conversation.review-2-draft-2026-08-27.md`. Deliberately
narrow: it read only the text written in response to the first review, which
nobody had read. Eight new findings, all applied.

| Finding | What changed |
|---|---|
| N-01 | R5's write policy was justified by a sentence that is false on the write path: openability is the fold's property. Replaced with the argument that holds, that the rule shares its predicate with R2 while read-only needs a second branch. The rule's real cost is now stated: in an old two-artifact record the page and the agent can disagree, which the Problem statement calls a floor |
| N-02 | Alternatives Considered still rejected retire on the equivalence R4 had just retracted, so the RFC argued both sides of one question. Rewritten onto R4's grounds |
| N-03 | "the fold already ignores a `retired` field it no longer reads" is false today. The fold parses it, the catalog carries it, the state block marks it. It becomes true only after the implementation removes those readers. A comment in `src/store/log.ts` said the same false thing and is fixed |
| N-04 | "`E-ART-09` in preference to any other refusal" cannot be implemented and contradicted this RFC's own state machine: a malformed block has no id to check, and `E-PATCH-07` is reported as malformed. Scoped to blocks whose header parsed. The "cheapest check" claim was also false and is dropped |
| N-05 | `FIRST` had no form guard and no oversize edge, so a first-emission patch read as walking to `APPENDED`. `FIRST` is a new state, so RFC-08's rules are written out rather than inherited |
| N-06 | The restored first-emission rule needed scoping to the whole form. A first emission that is a patch is `E-PATCH-01` |
| N-07 | The duties paragraph claims completeness and missed one: a person's title is stored under and looked up by `artifactId` |
| N-08 | No implementation step replaced what `AlsoHere` was doing for `E-ART-01`, so removing the list would have left the unknown-artifact page a dead end. Folded into that step |

It also cleared two things the first reviewer could not. It traced `replaces`
through `handleArtifactMessage` and confirmed the per-id scoping makes R5's
rule resolve against the right artifact by construction. And it verified by
reading that no two-artifact record exists.

Neither reviewer could execute anything. The first could not run tests
(`mkdtemp` returned `EPERM`); the second had no exec surface at all. Both say
so. What that leaves unverified is the runtime behaviour, which the
implementation's own tests will cover.

The first review was routed with `excludeFamilies: ["claude"]`. Two things about
that routing belong here. The registry's first choice,
`muse-spark-1.2-contributor@muse`, could not read a file and asked a question
instead of reviewing, so the fallback was taken by hand. The registry also
warned that no candidate meets the high-stakes bar for `code-review` once
Claude is excluded, so the review was below the bar it was asked to clear.
Its findings were verified rather than taken, and the three graded 4 were
each reproduced before being acted on.

## References

### Normative

- RFC-06, "An artifact you can address" - the fence, the header, `id` and
  `replaces`.
- RFC-07, "Many artifacts in one record and the history you can move
  through" - R2, R3 and R12 are withdrawn here; R1, R11 and the version rules
  stand.
- RFC-08, "Revising an artifact without retyping it" - the `form` field, the
  refusal discipline, and R7's bound on quoted text in a refusal.
- RFC 2119, "Key words for use in RFCs to Indicate Requirement Levels".

### Informative

- `CONTEXT.md` - what lucid is and who it is for.
- `docs/decisions.md` - the decision register, explicitly history rather than
  a live register; a decision there can be superseded by an RFC.
- lucid v1, `client/chrome/Header.tsx` - `Approve review` and D-064, the
  session-level finished state this RFC declines.

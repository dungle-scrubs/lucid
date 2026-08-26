---
number: 08
title: "Revising an artifact without retyping it"
type: protocol
status: Draft
author: Kevin Frilot
date: 2026-08-26
---

# RFC-08: Revising an artifact without retyping it

## Abstract

Every revision of an artifact re-emits the whole document. An edit therefore
costs output tokens in proportion to the document, not to the change, and the
emissions accumulate in the harness session's context. Measured on a live
record: a 27 KB document took about 6,700 output tokens and 127 seconds to
revise, and ten revisions moved 43,581 output tokens. This RFC adds a second
body form to the `lucid-artifact` fence: an anchored replacement. lucid
applies it and appends the full resulting version exactly as it does today,
so the record does not change shape - every version stays complete, hashed
and append-only. Whole-document emission stays legal, and stays the only way
to create version 1.

## Introduction

### Problem statement

RFC-06 gives the agent one way to revise a document: emit the whole thing
again inside a `lucid-artifact` fence. That is simple to store and simple to
read back, and it has one cost that grows.

Measured on `~/.lucid2/records/demo`, which holds thirteen versions of one
document:

| | |
|---|---|
| document at v1 | 6,476 bytes |
| document at v13 | 27,183 bytes |
| last agent revision | ~6,700 output tokens |
| wall clock for that revision | **127 seconds** |
| output across 10 agent emissions | **43,581 tokens** |

**Output is the axis this RFC rests on.** At 4 bytes per token, the ten agent
emissions total 43,581 tokens. Replacing the nine revisions after v1 with
patches of about 2 KB gives 6,227, a **7x** reduction. Per revision at
today's document size that is ~6,795 tokens against ~512, a **13x**
difference that grows with the document.

Three things about those figures, so the reader weighs them correctly.

**The patch size is stipulated, not measured.** 2 KB per patch is an
estimate. Exactly-once matching on HTML with repeated substrings forces
anchors wide enough to be unique, often 100 to 300 bytes each, and the fence,
the header and the `{"edits": [...]}` wrapper are output tokens too. A patch
with several edits can exceed 2 KB. The 7x is the top of a range, and its
bottom is not known until it is measured.

**The 127 seconds supports a weaker claim than "it is the agent retyping".**
Wall clock includes time to first token, the model's own reasoning, and
harness streaming. 6,697 tokens at typical hosted output rates is 75 to 135
seconds, so the figure is consistent with retyping dominating - but
consistency is not attribution, and no control was run. What is established
is that latency tracks output size on this record: the three chat replies in
the same conversation, which emit almost nothing, returned in 2.6, 4.3 and
3.3 seconds.

**Context is not quantified here, deliberately.** An earlier draft equated
the 43,581 output tokens with the context those emissions occupy. That is
wrong in both directions. It omits the preamble, the per-turn
`[lucid artifact state]` block, every user input and the model's own
reasoning, so it understates context; and it credits the patch form with
savings it does not make, because `composeArtifactState` prepends a
human-saved document to every non-answer input until the agent supersedes it,
patch form or not. The direction is not in doubt - emissions accumulate in a
`headless-session` window, so context grows with revisions times document -
but this RFC no longer puts a number on the saving. Open Question 1 says what
would settle it.

Two consequences follow, and both worsen with use:

1. **Latency grows with the document.** Each revision is longer than the one
   before it, because the document is longer.
2. **Context grows with the number of revisions.** A `headless-session`
   driver keeps one harness session, so every prior emission stays in its
   window.

### Scope

In scope:

- A second body form for the `lucid-artifact` fence: an anchored replacement.
- What lucid does with it: apply, then append the full result.
- What happens when it does not apply.

Explicitly out of scope:

- **Any change to how a version is stored.** The record keeps complete
  versions, hashed, append-only. This RFC changes what crosses the wire and
  nothing else.
- **A patch as a stored artifact.** lucid MUST NOT append a patch. It appends
  the document the patch produced.
- **Creating an artifact.** Version 1 has nothing to anchor against.
- **Putting the artifact on a file the agent edits directly.** Considered and
  rejected; see Alternatives.
- **Cross-artifact or multi-artifact patches.** One block, one artifact, as
  today.

### Motivation

The cost was known in the abstract when RFC-06 was written and is now
measured. It is also compounding: the document in the record grew from 6 KB
to 27 KB over thirteen versions, so every future revision of it is slower
than every past one.

The change is small because the record does not move. The fence gains a form;
the fold, the index, `restore`, `basedOn`, and annotation anchoring are all
untouched, because what lands in the log is byte-for-byte the same kind of
entry it is today.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD
NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted
as described in RFC 2119.

Terms from `CONTEXT.md` carry their meaning from there: record, artifact,
version, save, annotation batch, spot. This RFC uses them unchanged. New
terms:

| Term | What it is |
|---|---|
| **whole form** | A `lucid-artifact` block whose body is the document. What RFC-06 defined, still legal |
| **patch form** | A `lucid-artifact` block whose body is a list of anchored replacements |
| **edit** | One replacement inside a patch form: text to find, text to put in its place |
| **anchor** | The exact text an edit finds. Not a selector, not a line number |
| **apply** | Running a patch form against the version it names, producing the next document |

## Protocol Overview

The fence is unchanged. What may follow the header is not.

```
```lucid-artifact
{"id": "checklist", "replaces": 12, "contentType": "text/html", "form": "patch"}
{"edits": [
  {"find": "<li>Read the brief</li>", "replace": "<li>Read the brief carefully</li>"},
  {"find": "</ul>", "replace": "<li>Confirm the record folds back</li>\n</ul>"}
]}
```
```

- `form` is OPTIONAL and defaults to `"whole"`, so every block RFC-06 defines
  keeps its meaning with no change to what the agent writes.
- `form: "patch"` says the body is JSON describing edits rather than a
  document.

### R1 - The patch form is a revision, never a creation

- A block with `form: "patch"` MUST carry a `replaces` naming an existing
  version. `replaces: null` with `form: "patch"` MUST be refused: there is
  nothing to anchor against.
- `replaces` MUST be the current version, on the same terms as the whole form
  today. A stale `replaces` is refused, unchanged.

### R2 - What an edit is

An edit is exact text replacement, and deliberately nothing cleverer.

- `find` MUST be a non-empty string. It is matched **literally** against the
  bytes of the version named by `replaces`. Not a regular expression, not a
  CSS selector, not a line range.
- `find` MUST match **exactly once** in that version. Zero matches and two or
  more matches are both refusals, with different reasons - see Error
  Handling. An edit that could land in two places is not an instruction.
- `replace` MUST be a string. It MAY be empty, which deletes the matched
  text.

**Every anchor MUST be resolved against the version named by `replaces`,
before any edit is applied.** The first draft of this RFC said edits apply in
order, each against the result of the one before, and that a later edit may
anchor on text an earlier one introduced. That is unsafe.

An earlier edit changes the text a later edit would match against. Three
things follow, and only two fail loudly:

1. The earlier edit **removes** the later anchor. Not found: `E-PATCH-02`.
2. The earlier edit **duplicates** it. Ambiguous: `E-PATCH-03`.
3. The earlier edit **alters the surroundings** so the later anchor still
   matches exactly once, in a place the agent did not mean. **No error.** The
   document is wrong and nothing says so.

The third is worse than either failure this RFC otherwise handles: a refusal
costs a turn, a silent wrong-target costs a version nobody reviewed.
Resolving every anchor up front removes it. What an edit matches is decided
by the document the agent was looking at, which is the document it wrote the
patch against.

- lucid MUST locate every `find` in the version named by `replaces`, and MUST
  check exactly-once for every edit, before applying any of them.
- Two edits whose matched regions overlap MUST be refused (`E-PATCH-08`).
  Applying both would make the second act on text the first replaced, which
  is the ordering problem by another route.
- Non-overlapping edits are then applied by position, so the result does not
  depend on the order they were listed in.
- A later edit therefore MUST NOT anchor on text an earlier edit introduces.
  That is a real loss, and it is why the preamble tells the agent that a
  change needing it is a case for the whole form. It buys the guarantee that
  a patch which applies at all applies where the agent meant.

Exactness is the whole design. A fuzzy match would let a patch land somewhere
the agent did not mean, and lucid cannot tell a near-miss from a hit. RFC-06
already made this choice for annotation anchoring, where a spot that cannot
be found exactly is reported as lost rather than guessed at.

### R3 - What lucid does with it

1. Read the version named by `replaces`.
2. Resolve every anchor against that version, check exactly-once for each and
   refuse any overlap, then apply the edits by position, in memory. Never in
   the order they were listed: R2 is what makes the result independent of
   that order.
3. Check the result against `ARTIFACT_BYTES_MAX`.
4. Append the **result** as the next version, complete, exactly as a whole
   form is appended today: same entry, same author, same hash over the same
   kind of bytes.

The patch is never stored. Nothing in the record says a version arrived as a
patch, and nothing needs to: a reader wants the document, and the document is
what is there.

Two things are the same and one is not, stated so nobody has to work it out.
The bytes, the hash over them, the author, and `basedOn` are what a whole
form would have produced. `version` and `at` are assigned by lucid on the
result, as they always are - so a patch-produced version is not
byte-identical to a whole form emitted at a different moment, and anything
ordering by `afterSeq` (RFC-07) sees where it landed, not how it arrived.

One bound moves, and in the safe direction. Artifact bytes reach
`handleArtifactMessage` inside a message event, which is capped at
`TEXT_MAX`. Under the whole form that cap applies to the document, so a
document near 1 MB cannot arrive at all. Under the patch form only the small
patch body transits, so a patch MAY produce a document larger than any single
message could have carried. `ARTIFACT_BYTES_MAX` on the result is therefore
the only bound left, which is why R3 checks it there and R7 bounds the sum of
replacements before applying.

### R4 - A patch applies completely or not at all

- If any edit fails, lucid MUST append nothing. There is no partial apply and
  no partial version.
- The refusal MUST name which edit failed and why, so the agent can fix that
  edit rather than re-sending the whole patch blind.

### R5 - The whole form remains

- The whole form MUST remain legal for any revision, not only for creation.
- An agent that cannot construct a patch confidently SHOULD emit the whole
  form. It is slower, never wrong.
- lucid MUST NOT require the patch form or refuse a whole form for being
  large.

### R7 - Everything a patch can grow is bounded

Security requires each of these, and an unnamed bound is not a bound. Values
are proposed; Open Question 2 covers changing them.

| What | Bound | Why |
|---|---|---|
| edits in one block | **50** | A revision needing more than fifty anchored edits is a rewrite, and the whole form is what a rewrite is for |
| `find` length | **4,096 bytes** | An anchor wide enough to be unique is far below this. Beyond it the agent is quoting the document, and the whole form is cheaper |
| `replace` length | **65,536 bytes** | Larger than any single edit needs, small enough that one edit cannot approach `ARTIFACT_BYTES_MAX` alone |
| sum of all `replace` lengths | **`ARTIFACT_BYTES_MAX`** | Refuses before applying, so a patch cannot ask lucid to build a document it will then refuse |
| quoted text in a refusal reason | **200 bytes** | See Security |

Exceeding any of these is `E-PATCH-05`. The result is still size-checked
after applying, per R3: these bounds refuse the obvious cases cheaply, and
the check on the result is what actually holds.

### R6 - What the agent is told

The artifact preamble gains the patch form. It MUST say:

- that the patch form exists and what it costs to get wrong;
- that `find` is literal and must match exactly once;
- that the order edits are listed in does not affect the result, because
  every anchor is resolved against the version named by `replaces`;
- that a failed patch is refused whole, with a reason, and can be retried;
- that the whole form is always available and is the right choice when the
  agent is unsure what the current document holds, or when a change needs one
  edit to build on another;
- that every anchor is resolved against the version named by `replaces`, so
  an edit cannot depend on an earlier edit in the same patch.

The preamble is instructions, so it is still sent once per session under
`headless-session`, as RFC-07 established.

## Message Formats

### The header

```json
{
  "id": "checklist",
  "replaces": 12,
  "contentType": "text/html",
  "form": "patch"
}
```

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Unchanged from RFC-06 |
| `replaces` | yes for `form: "patch"` | MUST name an existing version, and MUST be current |
| `contentType` | yes | Unchanged. The patch does not change the type |
| `form` | no | `"whole"` (default) or `"patch"`. Any other value is refused |

### The patch body

```json
{
  "edits": [
    { "find": "<exact text from the named version>", "replace": "<what goes there>" }
  ]
}
```

- The body MUST be a single JSON object. It MUST have an `edits` array with
  at least one entry.
- Every entry MUST have a string `find` and a string `replace`, and no other
  fields. An unknown field on an edit MUST be **refused**, not ignored.

  An earlier draft said to ignore them, reasoning about forward compatibility
  by habit. That reasoning does not apply: the patch body is never stored, so
  there is no durable reader to stay compatible with. The only reader is the
  lucid applying it, now. Ignoring an unknown field means a future agent could
  send `{"find": ..., "replace": ..., "mode": "regex"}` to a lucid that does
  not implement `mode`, and have it silently applied as a literal - the
  agent's instruction quietly meaning something else. Refusing says so.
- The number of edits in one block MUST be bounded; see Open Question 2.

## State Machine

A block, from arrival to a version in the record.

```
ARRIVED      -> PARSED        (on: the fence body is valid for its form)
ARRIVED      -> REFUSED       (on: malformed header or body)

PARSED       -> RESOLVED      (on: form=whole; the bytes are the document)
PARSED       -> APPLYING      (on: form=patch, guard: replaces names a readable version)
PARSED       -> REFUSED       (on: form=patch with replaces null or unreadable)

APPLYING     -> RESOLVED      (on: every edit matched exactly once, no two overlap)
APPLYING     -> REFUSED       (on: any edit matched zero or several times, or two overlap)

RESOLVED     -> APPENDED      (on: size within ARTIFACT_BYTES_MAX, replaces is current)
RESOLVED     -> REFUSED       (on: too large, or replaces is stale)
```

- `REFUSED` is terminal for that block and appends nothing. The turn
  continues: a refused artifact has never ended a turn and does not start
  now.
- `APPLYING` holds no state anywhere but memory. A crash during it leaves the
  record exactly as it was.
- Two blocks in one message each walk this machine independently and in
  order, unchanged from RFC-06. The second MAY name the version the first
  produced, which means the read in `APPLYING` MUST consult the in-message
  version map (`localVersions` in `handleArtifactMessage`) before the durable
  index. Reading only the durable index would make the second block anchor
  against the version before the first block's, silently.
- If the first block is appended and the second is refused, the first stays.
  That is RFC-06's behaviour for two whole forms and this RFC does not change
  it: R4's "completely or not at all" is a rule about one patch, not about a
  message.

## Error Handling

```
E-PATCH-01  patch-without-base            (severity: warning)
            form=patch with replaces null.
            Recovery: refused, nothing appended. The agent emits the
            whole form to create the artifact.
            Escalation: none.

E-PATCH-02  patch-anchor-not-found        (severity: warning)
            An edit's `find` matched nothing in the named version.
            The likeliest cause is the agent working from a stale idea
            of the document - see Open Question 1.
            Recovery: refused whole, nothing appended. The reason names
            the edit index and the opening of the `find` text it could
            not locate, bounded per R7.
            lucid MUST then include the current version's bytes in the
            next prompt for that artifact. This is new behaviour, not a
            restatement: composeArtifactState carries bytes today only
            for a version a person saved, so the agent's OWN current
            version - which is exactly the one a patch failed against -
            is the one thing it is never sent. Without this the retry is
            another guess from the same stale picture.
            Escalation: none.

E-PATCH-03  patch-anchor-ambiguous        (severity: warning)
            An edit's `find` matched more than once.
            Recovery: refused whole, nothing appended. The reason names
            the edit index and how many places it matched. The agent
            lengthens the anchor and retries.
            Escalation: none.

E-PATCH-04  patch-malformed               (severity: warning)
            The body is not a JSON object, has no `edits` array, has an
            empty one, or an entry is missing a string `find` or
            `replace`.
            Recovery: refused, nothing appended.
            Escalation: none.

E-PATCH-05  patch-too-many-edits          (severity: warning)
            More edits in one block than the bound allows.
            Recovery: refused, nothing appended. The agent splits the
            work across blocks or emits the whole form.
            Escalation: none.

E-PATCH-06  patch-result-too-large        (severity: warning)
            The applied result exceeds ARTIFACT_BYTES_MAX.
            Recovery: refused, nothing appended. Identical in effect to
            an oversize whole form today, which is what makes this a
            reused rule rather than a new one.
            Escalation: none.

E-PATCH-08  patch-edits-overlap           (severity: warning)
            Two edits matched overlapping regions of the named version.
            Recovery: refused whole, nothing appended. The reason names
            both edit indexes. Applying both would make one act on text
            the other replaced, which is the ordering hazard R2 removes
            by resolving every anchor up front.
            Escalation: none.

E-PATCH-07  unknown-form                  (severity: warning)
            `form` is present and is neither "whole" nor "patch".
            Recovery: refused rather than assumed. Guessing "whole" for
            an unrecognised form would apply a body that is not a
            document as though it were one.
            Escalation: none.
```

Every one of these refuses before any append. None is terminal for the turn.
`replaces` being stale keeps the refusal RFC-06 already defines; this RFC
adds no new rule for it.

## Security Considerations

**A patch is agent-authored input that mutates a stored document.** That is
the difference from the whole form, where the agent supplies the entire
result and lucid stores it verbatim. Here lucid performs an operation
described by the agent against bytes the agent did not supply and may not
have seen.

- **Matching MUST be literal and total.** `find` is compared as bytes. No
  regular expression is compiled from agent input, so there is no pattern
  the agent can write that costs unbounded time to match.
- **Exactly-once MUST be enforced before anything is applied**, not
  discovered while applying. An edit matching twice is a refusal, never a
  choice of which one.
- **A patch MUST NOT partially apply.** Every refusal leaves the record
  untouched, so a failed patch can never produce a version nobody wrote.
- **The applied result MUST be size-checked** against `ARTIFACT_BYTES_MAX`
  before the append. A small patch can produce an arbitrarily large document
  - an edit whose `replace` is enormous, or an edit that duplicates a large
  region - so checking the patch's own size would check the wrong thing.
- **Every dimension a patch can grow MUST be bounded** - edit count, `find`
  length, `replace` length, and the sum of replacements - per R7. Bounding
  the count alone leaves one edit with an enormous `replace`, which is
  refused only after it has been applied in memory.

**Trust boundary, unchanged.** The document still renders in a frame
sandboxed without `allow-same-origin`, so an agent that writes hostile markup
through a patch reaches no further than one that writes it whole. This RFC
does not widen what a document can do; it changes how the bytes arrive.

**Prompt injection.** A refusal reason quotes part of a `find` string back to
the agent. That text is agent-authored, so the quoting is a round trip rather
than a new channel. Reasons MUST quote at most **200 bytes** of it (R7), so a
crafted `find` cannot use the refusal path to carry a large payload into the
next prompt.

**Blast radius.** The worst case is a version that says something the person
did not intend, which is the worst case for the whole form too, and it is
recoverable the same way: every prior version is in the record and `restore`
brings one back.

## Versioning

`form` is an additive, optional header field with a default that preserves
present behaviour. The compatibility this buys, and the compatibility it does
not:

- **An older lucid reading a newer agent's patch block** does not know
  `form`, ignores it, and treats the patch JSON as a document. It would store
  the patch as the artifact - an entry that cannot be un-appended, only
  superseded. This is the real hazard of the change: **lucid MUST be able to
  apply patches before any agent is told the form exists.**

  The preamble ships with lucid, which makes an upgrade safe by construction.
  It does not make two other cases safe, and both are named rather than
  assumed:

  - **A rollback.** Downgrading lucid while a session is running leaves an
    agent that has already been told the form exists talking to a lucid that
    does not know it. An older lucid therefore MUST refuse a block carrying
    any `form` it does not recognise rather than defaulting to `whole` -
    which is what `E-PATCH-07` says, and why that rule is worth having before
    the form is used rather than after.
  - **A running `headless-session`.** RFC-07 sends the preamble once per
    session, so a session that started before the upgrade never hears about
    the form and keeps emitting whole documents. That is correct behaviour,
    not a gap, but it means the change does not take effect on a long-running
    driver until it restarts.
- **A newer lucid reading an older agent's whole block** sees no `form`,
  defaults to `"whole"`, and behaves exactly as before.
- **The record** gains nothing and changes nothing, so every reader of a
  record - older or newer - is unaffected. This is what makes the change
  cheap: nothing durable is being versioned.

## Implementation Notes

Ordered so each step leaves the suite green.

1. **Parse the form.** `ArtifactHeader` gains an optional `form`. An
   unrecognised value is `E-PATCH-07`. Nothing else changes; every existing
   block still parses as `whole`.
2. **Parse the patch body.** A pure function from body text to a list of
   edits or a refusal reason. No I/O, so it is tested directly.
3. **Apply.** A pure function from `(document, edits)` to a new document or
   a refusal naming the edit index. Every anchor is located in the ORIGINAL
   document, exactly-once is checked for all of them, and overlaps are
   refused - all before a byte is replaced. Applying then goes by position.
   No I/O, so this is where most of the oracle lives.
4. **Wire it into emission.** `handleArtifactMessage` reads the version named
   by `replaces`, applies, size-checks, and appends the result through the
   same `writeArtifact` path a whole form uses.
5. **Tell the agent.** The preamble gains the patch form. This is last: until
   the four steps above are in, an agent told about the form would emit one
   lucid cannot apply.

Steps 2 and 3 are where the behaviour lives and neither touches the store, so
the oracle for this RFC is mostly pure-function tests over documents from
real records.

## Open Questions

1. **Does the agent know the current document well enough to anchor against
   it?** Every anchor must match the current version exactly once. The agent
   writes it from its own picture of the document - its earlier emission plus
   its own patches - and that picture can drift. When it does, `E-PATCH-02`
   fires and the turn costs a refusal plus a resend.
   This RFC no longer claims a context saving, because the earlier draft's
   figure mixed two accounting methods and the review was right to reject it.
   What is claimed is the output saving, which does not depend on this
   question at all: a patch that applies is small whether or not the next one
   fails.
   What would settle it: the refusal rate over a real conversation of twenty
   or more revisions, and the size of the resends it triggers. Only then is a
   context figure worth stating.
   Options for the resend policy: resend the current version only on refusal,
   as `E-PATCH-02` now requires; resend every N revisions regardless; resend
   whenever the agent has not seen the current version.
   Decided by: measurement, then the user.

2. **What bounds the number of edits in one block?** Security requires a
   bound. The value is not obvious: too low and a legitimate multi-part
   revision is refused, too high and the bound does not bound. A starting
   value of 50 is proposed, on the grounds that a revision needing more than
   fifty separate anchored edits is a rewrite, and a rewrite is what the
   whole form is for.
   Decided by: the user, or by the first revision that hits it.

3. **Should a version record that it arrived as a patch?** This RFC says no:
   the record holds documents, and how the bytes travelled is not a property
   of the document. The counter-argument is diagnostic - a run of patch
   refusals is invisible in the record, so Open Question 1 cannot be answered
   from a record alone.
   Options: keep it out; add an optional field on the artifact entry; report
   it as an event rather than on the entry.
   Decided by: whether measuring Open Question 1 needs it.

## Alternatives Considered

**Leave it.** The cost is real, measured, and grows with both document length
and revision count. Rejected on those numbers: 127 seconds to add a sentence
to a 27 KB document, and about 136,000 tokens of context at twenty revisions.

**Put the artifact on a file and watch it, as lucid v1 does.** v1 keeps the
document at a path, the agent edits it with its ordinary file tools, and a
watcher commits a version when the file changes
(`~/dev/lucid src/server/artifact-watch.ts`). Its output cost per revision is
the same as this RFC's - one edit, not one document - and it has two
advantages: the agent can always read the file, so Open Question 1 does not
arise, and there is no patch to fail to apply.

It was rejected because it reintroduces a reconcile window. With a file in
the middle, the file, a serve cache and the log can disagree, and v1 shipped
a bug from exactly that: `commitIfChanged` in `~/dev/lucid src/core/session.ts`
takes a `baseline: "snapshot" | "cache"` parameter to say which of two truths
to believe, and its comment records the failure it was written for - "cache ==
artifact, log still one version back". A patch that does not apply is refused
at the boundary and writes nothing; a reconcile window cannot be refused,
because by the time it is noticed both sides already exist.

**A correction to the record while rejecting it:** v1 does not store diffs.
It stores complete snapshots at `versions/s<seg>/v<n>.html` and computes a
diff only as a view, for its change view
(`~/dev/lucid src/diff/diff.ts`). Both lucid versions store complete
versions. Only transport differs, which is why this RFC changes transport and
nothing else.

**Store the patch and reconstruct on read.** Rejected. It would make reading
a version depend on replaying every patch before it, turn a corrupt patch
into the loss of every later version, and break the property that a version's
hash is over the bytes a reader gets. The record's simplicity is the thing
worth keeping.

**A structural patch - CSS selectors or a DOM path instead of text.**
Rejected. It requires parsing both sides, which can fail on agent-authored
HTML, and it silently does the wrong thing when the structure moved but the
text did not. RFC-06 already chose exact text over structure for annotation
anchoring, where a spot that cannot be found exactly is reported lost rather
than guessed. This follows that decision rather than contradicting it.

## What the review changed

This draft answers
`docs/rfc/08_revising-an-artifact-without-retyping-it.review-draft-2026-08-26.md`,
a cross-family review by `muse-spark-1.2-contributor@muse`. One line per
point.

| Point | What changed |
|---|---|
| F-01 | The context figures are gone. The earlier draft equated output with context, which omits the preamble, the per-turn state block, inputs and reasoning, and credits the patch form with savings it does not make - `composeArtifactState` resends a human-saved document until the agent supersedes it either way. Motivation now claims the output saving only, and says why context is not quantified |
| F-02 | The 2 KB patch is named as stipulated rather than measured, with the reasons it may be larger: exactly-once forces wide anchors, and the fence, header and JSON wrapper are output too. 9x is corrected to **7x** and called the top of a range |
| F-03 | The design changed, not the wording. Every anchor is now resolved against the version named by `replaces` **before any edit is applied**, because an earlier edit could shift a later anchor onto a different single match at the wrong place - a wrong document with no refusal. Overlapping edits are refused as `E-PATCH-08`, and an edit may no longer build on an earlier one |
| F-04 | The two-block case now requires the read to consult the in-message version map before the durable index, and that a first block already appended stays when the second is refused |
| F-05 | Versioning names the two cases the preamble coupling does not cover: a rollback, where an older lucid has to refuse an unknown `form` rather than default to `whole`, and a running `headless-session`, which does not hear about the form until it restarts |
| F-06 | R3 says which fields are identical to a whole form and which are not: `version` and `at` are assigned fresh, so anything ordering by `afterSeq` sees the difference |
| F-07 | R3 records that the `TEXT_MAX` bound on a message no longer limits the document, because only the patch transits - which is why the result is size-checked and R7 bounds the replacements |
| F-08 | `E-PATCH-02` recovery is now a MUST and is named as new behaviour: `composeArtifactState` carries bytes only for a version a person saved, so the agent's own current version is exactly what it is never sent |
| F-09 | An unknown field on an edit is refused, not ignored. Nothing durable reads a patch body, so there was no compatibility to preserve - and ignoring one would let a future `mode: "regex"` be applied literally and silently |
| F-10 | R7 gives every dimension a number: 50 edits, 4,096-byte `find`, 65,536-byte `replace`, the sum of replacements bounded by `ARTIFACT_BYTES_MAX`, and 200 bytes of quoting in a refusal |

One correction the review made to the arithmetic is applied directly: the
earlier draft counted v1 plus ten patches, when there are nine revisions
after v1.

The measured byte counts came from the record; the reviewer could not read it
and checked them for internal consistency instead, saying so per claim. They
are unverified by a second party.

## References

### Normative

- `docs/rfc/06_an-artifact-you-can-address.rfc.md` - the fence, the header,
  the emission path and the anchoring discipline this RFC extends.
- `CONTEXT.md` - the terms this RFC does not redefine.
- `src/protocol/artifacts.ts` - `ARTIFACT_PREAMBLE`, `ArtifactHeader`,
  `detectArtifactBlocks`, and the refusal shapes a new form must match.
- `src/modes/host.ts` - `handleArtifactMessage`, where a block becomes a
  version.
- `src/store/log.ts` - `ARTIFACT_BYTES_MAX` and `writeArtifact`, both reused
  unchanged.

### Informative

- `docs/rfc/07_many-artifacts-in-one-record-and-the-history-you-can-move-through.rfc.md`
  - the state block that carries a person's saved version, and the
  once-per-session rule the preamble follows.
- `~/dev/lucid` `src/server/artifact-watch.ts`, `src/core/session.ts`,
  `src/diff/diff.ts` - the file-watching design considered and rejected, and
  the snapshot storage that corrects the diff misconception.

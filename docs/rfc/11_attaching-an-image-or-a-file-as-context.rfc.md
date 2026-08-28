---
number: 11
title: "Attaching an image or a file as context"
type: protocol
status: Draft
author: Kevin Frilot
date: 2026-08-28
---

# RFC-11: Attaching an image or a file as context

> **Draft 2, 2026-08-28.** Answers
> `11_attaching-an-image-or-a-file-as-context.review-draft-2026-08-28.md`,
> a cross-family review of draft 1. What changed, and what did not, is listed
> under [What this draft answers](#what-this-draft-answers). Fifteen of its
> sixteen findings are applied; one is refused with its evidence.

## Abstract

A person can attach a file to what they send an agent: in the composer, and on
an annotation. The bytes are stored beside the log inside the record,
addressed by their sha256, and the log entry names the hash rather than
carrying the bytes. A file whose contents are text is inlined into the input;
anything else is named by path, because `hcn` has no channel for an attachment
and lucid cannot make one. lucid never tells the person the agent saw
something it only offered. This RFC renders the decisions taken on the map
[Attaching an image or a file as context][map]; it decides nothing new.

## Introduction

### The problem

Everything a person sends an agent through lucid is text. An input is a
string; a note batch rides inside that string. There is no way to say "look at
this screenshot" or "here is the log I am talking about".

### What this covers

Storing an attached file in the record, referring to it from the log, carrying
it on an annotation, and delivering what can be delivered to the agent.

### What it does not cover

- **Changing `hcn`.** As of hcn 0.5.7, `run` and `session` accept prompt text
  or a prompt file and nothing else - verified by running them. That is a fact
  about a pinned version, not a permanent property: hcn is a dependency this
  repository pins exactly and bumps deliberately, and a later one may carry
  attachments. If it should, that is work in
  `@dungle-scrubs/harness-cli-normalizer` and a separate effort. This RFC
  specifies what to do while there is no channel, and does not foreclose one.
- **The interface beyond a thumbnail.** Removing an attachment, adding
  several, what a non-image looks like. That is design work and
  `docs/design-brief.md` is out for design; deciding it here decides it twice.
- **Removing attachment bytes.** Nothing in lucid removes anything from a
  record. Attachments are the first thing that could grow without bound, and
  this RFC does not solve that. See Open Questions.

### What a record actually holds

Stated precisely, because the rest of this RFC adds to it.

`createConversationRecord` writes three durable files: `log.ndjson`,
`meta.json`, and `secret`. `RecordPaths` (`src/store/errors.ts`) names those
three plus **one** lock path, the append lock. The presence lock is separate
(`src/store/presence.ts`), and neither lock file is created at record
creation - both are `flock(2)` rendezvous created on demand.

So a record is **three durable files, two locks that may or may not exist,
and now `files/`**. The distinction matters for this RFC's central claim that
a record travels: the durable files and the blobs MUST travel, and the locks
MUST NOT.

### Why now

The capability half already exists and the channel half does not, and that
asymmetry is invisible from outside. `hcn inspect <h> --capabilities` reports
`vision` and `images` per harness - true for `claude` and `codex`, false for
`pi` and `muse` - while no hcn command accepts an image. Without this RFC the
obvious implementation attaches an image, sends a prompt, and lets the person
believe it was seen.

## Terminology

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be
interpreted as described in RFC 2119.

| Term | Meaning |
|---|---|
| **attachment** | A file a person adds to an input or to an annotation |
| **blob** | The stored bytes of an attachment, named by their sha256 |
| **blob store** | The directory inside a record holding blobs |
| **reference** | What names a blob without carrying it: hash, size, media type, filename, and the path it was offered at. `AttachedFile` is its shape |
| **offered path** | Where a named attachment is placed for the agent to read. Outside the record, always |
| **inlined** | An attachment whose contents were put into the input as text |
| **named** | An attachment the input refers to by path, not by content |

"Record", "log", "input", "annotation batch" and "preamble" are used as
`CONTEXT.md` defines them.

## Protocol Overview

```
  person                lucid                        record            agent
    |                     |                            |                 |
    |-- attach(file) ---->|                            |                 |
    |                     |-- sha256(bytes) ---------->|                 |
    |                     |   write files/<hash>       |                 |
    |                     |-- append attach entry ---->|                 |
    |<-- reference -------|                            |                 |
    |                     |                            |                 |
    |-- send ------------>|                            |                 |
    |                     |  text?  inline contents    |                 |
    |                     |  else   name the path      |                 |
    |                     |------------- prompt string ----------------->|
    |                     |                            |                 |
    |<-- what was sent, and what was only named --------|                 |
```

Three properties hold throughout.

1. **The bytes never enter the log.** The log names them.
2. **The record is self-contained.** Copy it and the attachments travel.
3. **lucid never claims delivery it did not make.**

## Message Formats

### The blob store

An attachment's bytes are stored at:

```
<record>/files/<sha256-hex>
```

`files/` MUST be inside the record directory. It MUST NOT be a machine-global
location: the record is the unit that travels - `CONTEXT.md` leads with
reopening a record and handing it to a different agent - and an attachment the
transcript refers to MUST move with it.

Blobs MUST be addressed by the lowercase hex sha256 of their bytes. This is
the hash `src/store/log.ts` already computes for artifact bytes; a second hash
for a second purpose MUST NOT be introduced.

Content addressing gives three things this RFC relies on: the same file
attached twice is stored once, the log's copy of the hash verifies the bytes,
and a name cannot be reused to mean different bytes.

**A blob's path inside the record is never given to an agent.** `secret` sits
beside `files/`, and `secret` is the credential that authenticates a driver to
the host - so naming a path inside the record is not a location leak, it is a
credential disclosure. See *The offered path* below, which is normative.

### The log entry

```jsonc
{
  "v": 1,
  "at": 1756400000000,
  "src": "attach",
  "hash": "3f9a2c…e1",       // sha256 hex, lowercase
  "bytes": 2411903,           // size of the blob
  "contentType": "image/png", // as received
  "name": "screenshot.png",   // the original filename
  "text": false               // whether lucid will inline it
}
```

The entry MUST NOT carry the bytes.

That is a measurement, not a preference. Folding a 67 MB log costs 19 ms and
**335 MB of resident memory** - five times the file - because a fold holds what
it reads. Time is not the problem; memory is. Two lesser reasons stand with
it: `tail log.ndjson` stops being how a record is inspected, and the log is
append-only, so an attachment added by mistake would be in the source of truth
permanently.

A reader that does not know `src: "attach"` MUST carry the entry rather than
fail. The fold already does this: `ENTRY_SOURCES` in `src/store/log.ts` lists
`frame`, `input`, `credit`, `artifact`, `artifact-meta`, so `knownEntry`
returns false for anything else and `foldLog` carries it.

(`decodeHarnessLine` carries unknown event **kinds** in the harness runner.
That is the same habit in a different layer and is not the mechanism relied on
here. Draft 1 cited it as though it were.)

**An implementation of this RFC MUST stop relying on that carry.** Adding
attachments means adding `"attach"` to `ENTRY_SOURCES` and a coercion beside
`coerceArtifactEntry`, so the hash, size and media type are validated rather
than passed through. Carrying is what an *older* build does with a *newer*
record; it is not what the build that writes these entries may do with them.

### The bounds

```ts
/** The most a single attachment may be. Policy, not measured. */
export const ATTACHMENT_BYTES_MAX = 25_000_000;
```

25 MB admits any screenshot, photograph or PDF and keeps out video, which no
agent can use. It is deliberately not `ARTIFACT_BYTES_MAX`: that bound is 1 MB
because an artifact is stored as a line **in** the log, and a blob is not.

**Two bounds apply and the smaller one governs.** Draft 1 defined neither, and
the review was right that leaving them unreconciled lets a file be accepted and
then refused:

1. At attach time, a file over `ATTACHMENT_BYTES_MAX` is refused
   (`E-ATTACH-01`). Nothing is written.
2. At send time, an **inlined** file's contents become part of `input.text`,
   which `isWireText` bounds at `TEXT_MAX` - 1 MB - in the reducer. This is
   not a second refusal: a text file whose contents would not fit MUST be
   **named instead of inlined**. The path already exists for it.

So the honest statement of the rule is: a file up to 25 MB is stored; a file
is inlined only if inlining leaves the whole input within `TEXT_MAX`;
everything else is named.

There is no per-conversation total, and Open Question 4 records what that
leaves unsolved.

### Deciding whether a file is text

lucid MUST decide this on the bytes. A `contentType` arrives from the browser
and states what the sender claims; an extension states less than that.

A file is text when **all** hold over the whole file:

- It decodes as UTF-8.
- It contains no byte in `0x00`-`0x08`, `0x0B`, `0x0C`, or `0x0E`-`0x1F`. Tab,
  newline and carriage return are text; the rest are not.
- It contains no `0x7F`.

A file that fails any of these MUST NOT be inlined. This is the same class of
rule the record already applies to every field it stores, and for the same
reason: an inlined file becomes part of an input, and control characters in an
input are what the store refuses everywhere else.

Draft 1 required detection "on the bytes" and gave no test, which left an
implementer to invent one.

### The offered path

A named attachment MUST NOT be offered to an agent at its path inside the
record.

Before a turn that names an attachment, lucid MUST copy the blob to a
directory outside the record, and MUST name that copy. The copy:

- MUST be outside the record directory, so no traversal from it reaches
  `secret`, `log.ndjson`, or another conversation.
- MUST be readable only by the user lucid runs as, matching the `0o600` the
  record's own files are written with.
- MUST NOT be inside another record.
- SHOULD be removed when the turn ends. It MUST NOT outlive the conversation.

This was Open Question 3 in draft 1, carrying a SHOULD, which left the
insecure behaviour as the shipped default until someone decided. The review
was right that this is not an open question: the guard in *Security
Considerations* about resolving blob names as hex protects the **browser**,
which asks lucid for bytes. It does nothing for the **agent**, which reads the
filesystem itself.

### The reference, on an annotation

`Annotation` gains one optional field:

```ts
interface AttachedFile {
  readonly hash: string;        // sha256 hex
  readonly bytes: number;
  readonly contentType: string;
  readonly name: string;
  /** Where the agent was told to look. Outside the record, always -
   * see The offered path. Absent when the file was inlined. */
  readonly path?: string;
}

interface Annotation {
  readonly note: string;
  readonly spots: readonly AnnotationSpot[];
  readonly files?: readonly AttachedFile[];   // new
}
```

It MUST be on the **note**, not on the batch. A note is about a spot in the
document and the file is about that note; a file belonging to a batch of four
notes says nothing about which one it illustrates.

It MUST ride inside the existing `lucid-annotations` fence. A second fence
MUST NOT be introduced: the agent would have to join two blocks to learn which
file belongs to which note, and the preamble that teaches the format is the
harness-neutral floor shipped in the binary - one shape to teach, one shape to
validate.

**A batch carrying `files` MUST be readable by an implementation that does not
know the field.** This is where the annotation batch and RFC-08's patch body
part company: a patch body is never stored, so it refuses unknown fields on
purpose; a batch **is** stored, in the input text, in the log, forever. The
validator MUST ignore fields it does not recognise.

That requirement has a test, and the test is the requirement: **a batch
written by a newer build MUST decode in an older one, losing only the field it
does not know.** An implementation MUST carry a fixture of such a batch and
assert it, the way the harness fixtures assert what a recorded hcn version
produced. Without it "ignores unknown fields" is a sentence rather than a
behaviour.

## State Machine

An attachment has four states.

```
        attach                 send
  (none) ------> stored -----------------> inlined
                   |  \                     (the contents ARE the input)
                   |   \      send
                   |    +----------------> named
                   |                        (the input carries a path)
                   |  blob gone at send
                   +----------------------> missing
                                            (the input says so; the turn runs)
```

- **stored** - bytes written, entry appended, reference held. Nothing sent.
- **inlined** - the contents were placed in the input. Reachable only for text
  that fits within `TEXT_MAX`.
- **named** - the input carries an offered path. Whether the agent reads it is
  the agent's business.
- **missing** - the blob was gone when the turn was built. The input says so
  and the turn proceeds. Draft 1 defined `E-ATTACH-04` for this and left it out
  of the machine; the review was right that a fourth outcome with no state is
  a hole.

An attachment MUST NOT change state on its own. A stored attachment that is
never sent stays stored.

### On delivery

Draft 1 said there MUST NOT be a *delivered* state. That is right for a
**named** attachment and wrong for an **inlined** one, and the review caught
the difference.

An inlined file's contents **are** the input. Once the input is enqueued they
have been delivered as certainly as anything lucid ever delivers, and the log
records it. There is no separate state because `inlined` already is that
state.

A named attachment is different in kind: lucid cannot observe whether the
agent opened the file, no event reports it, and there MUST NOT be a state or a
message claiming otherwise.

So the rule is narrower than draft 1 stated, and truer: **lucid MUST NOT
represent a named attachment as read.** What was inlined and what was named is
recorded in the log, which is what makes the difference answerable later.

## Error Handling

| Code | When | What happens |
|---|---|---|
| `E-ATTACH-01 attachment-too-large` | The file exceeds `ATTACHMENT_BYTES_MAX` | Refused before any bytes are written |
| `E-ATTACH-02 attachment-unreadable` | The bytes cannot be read | Refused; nothing is appended |
| `E-ATTACH-03 attachment-write-failed` | The blob cannot be written | Refused; the log entry MUST NOT be appended |
| `E-ATTACH-04 attachment-missing` | A referenced blob is absent at send time | The input names it as missing; the turn proceeds |

`E-ATTACH-01` MUST be checked before the bytes are copied and before they are
hashed. A file that is going to be refused MUST NOT be written first.

`E-ATTACH-03` matters more than it looks: the log entry and the blob MUST be
written in that order - blob first, entry second - so a record never refers to
bytes that are not there. The reverse order produces a log that lies.

**Durability, and what a crash leaves.** The blob MUST be written and flushed
before the entry is appended. Draft 1 gave the order and not the contract, and
the review was right that the order alone does not survive a crash:

- Crash **between** the two leaves a blob nothing refers to. That is an
  orphan, and it is the safe direction - a file taking space is not a record
  that lies.
- Crash **during** the append is the log's existing problem and is not made
  worse by attachments.

Orphans accumulate and nothing collects them. That is the same gap Open
Question 4 records for attachments generally, and it is not solved here.

`E-ATTACH-04` is not a failure of the turn. A record can be copied without its
blobs by a person using the wrong tool, and the honest response is to say the
file is gone rather than to refuse to talk.

### What is never an error

**A harness that reports no vision.** lucid MUST NOT refuse an attachment on a
capability claim. Three reasons:

1. The claim is `medium` confidence from a `curated` source, not
   runtime-verified. Refusing a person's file on a guess is the wrong way
   round.
2. It can be true when the file is attached and false when it is read, because
   a record is handed between harnesses. A refusal at attach time protects
   nothing at read time.
3. Most attachments after this RFC are text, which needs no vision at all.
   Refusing on `vision:false` would refuse a `.ts` file for want of eyes.

lucid MUST instead report what happened: what was inlined, what was named, and
that whether a named file is opened is up to the agent.

## Security Considerations

**A blob is agent-adjacent input written by a person.** It is stored, hashed,
and named to an agent. It is never parsed by lucid, never rendered into
lucid's own surface as markup, and never executed.

**Two surfaces reach a blob, and they need different guards.** Draft 1 gave
one guard and implied it covered both. It does not.

*The browser* asks lucid for bytes. Anything serving blobs to it MUST serve
only from `files/` and MUST resolve the requested name as a sha256 hex string
- never as a path. A request naming `../secret` MUST fail on the shape of the
name, before any filesystem access.

*The agent* reads the filesystem itself. No guard lucid writes into its HTTP
surface constrains it. The only control is **what path lucid names**, which is
why *The offered path* is normative and why it MUST be outside the record.

**`secret` is a credential, and it sits beside `files/`.** It is what
authenticates a driver to the host. An agent given a path inside the record can
list the directory it is in. So an inside-record path is not a location
disclosure to be weighed - it hands over the ability to attach to the
conversation. Draft 1 stated this in Open Questions with a SHOULD, which left
the insecure default shipped.

**Content addressing is a check, not a guarantee.** The stored hash proves the
bytes are the bytes that were attached. It proves nothing about what they
contain. lucid MUST NOT treat a `contentType` as trustworthy: it arrives from
the browser and describes what the sender claims.

**Text detection reads attacker-influenced bytes.** Deciding whether a file is
text MUST be done on the bytes, not on the extension or the claimed media
type, and a file containing control characters MUST NOT be inlined - the
record refuses control characters in every field it stores, and an inlined
file becomes part of an input.

**The bound is a denial-of-service control as much as a policy.** Without
`ATTACHMENT_BYTES_MAX` the endpoint accepts an arbitrarily large body.

**A named path discloses whatever directory it is in.** That is why the
offered path is outside the record and readable only by the user lucid runs
as. It remains a disclosure of that directory, which is why the copy holds one
turn's files and nothing else.

## Versioning

`v: 1` on the entry, as every entry carries.

An `attach` entry is additive. A record containing them MUST open in an
implementation that predates them, carrying the entries it does not
understand - the behaviour the fold already has and which was verified while
measuring: a log containing an unknown `src` folded and its artifacts were
still found.

`Annotation.files` is optional and MUST stay optional. A batch without it is a
valid batch.

## Implementation Notes

Ordered so each step leaves `bun run check` green.

1. **The blob store and the entry.** `ATTACHMENT_BYTES_MAX`, writing
   `files/<hash>`, appending `src: "attach"`, and the fold reading it -
   which means adding `"attach"` to `ENTRY_SOURCES` and a coercion beside
   `coerceArtifactEntry`, not relying on the carry. No interface. Testable
   end to end without a browser.
2. **Text detection.** Deciding whether a file is inlined, on its bytes.
   Pure, and the place a wrong answer is most costly.
3. **Delivery.** Inlining into the input, and naming what cannot be inlined.
   Includes the offered-path copy, which is normative and MUST land in this
   step rather than after it - the step is the one it guards.
4. **The composer.** Attach, thumbnail, send.
5. **The annotation batch.** `Annotation.files`, the encoder, the validator
   ignoring unknown fields, and the preamble wording.

Step 5 last on purpose: it changes a stored format taught by a preamble that
ships in the binary, and it is the step whose wording RFC-08 shows is the
mechanism rather than decoration.

## Open Questions

1. **Is `files/` the right name?** Used throughout and never settled.
   `blobs/` says what it holds; `files/` says what a person put there.
   *Recommendation: `files/`, because a person reading their own record is the
   audience.* Settled by whoever implements step 1.

2. **Is the blob's hash verified on read?** Always, never, or on first read.
   Verification costs a full read of the bytes. *Recommendation: never by
   default, with the hash available so a check can be asked for.* Settled by
   whether anything is ever observed to disagree.

3. **What removes attachment bytes, and orphans?** Nothing in lucid removes
   anything from a record. Two things now accumulate: blobs whose
   conversation is finished, and orphans left by a crash between writing a
   blob and appending its entry. The map decided against a per-conversation
   total because such a bound has no good failure - "you may not attach
   anything else, ever" in a record where nothing can be deleted - and the
   review was right that this rejects one answer without supplying another.
   *No recommendation.* Named as the largest thing this RFC leaves open.

4. **Is an attachment on a note re-anchored with the note?** A note's spot can
   be lost when the document changes; the file cannot.
   *Recommendation: the file survives the spot - it belongs to the note, not
   to the spot.*

*Draft 1's Open Question 3 - whether a named path should be inside the record -
is no longer a question. It is normative in* The offered path*, because a
SHOULD there left a credential disclosure as the shipped default.*

## What this draft answers

Every finding of
`11_attaching-an-image-or-a-file-as-context.review-draft-2026-08-28.md`, one
line each.

| | Finding | What changed |
|---|---|---|
| F-01 | `ATTACHMENT_BYTES_MAX` undefined | Applied. Defined as `25_000_000` in *The bounds*, a section draft 1 lacked entirely |
| F-02 | Record layout: one lock, not two | Applied. *What a record actually holds* states three durable files, two on-demand locks, and that locks MUST NOT travel with a copy |
| F-03 | Fold carries `attach`; RFC never says to stop | Applied. *The log entry* and step 1 now require adding `"attach"` to `ENTRY_SOURCES` and a coercion |
| F-04 | 1 MB bound implied but not specified | Applied. *The bounds* states attachments do not share `ARTIFACT_BYTES_MAX`, and why |
| F-05 | Forward-compatibility understated | Applied. The ignore-unknown-fields rule now carries a required fixture test |
| F-06 | `decodeHarnessLine` is a different layer | Applied. The citation is corrected to `ENTRY_SOURCES`/`foldLog`, with the harness carry noted as a parallel, not the mechanism |
| F-07 | "Nothing sets `cwd`" misleading | **Refused.** `cwd` is an optional field on `OpenSessionOptions` and `StreamTurnOptions`, and no caller in lucid assigns it - only `src/harness/node-deps.ts` forwards it when supplied. The field existing is not the same as it being set. Draft 1's claim stands |
| F-08 | Permanence of hcn's limitation overstated | Applied. Scoped to hcn 0.5.7 and stated as a pinned-version fact |
| F-09 | Credential disclosure; browser guard mistaken for agent guard | Applied, and it is the largest change. *The offered path* is normative and MUST be outside the record; Security Considerations separates the two surfaces; the old Open Question 3 is gone |
| F-10 | Durability and orphans unspecified | Applied. Flush before append, which crash leaves an orphan, and orphans named in Open Question 3 |
| F-11 | `E-ATTACH-04` has no state | Applied. `missing` is a state in the machine |
| F-12 | "No delivered state" inconsistent for inlined | Applied. The rule is narrowed: an inlined file **is** delivered; a named one MUST NOT be represented as read |
| F-13 | Bounds unreconciled; growth unbounded | Applied. The two bounds are reconciled - a file that would not fit `TEXT_MAX` is named rather than refused - and the growth question is Open Question 3 with the review's objection recorded |
| F-14 | Text detection had no algorithm | Applied. *Deciding whether a file is text* gives the test |
| F-15 | Terminology drift, `reference` unused | Applied. `reference` matches `AttachedFile`, `offered path` is defined, and `path` is optional because an inlined file has none |
| F-16 | Abstract promises what nothing specifies | Applied. The Abstract now points at the log as the mechanism and says the wording is design work |

**On the review itself.** It ran cross-family on
`muse-spark-1.2-contributor@muse`, because the author's family does not review
its own work. The routing query warned that with that family excluded no route
in the registry meets the high-stakes bar for code review, and the reviewer's
line numbers drift by up to fifteen lines. Every citation relied on above was
checked against the source before it was applied.

## References

### Normative

- RFC 2119, Key words for use in RFCs to Indicate Requirement Levels
- RFC-06, An artifact you can address - the artifact fence and `contentType`
- RFC-07, Many artifacts in one record - version history and hashing
- RFC-08, Revising an artifact without retyping it - why a non-stored format
  refuses unknown fields, which this one must not

### Informative

- [Attaching an image or a file as context][map] - the map this RFC renders,
  and the six decisions it holds
- `CONTEXT.md` - the record, the transcript, and what travels with a
  conversation
- `AGENTS.md` - harness access through `hcn`, and why lucid holds no
  descriptor

[map]: https://github.com/dungle-scrubs/lucid-v2/issues/183

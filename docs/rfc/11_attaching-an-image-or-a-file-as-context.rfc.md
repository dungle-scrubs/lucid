---
number: 11
title: "Attaching an image or a file as context"
type: protocol
status: Draft
author: Kevin Frilot
date: 2026-08-28
---

# RFC-11: Attaching an image or a file as context

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

- **Changing `hcn`.** hcn accepts prompt text or a prompt file and nothing
  else. If an attachment should ride the wire, that is work in
  `@dungle-scrubs/harness-cli-normalizer` and a separate effort.
- **The interface beyond a thumbnail.** Removing an attachment, adding
  several, what a non-image looks like. That is design work and
  `docs/design-brief.md` is out for design; deciding it here decides it twice.
- **Removing attachment bytes.** Nothing in lucid removes anything from a
  record. Attachments are the first thing that could grow without bound, and
  this RFC does not solve that. See Open Questions.

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
| **reference** | What names a blob without carrying it: hash, size, media type, filename |
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
fail, as the fold already does for unknown sources and as `decodeHarnessLine`
does for unknown event kinds.

### The reference, on an annotation

`Annotation` gains one optional field:

```ts
interface AttachedFile {
  readonly hash: string;        // sha256 hex
  readonly bytes: number;
  readonly contentType: string;
  readonly name: string;
  readonly path: string;        // absolute, inside the record
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

## State Machine

An attachment has three states and no others.

```
        attach                send
  (none) ------> stored -------------> inlined
                   |                      (contents are in the input)
                   |     send
                   +-------------------> named
                                          (the input carries the path)
```

- **stored** - bytes written, entry appended, reference held by the composer
  or the note. Nothing has been sent.
- **inlined** - the contents were placed in the input. This state is reachable
  only for text.
- **named** - the input refers to the file by path. Whether the agent reads it
  is the agent's business.

There is no *delivered* state, and there MUST NOT be one. lucid cannot observe
whether an agent opened a file it named.

An attachment MUST NOT change state on its own. A stored attachment that is
never sent stays stored; the entry records that it exists, which is true.

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

**The blob store is inside the record, and so is `secret`.** The record
directory already holds the credential that authenticates a driver to the
host. Anything that serves blobs to the browser MUST serve only from `files/`
and MUST resolve the requested name as a sha256 hex string - never as a path.
A request naming `../secret` MUST fail on the shape of the name, before any
filesystem access.

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

**Named paths leak the record's location** to the agent, which is a
disclosure lucid is choosing: an agent that can read the named file can read
its neighbours, including `secret`. This is the strongest argument against
naming paths at all, and it is why Open Question 3 exists.

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
   `files/<hash>`, appending `src: "attach"`, and the fold reading it. No
   interface. Testable end to end without a browser.
2. **Text detection.** Deciding whether a file is inlined, on its bytes.
   Pure, and the place a wrong answer is most costly.
3. **Delivery.** Inlining into the input, and naming what cannot be inlined.
   Includes what lucid reports back about which happened.
4. **The composer.** Attach, thumbnail, send.
5. **The annotation batch.** `Annotation.files`, the encoder, the validator
   ignoring unknown fields, and the preamble wording.

Step 5 last on purpose: it changes a stored format taught by a preamble that
ships in the binary, and it is the step whose wording RFC-08 shows is the
mechanism rather than decoration.

## Open Questions

1. **Is `files/` the right name?** Used throughout this RFC and never
   settled. `blobs/` says what it holds; `files/` says what a person put
   there. *Recommendation: `files/`, because a person reading their own record
   is the audience.* Decided by whoever implements step 1.

2. **Is the blob's hash verified on read?** Always, never, or on first read.
   Verification costs a full read of the bytes. *Recommendation: never by
   default, with the hash available so a check can be asked for.* Settled by
   whether anything is ever observed to disagree.

3. **Should a named path be inside the record at all?** Naming
   `<record>/files/<hash>` tells the agent where the record is, and an agent
   that can read that path can read `secret` beside it. A copy in a scratch
   directory would not. *Recommendation: copy to a per-turn directory outside
   the record and name that.* This is the one open question with a security
   consequence and it SHOULD be settled before step 3.

4. **What removes attachment bytes?** Nothing in lucid removes anything from a
   record, and attachments are the first thing that grows without bound. The
   map decided against a per-conversation total because such a bound has no
   good failure - "you may not attach anything else, ever" in a record where
   nothing can be deleted. *No recommendation.* Left open deliberately.

5. **Is an attachment on a note re-anchored with the note?** A note's spot can
   be lost when the document changes; the file cannot. *Recommendation: the
   file survives the spot - it belongs to the note, not to the spot.*

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

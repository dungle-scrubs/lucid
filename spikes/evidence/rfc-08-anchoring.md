# RFC-08 Open Question 1: can the agent anchor against its own document?

Run with `bun scripts/measure-patch-anchoring.ts --record <name> --revisions N`,
against a live `claude` harness through `hcn`. Nondeterministic by
construction; never gates CI.

## What was measured

One record, one continuous `headless-session`, 24 revision requests in plain
language. No mention of patches, anchors, or syntax in any prompt: the agent
learned the form from the preamble alone (#144) and chose it by itself.

## Result

```
versions stored          18
document size            2,922 -> 2,920 chars (peak 3,008)
emissions                17 patch, 1 whole
average emitted          patch 1,145 chars (687 min, 1,600 max)
                         whole 3,242 chars
declined as unnecessary  7
refusals                 0
anchor miss rate         0.0%  (0 of 17)
```

**Zero anchor misses over seventeen consecutive patches.** No `E-PATCH-02`,
and no refusal of any other kind.

## What that does and does not settle

It settles the favourable case, which is also the common one: a single
session, where the agent wrote every version itself and its context still
holds them. Seventeen for seventeen.

It does not settle the cases where drift is likely, and none of them appeared
in this run:

- **A session restart.** Measured separately, below. It turned out not to be
  the case this made it sound like.
- **A person's save.** Covered by a different mechanism: `composeArtifactState`
  already sends a human-saved version's bytes in full, so the agent anchors
  against text it has been given rather than text it remembers.
- **A long document.** This one stayed near 3 KB. An anchor is a short quote
  either way, but there is more document to misremember.

So the honest reading is: within a session the agent anchors reliably, and the
resend-on-refusal policy is cheap because it almost never fires.

## A driver restart does not lose the context, and that is by design

Run with `--restart-after 6` over 12 revisions: the driver is killed with
`-9` mid-conversation and a new one started.

```
before restart: 3 patch, 1 whole, 3 prose, 0 refusals
after  restart: 4 patch, 0 whole, 2 prose, 0 refusals
```

**Zero misses after the restart**, and the reason is in the record rather
than in the model: the `identity` events either side of the second attach
carry the same `sessionId`. The new driver resumed the harness session,
which is what RFC-03 exists to do - the record remembers which harness held
it. The agent's context was never lost, so it was still anchoring against
versions it wrote itself.

So the earlier note overstated the risk. Losing the driver process is not
the same as losing the agent's context, and lucid already closes that gap.

What is still unmeasured is narrower, and it is worth stating precisely: a
session that **cannot be resumed**. A different machine, an expired session,
a harness that lost it. lucid has a path for it - `could not resume ...
continuing fresh` - and on that path the agent is asked to revise a document
the state block names but does not carry. Nothing here says what it does
then. Forcing that case needs either a way to start fresh against an
existing record, which lucid does not expose and which is product surface
this measurement does not justify, or a genuinely lost session.

Two failures in the harness before this run produced anything, both worth
keeping because each would have produced a confident wrong number:

1. `pkill` without `-9` did not end the driver. The first run's "restart"
   left the original alive, so the second half rode the same session as the
   first and the split reported nothing real.
2. The replacement driver died at once when spawned detached with its stdio
   ignored, and again under `nohup ... >/dev/null`. The run then had no
   driver at all.

The script now kills with `-9`, starts the replacement through a shell with
somewhere to write, and **waits for a second attach frame in the record**
before continuing. When none arrives it throws rather than reporting. That
guard is what caught the second failure.

## The output saving, measured rather than modelled

A patch emission is roughly constant in the size of the change; a whole form
scales with the document. At this document size that is:

| document | whole-form emit | patch emit | saving |
|---|---|---|---|
| 2,920 chars (measured) | ~3,040 | 1,145 | **2.7x** |
| 10,000 chars (projected) | ~10,120 | 1,145 | 8.8x |
| 27,000 chars (projected) | ~27,120 | 1,145 | 23.7x |

Only the first row is measured. The other two hold the patch cost constant,
which the spread here supports (687 to 1,600 chars, uncorrelated with document
size) but does not prove at those sizes.

This is why RFC-08 rests on the output saving rather than on a context figure,
and why the form is worth having only where the document dwarfs the change.
On a small document a patch costs more than retyping it: measured separately,
a 58-char document cost 194 chars to patch against 132 to re-emit whole.

## Open Question 3 is answered: no new field is needed

RFC-08 asks whether a version should record that it arrived as a patch, on
the grounds that "a run of patch refusals is invisible in the record, so Open
Question 1 cannot be answered from a record alone."

**That premise is wrong.** Every number above was recovered from the log with
no instrumentation added:

- the form used is in the stored assistant message, which keeps the fence
  verbatim (the transcript *view* strips it; the event does not);
- every refusal is an `error` event carrying its `E-PATCH-NN` code;
- emitted size is the length of that message;
- document size is the stored version.

So the diagnostic argument for recording patch-arrival does not hold, and the
RFC's answer of "keep it out" stands on its own terms. The measurement script
is the tool; the record is the data.

## Recommended resend policy

Keep **resend only on refusal**, as `E-PATCH-02` already requires (#143).

The two alternatives the RFC lists are both worse against this data. "Resend
every N revisions" pays the document cost on a schedule to prevent a failure
that did not occur once in seventeen. "Resend whenever the agent has not seen
the current version" is already what happens for a person's save, which is the
only case in this run where the agent had not seen it.

The restart measurement below did not move it: 0 misses there too, because a
restart resumes the session. Revisit if a session that cannot be resumed ever
shows a materially different miss rate.

## Harness note

The first run stopped at revision 3, reporting silence. It was not a stall:
the agent had answered in prose, correctly declining a no-op edit ("item 1
already starts with a verb"). The script now distinguishes a declined
revision from silence by watching for a terminal event, and continues past it.
Seven of the 24 requests in the final run were declined the same way, all of
them changes an earlier revision had already made.

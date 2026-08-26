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

- **A session restart.** The agent loses its context and then patches from a
  summary. Untested here, and the most likely source of a real miss.
- **A person's save.** Covered by a different mechanism: `composeArtifactState`
  already sends a human-saved version's bytes in full, so the agent anchors
  against text it has been given rather than text it remembers.
- **A long document.** This one stayed near 3 KB. An anchor is a short quote
  either way, but there is more document to misremember.

So the honest reading is: within a session the agent anchors reliably, and the
resend-on-refusal policy is cheap because it almost never fires. Whether that
holds across a restart is the open half.

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

Revisit if a restart measurement shows a materially different miss rate.

## Harness note

The first run stopped at revision 3, reporting silence. It was not a stall:
the agent had answered in prose, correctly declining a no-op edit ("item 1
already starts with a verb"). The script now distinguishes a declined
revision from silence by watching for a terminal event, and continues past it.
Seven of the 24 requests in the final run were declined the same way, all of
them changes an earlier revision had already made.

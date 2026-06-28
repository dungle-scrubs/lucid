# Lucid + the planner: addressable plan review

The [`planner`](https://) skill takes an idea to an implementation-ready plan and
keeps a decision ledger in `plan.db`. Its REVIEW and iterate stages are where a
human reviews the living document and gives feedback. Lucid is the addressable
surface for exactly that moment.

The fit is mechanical, not aspirational: **the planner already gives every
decided claim a stable address** - the `<!-- D-NNN -->` marker it writes before
each governed value - and **Lucid's stable anchor is `data-lucid-id`.** They are
the same primitive. Map one to the other and a Lucid annotation stops being
"feedback on the third bullet" and becomes feedback on **decision D-014**, which
maps 1:1 onto the plan-db CLI.

## Division of labor

- **The planner owns the durable lifecycle** - stages, the ledger, convergence,
  gates. `plan.db` stays the source of truth.
- **Lucid owns the bounded review-moment** - it is invoked to collect located
  feedback on one document, then hands structured, decision-keyed input back. It
  never tries to be the planner; it is the input device for a review pass.

This is the "record-of-a-moment, not a session" boundary: the planner is the
workshop, Lucid is the workbench it picks up for a review.

## The two bridge commands

```sh
# 1. Render a planner living doc into an addressable Lucid artifact.
#    D-NNN markers -> data-lucid-id; the Open Questions section -> Q-N items.
lucid plan render .plans/<name>/implementation.md --out /tmp/<name>.review.html \
  --title "<name>" --stage review

# 2. Serve it and collect located feedback (standard Lucid loop).
lucid open /tmp/<name>.review.html
lucid wait /tmp/<name>.review.html --since <cursor> > /tmp/feedback.json

# 3. Map the feedback back onto plan-db, keyed by the ledger address.
lucid plan ingest --plan <name> --payload /tmp/feedback.json
#    (or: lucid wait ... | lucid plan ingest --plan <name>)
```

`ingest` emits a manifest plus suggested plan-db commands:

| Lucid feedback | becomes |
|---|---|
| annotation on a `D-NNN` claim | `plan-db add-finding --category review --description "re D-NNN: <note>"` |
| annotation on a `Q-N` question | `plan-db record-decision --topic "<question>" --decision "<answer>" --decided-by human` (the human's answer becomes a decision) |
| located note on unmarked content | `plan-db add-finding --category review` |
| a non-located message | `plan-db add-finding --category review` |
| a **revert** (with its why) | `plan-db add-finding --category revert` |
| **approve review** | counts as a clean convergence pass (`plan-db check-convergence`) |

The planner runs (or refines) those commands, revises the document, and the
human re-reviews - now with Lucid's **diff view** showing exactly what changed in
the plan since they last looked (sage), and **revert** mapping onto reversing a
decision.

## Surfacing the planner's questions

The bridge is bidirectional. The planner's **Open Questions** become addressable
`Q-N` items in the artifact, styled distinctly (an amber "awaiting your answer"
treatment), so the human answers them *in place* - the annotation note is the
answer, and `ingest` records it as a decision. New questions the planner raises
mid-review arrive by re-rendering: they show up as additions in the diff view.

So one surface carries both halves of the review: mark up decisions, answer
questions, all keyed back to the ledger.

## Complementary with grill-me

The planner's interview (`grill-me`) and Lucid are not redundant:

- **grill-me** elicits the unknown - open-ended, what-haven't-we-decided dialogue.
- **Lucid** reacts to the written - marking up the concrete artifact that exists.

Use grill-me to surface, Lucid to react; both write to the same ledger.

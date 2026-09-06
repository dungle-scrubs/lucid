# Documentation

Current contracts live here. Completed proposals and reviews live in Git,
not beside the instructions for current work.

| When you need to… | Read |
|---|---|
| Run lucid | [README](../README.md) |
| Check scope or choose a domain term | [CONTEXT](../CONTEXT.md) |
| Change record storage, delivery, or lifecycle | [Architecture](architecture.md) |
| Attach a source or implement frames | [Source protocol](skill-chat-substrate.md) |
| Change harness selection or session recall | [Drivers](drivers.md) |
| Change documents, annotations, saves, or attachments | [Artifacts](artifacts.md) |
| Understand a lasting tradeoff | [Decisions](decisions.md) |
| Verify a change | [AGENTS](../AGENTS.md) and [smoke verification](smoke-seven.md) |
| Propose a change | [RFC lifecycle](rfc/README.md) |

## Active design work

Keep these together when working on the reading view:

- [Design brief](design-brief.md): the interaction and visual brief.
- [Design coverage](reports/design-coverage.md): coverage and gap rulings
  against the handoff; its opening names the comparison commit.
- [Design delta](reports/design-delta-v2.md): revised handoff guidance.
- [Browser inventory](reports/design-reading-view/coverage-2-browser-surface-inventory.md):
  the built surface at the inventory's recorded revision.

The coverage reports are dated design inputs, not a live feature inventory.
Current contracts govern behavior; these documents govern the active visual
work. Recheck their source locations before implementing a listed gap.

## Keep documentation current

Update the reference that owns a changed contract in the implementation
commit. Use an RFC only while a proposal or its implementation remains
active. Once delivered, move its surviving rules into the references,
retain only lasting tradeoffs in [decisions](decisions.md), and remove the
RFC, its reviews, and resolved audits. A withdrawn RFC leaves no active
contract. Keep an unresolved requirement in an active proposal or task
before removing the document that contains it.

A decision earns a place in the register when its rationale would still
help someone reconsider a hard-to-reverse choice. Milestone outcomes,
review counts, implementation checklists, and superseded defaults do not.
Do not maintain a second archive directory.

## Historical references

Commit `4dcbb8d` contains the completed substrate plan, RFCs 02 through
13, their reviews, the old decision register, and the resolved audits.
RFC 10 was withdrawn. Later contracts supersede earlier proposals, so the
archive is evidence of decisions at the time, not the current specification.

Historical RFC, PLAN, milestone, and decision labels in test names,
source comments, and evidence remain provenance identifiers. Look them up
in that revision or in the named file's Git history. They do not require
restoring the old document to the working tree.

Generated evidence under `spikes/evidence/` and recordings under
`test/fixtures/` stay intact. Some tests consume them. Their dated prose
may refer to retired documents; regenerate evidence through its script
when a new observation is needed, never rewrite an old result by hand.

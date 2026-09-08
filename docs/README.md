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
| Understand a lasting tradeoff | [Architecture decisions](adr/README.md) |
| Verify a change | [AGENTS](../AGENTS.md) and [smoke verification](smoke-seven.md) |
| Propose a change | [RFC lifecycle](rfc/README.md) |

## Browser design

[Reading-view design](design.md) records current visual rules. The
[interaction brief](design-brief.md) describes the document and conversation
states. The runnable behavior reference uses the app's instrumentation.
Build it with `bun run build:reference`. Dated coverage inventories and
superseded handoff reports are kept in Git, not as current instructions.

## Keep documentation current

Update the reference that owns a changed contract in the implementation
commit. Use an RFC only while a proposal or its implementation remains
active. Once delivered, move its surviving rules into the references,
retain only lasting tradeoffs in [ADRs](adr/README.md), and remove the
RFC, its reviews, and resolved audits. A withdrawn RFC leaves no active
contract. Keep an unresolved requirement in an active proposal or task
before removing the document that contains it.

A decision earns a place in an ADR when its rationale would still
help someone reconsider a hard-to-reverse choice. Milestone outcomes,
review counts, implementation checklists, and superseded defaults do not.
Do not maintain a second archive directory.

## Historical references

Commit `4dcbb8d` contains the completed substrate plan, RFCs 02 through
13, their reviews, the old decision register, and the resolved audits.
RFC 10 was withdrawn. Later contracts supersede earlier proposals, so the
archive is evidence of decisions at the time, not the current specification.

Commit `743a48c` contains completed RFCs 14 and 15, their reviews, and the
resolved annotated-comparison and local-hub ticket sets.

Historical RFC, PLAN, milestone, and decision labels in test names,
source comments, and evidence remain provenance identifiers. Look them up
in that revision or in the named file's Git history. They do not require
restoring the old document to the working tree.

Generated smoke output goes under ignored `artifacts/evidence/`. It is
run output, not source context. Capture a recording under `test/fixtures/`
only when an oracle consumes it; keep that recording unchanged and document
its purpose beside it. Do not retain abandoned experiments or machine-local
review sessions in the repository.

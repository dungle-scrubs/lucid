# Read saved content changes in the artifact view

Status: draft
Blocked by: none

## What to build

A person compares an earlier saved version with the latest saved version without leaving the artifact view. The view clearly identifies earlier and current content, preserves surrounding context, and changes between aligned columns and inline reading as available artifact width changes.

## Acceptance criteria

- [ ] The shared header, conversation panel, saved-version navigation, and pending-work guards remain available; comparison itself creates no input or artifact version.
- [ ] Real saved content drives the view. Prototype samples and simulated transcript entries are absent from production.
- [ ] Additions, removals, and changed words have explicit indications beyond color. Removed passages stay readable; empty counterparts are labeled absent.
- [ ] Source passage addresses belong to immutable source versions and exclude comparison wrappers and highlighting.
- [ ] Repeated text, arbitrary rewrites, moves, and ambiguous matches do not acquire false source correspondence. Ambiguous changes can appear as separate additions and removals.
- [ ] Extraction is inert and bounded; malicious markup cannot execute, fetch resources, or enter the privileged application DOM.
- [ ] Unsupported content and changes outside the text model are explicitly disclosed. Original saved versions remain inspectable without discarding the comparison or pending work. Detailed non-text comparison depends on the remaining RFC scope decision.
- [ ] Oversized alignment yields a labeled coarse result without silently hiding source content or freezing the page. Unreadable versions name the failed side.
- [ ] Wide and narrow layouts use the same content model. Visual verification covers 390, 768, and 1440 pixels, both themes, and the available width after conversation placement.
- [ ] Notes are not exposed as functional actions until the historical-note ticket is complete. Existing reading, editing, and ordinary annotation behavior remains intact.
- [ ] Deterministic content, isolation, navigation, and bounded-computation checks pass with the full repository suite.

## Parent

[RFC 14: Annotated content comparison](../spec.md)

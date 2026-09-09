---
name: lucid-design
description: Design Lucid artifact content for reading, annotation, and supported interaction. Use when creating or revising an artifact's presentation, writing, navigation, diagrams, or charts. Covers the authored document, not Lucid's application controls.
---

# Lucid artifact design

Use the user's direction first, then the relevant brand or subject's design
system. Otherwise choose a presentation for the reader and the document's job.
Lucid's application colors and typography do not prescribe the document's design.
For emission and revision syntax, read the sibling `lucid/SKILL.md`.

## Build the document

1. Preserve the requested content and human edits. Lead with the decision,
   finding, or next action. Use descriptive headings and concise paragraphs.
2. Establish a deliberate type scale, readable line length, and clear spacing
   between related groups. Use one name for each concept throughout.
3. Provide a linked contents list for long documents and stable, unique HTML
   IDs for navigation. Use native anchors and semantic headings and lists.
4. Keep each reviewable group in real HTML elements. Diagrams use HTML or SVG
   with addressable labels and parts. Code and literal output can use `pre`;
   do not draw diagrams with text characters.
5. Give controls an accessible name, keyboard behavior, visible focus, and
   hover feedback. Use actual controls only when the reader can operate them.
   Describe unimplemented behavior plainly in a mockup.
6. Keep layouts within their container. Allow long tokens to wrap, set
   `min-width: 0` where needed, and contain wide tables or code separately.
7. Prefer self-contained HTML, CSS, and SVG. Use external libraries only when
   they materially improve correctness or interaction; pin their versions and
   identify any network requirement. Never include credentials.
8. Make new reading artifacts adaptive by default. Use the
   [verified example](examples/adaptive-reading.html) for both palettes and
   serialization-safe SVG/canvas colors. Follow the
   [runtime appearance contract](../../docs/artifacts.md#application-and-artifact-appearance)
   for declarations, native media-query selection, and saved-content rules.
   Explicit user or subject-design requirements can select a fixed theme.
   Your colors and typography remain the document's design.

## Verify before delivery

Render at 390, 768, and 1440 pixels. Check reading order, clipping, long content,
links, keyboard focus, controls, and both themes. Test interactions in Lucid's
use mode as well as a standalone render. The artifact runs in a sandbox and
cannot assume access to its parent page or local files.

Use color with text, shape, or position so it is never the only signal. Label
chart units, scales, sources, and whether values are real or illustrative.
Distinguish zero from missing data. Report any behavior that remains untested.

When graphics adapt, compare snapshots after repaint with input held constant.
CSS-driven SVG keeps attributes unchanged; canvas changes pixels only. A script
that rewrites fill attributes or inline styles on a theme change fails this
check. Verify a human text edit survives saving and reopening in the opposite
appearance. Keep an adjacent accessible explanation for canvas/WebGL.

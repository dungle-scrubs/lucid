---
name: lucid-design
description: Design Lucid artifact content for reading, annotation, and supported interaction. Use when creating or revising an artifact's presentation, writing, navigation, diagrams, or charts. Covers the authored document, not Lucid's application controls.
---

# Lucid artifact design

Use the user's direction first, then the relevant brand or subject's design
system. Otherwise design this document for its own subject, reader, and job.
Lucid has no house style. Its application colors and typography do not
prescribe the document's design, and neither does any earlier artifact.
For emission and revision syntax, read the sibling `lucid/SKILL.md`.

## Choose the design

Before writing markup, decide three things from the subject and write them at
the top of the stylesheet as a `:root` token block with a one-line layout
comment above it:

- Palette: 4 to 6 named color tokens drawn from the subject's own world. A
  database migration, a garden plan, and a hiring rubric should not share a
  palette.
- Type: a heading face and a body face, plus a utility face for data or code
  if the document needs one. Load faces from Google Fonts with a `<link>` to
  `fonts.googleapis.com`, embed a face as a `@font-face` data URI, or use local
  stacks such as `ui-sans-serif`, `ui-serif`, `ui-monospace` and `ui-rounded`.
  Give every web face a local fallback stack that still reads well offline.
  Pair faces for this subject; do not reach for the same family on every
  document.
- Layout: the composition that fits the document's job. A decision memo, a
  side-by-side comparison, a timeline, a status board, a diagram with notes,
  a reference table, and a long-form explanation each want a different
  structure. Do not put every document in one centered column.

Match the treatment to the request. A plan or review note gets a polished,
plain treatment with real hierarchy. A page the user will keep, present, or
share can take a stronger identity. Put boldness in one place and keep the
rest quiet.

Avoid the looks generated designs fall into when nothing is specified: muted
sage or forest green on off-white with a serif body; warm cream with a serif
display and terracotta accent; near-black with one acid-green or vermilion
highlight; a purple-to-blue gradient header; an uppercase letter-spaced label
above every heading; emoji section markers; identical rounded cards for every
block. Use one of these only when the user asks for it.

Structure carries meaning. Use numbering only for real sequences, labels only
where they classify something, and cards only for objects that stand apart.

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
7. Prefer self-contained HTML, CSS, and SVG. Google Fonts is the one remote
   resource the document may load by default. Use external libraries only when
   they materially improve correctness or interaction; pin their versions and
   identify any network requirement. Never include credentials.
8. Make new reading artifacts adaptive by default. Declare a fixed `light` or
   `dark` theme only when the user asks for one: the reader's appearance toggle
   cannot change a fixed-theme document, so it stays dark in a light Lucid, or
   light in a dark one. A dark look is a palette choice inside an adaptive
   document, not a reason to fix the theme. Follow the
   [runtime appearance contract](https://github.com/dungle-scrubs/lucid/blob/main/docs/artifacts.md#application-and-artifact-appearance)
   for declarations, native media-query selection, and saved-content rules.

## Adaptive mechanics

An adaptive document declares itself in `head` and defines every color as a
token, light values first, then dark values in a media rule. The values below
are placeholders; the palette is the one you chose above.

```html
<meta name="lucid-theme" content="adaptive">
<meta name="color-scheme" content="light dark">
<style>
  :root { --bg: …; --fg: …; --accent: …; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: …; --fg: …; --accent: …; }
  }
  body { background: var(--bg); color: var(--fg); }
</style>
```

- Declare every token on bare `:root`. A color defined only inside the media
  rule disappears in light mode.
- Give `body` an explicit background from a token.
- Style components through the tokens, never with a literal that reads in one
  theme only.
- SVG takes colors from CSS, for example `fill="var(--accent)"`, so its markup
  stays the same in both themes. Never rewrite `fill` attributes or inline
  styles from script on a theme change.
- Canvas repaints pixels on the `change` event of
  `matchMedia('(prefers-color-scheme: dark)')`, reading colors from the tokens.
  Keep an adjacent accessible explanation for canvas or WebGL content.
- Design the dark palette with the same care as the light one. Do not simply
  invert it; keep contrast legible and the accent working on both grounds.

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
appearance.

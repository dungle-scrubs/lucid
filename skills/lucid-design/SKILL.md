---
name: lucid-design
description: >
  How to design a Lucid artifact - the HTML document a human reviews and marks
  up in the browser. Use when writing or restyling an artifact for `lucid open`,
  or any standalone HTML document meant to be read and annotated. Describes the
  characteristics of a good artifact: paper, not an app screen; self-contained;
  one accent; editorial voice. Optional - Lucid works without it, and a user's
  own brand always wins. Triggers: style a Lucid artifact, design the artifact,
  how should the artifact look, make the plan look good, artifact design.
---

# Designing a Lucid artifact

An artifact is a **document**, not an app screen. A human opens it in a browser
and marks it up the way they'd mark up a colleague's draft. Design it so that
act feels precise, quiet, and editorial.

This is guidance, not a library. There is no stylesheet to import - you write
the CSS. If the user has their own brand, **use theirs**; the defaults here are
for when nobody has said otherwise.

## The characteristics

**It is paper.** A warm cream ground with near-black type, not a dark app
surface. Lucid's chrome is dark and recedes; the artifact is the thing being
looked at, so it advances. A document that looks like the tool around it reads
as a screenshot of software rather than something you'd send to someone. If you
honour the reader's `prefers-color-scheme`, the dark variant is still paper - a
warm, lifted ground that reads as a sheet, never the chrome's own near-black.
See *Responding to dark mode* below.

**It is self-contained, or it is not an artifact.** One inline `<style>` block.
System font stacks. Zero external requests - no CDN, no Google Fonts, no remote
images. Open the file straight from disk with no network and it must look
identical. This is a hard rule: the artifact is content that outlives the review
tool, and a review often happens offline on localhost.

**It has one accent, and the accent means something.** Use it where the eye
should go, and nowhere else. No second accent, no gradient, no glassmorphism, no
neon. If something must stand out and the accent is taken, change weight, size,
or spacing - not hue.

**Type has three jobs.** Serif for prose and headlines (this is where a document
feels like a manuscript). Sans for labels, chips, and table headers. Mono for
anything literal: file paths, identifiers, code, versions. Jump the scale
deliberately - a heading should look like a decision, not a slightly bigger
paragraph.

**Whitespace is the layout.** Be generous. A cramped document reads as a form.

**The voice is a careful editor.** No emoji. No exclamation marks. Sentence case
except proper nouns. No hype words - *powerful, seamless, effortless,
revolutionary, magical, blazing, supercharged, next-gen, unlock, leverage,
delight.* Active voice, present tense. A label earns its words: "Backfill must
run first" beats "It looks like there might be an issue with the ordering here."

**Orwell's six rules govern every word in an artifact.** From "Politics and the
English Language" - they are the test a sentence has to pass before it earns
its place on the page:

1. Never use a metaphor, simile, or other figure of speech which you are used
   to seeing in print.
2. Never use a long word where a short one will do.
3. If it is possible to cut a word out, always cut it out.
4. Never use the passive where you can use the active.
5. Never use a foreign phrase, a scientific word, or a jargon word if you can
   think of an everyday English equivalent.
6. Break any of these rules sooner than say anything outright barbarous.

Rule 3 is the one that bites hardest here. An artifact is read by someone who
will mark it up - every word they have to read before finding the claim is a
word charged against their attention. Rule 6 is not a loophole: it exists so
that avoiding a rule never produces something worse than breaking it.

## A starting palette

Concrete values so a first draft is reproducible, not a library to adopt. Warm,
not clinical - the greys have a little brown in them.

```css
:root {
  --paper:     #faf6ec;  /* the ground - warm cream, never pure white */
  --ink:       #211d15;  /* body type on paper */
  --ink-muted: #5e6773;  /* meta, captions, things that recede */
  --rule:      rgba(33, 29, 21, 0.12);  /* hairline dividers */
  --accent:    #7b6228;  /* the one accent: marks, eyebrows, emphasis */
  --accent-wash: rgba(203, 168, 90, 0.16); /* a highlight behind marked text */
}
```

**Contrast matters here and it is easy to get wrong.** A mid brass reads fine as
a *mark* on cream but fails as *text* on it. Keep the accent for outlines,
eyebrow labels, and washes; keep body copy at full ink. Always pair color with a
non-color cue - a rule, a label, a weight change - so nothing depends on hue
alone.

## Responding to dark mode

**Required, and it costs you one block.** Follow the reader's system setting with
a `@media (prefers-color-scheme: dark)` block - no toggle, no JS. A control and
its persisted state are state the artifact is not allowed to carry: it must
render identically from disk, offline, and a toggle breaks that. Route every
color through a variable, then remap the variables in the media block; the rest
of the stylesheet does not change.

Lucid itself owns the *choice*. The viewer has a paper toggle that applies to
every open artifact at once, and it drives your artifact by setting
`data-lucid-theme` on `<html>` and remapping the six tokens below - which is why
routing every color through them is not a style preference. Hardcode `#fff` and
your artifact ignores the reader; `lucid open` will tell you so at author time.

The dark variant is still **paper, not the app**. Keep the ground warm and
*lifted* - a sheet resting on the chrome, distinctly above the chrome's own
near-black, never equal to it, or the artifact dissolves into the tool. Keep the
same accent and the same type; only the ground and ink invert. Re-check contrast
after the flip: a deep brass that worked as an eyebrow on cream is too dark on a
dark ground, so the accent lifts a step.

```css
@media (prefers-color-scheme: dark) {
  :root {
    --paper:     #211d15;  /* warm dark ground, lifted above the chrome */
    --ink:       #ece3cf;  /* warm off-white, not pure white */
    --ink-muted: #a89d84;
    --rule:      rgba(236, 227, 207, 0.14);
    --accent:    #d9bd7a;  /* the brass lifts so it reads on dark */
    --accent-wash: rgba(203, 168, 90, 0.18);
  }
}
```

## Make it reviewable

These are not taste; they decide whether feedback can attach to what the reader
points at.

**Wrap every reviewable group in a padded container.** A section, a phase, a
card - at least ~16px of padding around its content. That padding is the
comfortable band a reviewer hovers to target the *group* rather than one child
line. Without it the only place to grab the group is the hairline gap between
its children.

**Give things that will get feedback a `data-lucid-id`.** Stable, unique within
the document.

**Do not let a column collapse.** Scaffold with flexbox and reserve grid for a
genuinely uniform matrix. Give text-bearing flex/grid children `min-width: 0`
and `overflow-wrap: break-word`, or one long token wraps a column to one word
per line and the review is wasted.

## Anything visual is markup, never ASCII

Diagrams, flows, charts, timelines, hierarchies, screens, tables of shape and
size - **every** picture in an artifact is built from real elements: padded
`div`s with hairline borders placed by flex or grid, and inline SVG for
anything curved or genuinely drawn. **Never draw one as box-drawing or ASCII
characters inside a `<pre>`.** This is the rule for the whole class, not for
box-and-arrow diagrams alone.

ASCII art fails on every count that matters here. It is a single opaque text
node, so the reviewer can only annotate the whole picture - the node, bar,
region, or label they actually want to correct is not addressable, which
defeats the one thing the artifact exists for. It is frozen at the width you
typed it, so it overflows a narrow window instead of reflowing. And it opts out
of the document's type, color, and spacing: a monospace drawing sitting inside
a manuscript reads as a terminal screenshot pasted onto paper.

Compose from what the artifact already has:

- **Diagrams and flows** - nodes are padded boxes with `--rule` borders and
  sans labels; the accent marks the one node the eye should land on; connectors
  are a border, a thin absolutely-positioned rule, or an `<svg>` line with
  `currentColor`.
- **Charts** - a bar is a `div` with a width or height percentage and a hairline
  border, in a labelled row; a series of them is a flex column with the axis as
  a rule and the values as real text beside each bar. A line or area chart is a
  small inline `<svg>` with a `polyline`. Never a row of `█` or `#` characters,
  and never a chart library: every one is an external request, and the artifact
  must open from disk.
- **Hierarchies and timelines** - nested lists or a grid with rules, not indented
  `├──` runs.
- **Screens** - see *Mockups are wireframes* below.

Give every part a reviewer might point at its own `data-lucid-id`.

Mono and `<pre>` keep the work they are good at: code, file paths, a directory
tree from a real command's output, a log line, a command to run. Those are
literal text being quoted, not pictures being drawn.

## Mockups are wireframes, not designs

When the artifact shows a **screen** - a layout, a page, a component, an app
view - draw it as a **wireframe**, not as finished visual design. The decision
under review is arrangement: what is on the screen, how it is grouped, what
order it reads in, what each region is for. Colour, imagery, and type
personality are a different decision, made somewhere else, and a mockup that
looks finished collects feedback on the wrong one.

The vocabulary, all built from the artifact's own tokens:

- **Regions** are boxes with a `--rule` hairline and a mono label naming what
  goes there, not a rendering of it: `header · logo, primary nav`, `results ·
  12 per page`.
- **Images and media** are a placeholder box carrying its own spec, never a
  real picture and never a grey slab. Fill it with faint diagonal hatching and
  label it with what it must be:

  ```css
  .placeholder {
    border: 1px solid var(--rule);
    background: repeating-linear-gradient(
      45deg, transparent 0 6px, rgba(33, 29, 21, 0.06) 6px 7px
    );
  }
  ```

  ```html
  <div class="placeholder" data-lucid-id="hero-image">portrait · 3:4 · b&amp;w preferred</div>
  ```

- **Text** is either the real words, when the words are the point, or a few
  neutral lines at the right length. Never lorem ipsum: nobody can review copy
  that means nothing, and it hides how long the real thing runs.
- **Controls** are labelled outlines - a bordered box reading `Search`, a pill
  reading `Filter ▾` - at the size and position they will really occupy.
- **State and behaviour** are said in words beside the region, not animated:
  `empty state: "no results yet"`, `collapses under 640px`.

Greyscale plus the artifact's single accent, and the accent only where it
carries meaning (the primary action, the region under discussion). No shadows,
no gradients, no rounded-corner styling choices, no brand colour, no icon sets.

**Unless the human asks for a specific visual design.** If they name a brand, a
palette, an existing product's look, or say they want to see the real thing,
build that instead - the general rule is a default for when the design is not
yet the subject, not a refusal to render one.

Every region and placeholder gets its own `data-lucid-id`, so a reviewer can
say "this block goes above the fold" about that block rather than about the
whole screen.

## Checklist

- Opens from disk, offline, and looks right
- No emoji, no exclamation marks, no hype
- Cream ground, ink type, one accent used to mean something
- If it honours dark mode, the dark variant still reads as paper - warm, lifted, distinct from the chrome, and no toggle or JS
- Serif prose, sans labels, mono literals - and mono only for literals being quoted, never for drawing anything
- Every picture - diagram, flow, chart, timeline, screen - built from elements
  or inline SVG, each part individually addressable; no ASCII art anywhere
- Screens drawn as wireframes - labelled regions, hatched image placeholders
  carrying their spec, greyscale plus the one accent - unless a specific visual
  design was asked for
- Every reviewable group padded and, where it matters, carrying a `data-lucid-id`
- Nothing depends on color alone

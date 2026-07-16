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
as a screenshot of software rather than something you'd send to someone.

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

## Checklist

- Opens from disk, offline, and looks right
- No emoji, no exclamation marks, no hype
- Cream ground, ink type, one accent used to mean something
- Serif prose, sans labels, mono literals
- Every reviewable group padded and, where it matters, carrying a `data-lucid-id`
- Nothing depends on color alone

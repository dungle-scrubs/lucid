# Lucid - the design system

The brand and interface language for **Lucid's own UI**: the viewer chrome, the
overlay, the CLI's voice, and the marks. It is the design of the *tool*.

It is deliberately **not** the design of the artifact. The artifact is the
agent's content, it renders identically with or without Lucid, and its design
guidance lives in the optional `lucid-design` skill (`skills/lucid-design/`).
Chrome recedes; paper is the spectacle. Do not apply the ink ground below to a
document.

The whole product is about one act: **pointing at a specific thing and saying
what you mean.** The design exists to make that act feel precise, quiet, and
editorial - closer to marking up a manuscript than filing a ticket.

This is not a generic dashboard kit. It is opinionated on purpose. When in
doubt, remove the second thing.

The tokens are real and live in `client/chrome/styles.css` (Tailwind v4
`@theme`). That file is the implementation; this document is the reasoning.

---

## 1. Voice and posture

Lucid sits between a person and an agent at the moment of review. The tone is
that of a careful editor: exact, unhurried, never selling. The interface should
feel like good paper and a sharp pencil, not a SaaS console.

- **Considered, not loud.** State what a thing is and what it does. Let the work
  be the spectacle.
- **Precise, not chatty.** A label earns its words. "Backfill must run first"
  beats "It looks like there might be an issue with the ordering here."
- **Editorial, not corporate.** Serif headlines, real sentences, generous measure.

---

## 2. Content fundamentals

Copy is part of the design. Write it the way you'd annotate a colleague's draft.

**Rules**

- No emoji. Anywhere.
- No exclamation marks. The work is interesting enough.
- No hype words: *powerful, seamless, effortless, revolutionary, magical,
  blazing, supercharged, next-gen, unlock, leverage, delight.*
- Sentence case for everything except the wordmark. No Title Case Buttons.
- Prefer the concrete noun: "annotation", "version", "artifact", "surface", "the
  agent" - the product's own vocabulary (see `CONTEXT.md`).
- Active voice, present tense. "The agent reordered the steps." not "The steps
  have been reordered by the agent."
- Numbers and counts are plain: "3 annotations", "v2", "evt_00042".

**On-brand vs off-brand**

| Off-brand | On-brand |
|---|---|
| Supercharge your reviews with Lucid | Mark up the agent's work where it's wrong. |
| Oops! Something went wrong | The artifact couldn't be read. Check the file path. |
| Your feedback has been successfully submitted! | Sent. 3 annotations queued to the agent. |
| Powerful, seamless agent collaboration | Point at the line. Say what you mean. The agent gets it. |
| Click here to get started | Open an artifact to begin a review. |
| AI-powered annotation engine | Located feedback, looped back to the agent. |
| Review suspended - please try again later | Review suspended. Run `lucid open` to resume. |

Empty states, errors, and confirmations follow the same voice: a fact, then the
next action. Never apologize for the user's feelings, never celebrate at them.

---

## 3. Visual foundations

### 3.1 Color

One dark theme for the chrome. **Dark ink ground, cream type, a single brass
accent.** No second accent, no gradient, no glassmorphism, no neon. Color is
used sparingly and always means something.

| Token | Role | Notes |
|---|---|---|
| `--color-bg` / `-raised` / `-inset` | Ink ground, panels, input wells | Warm near-black, never pure `#000`. |
| `--color-surface` / `--color-surface-ink` | The artifact / paper, and type on it | Warm cream. The agent's HTML renders here; the chrome only supplies the ground. |
| `--color-fg` / `-strong` / `-muted` | Cream type | Body, emphasis, meta. |
| `--color-accent` (**brass**) | Attention, annotation, focus | The only accent. Use it where the eye should go. |
| `--color-agent` (**sage**) | Agent attribution | Sage = the machine. |
| `--color-user` (**amber**) | User attribution | Amber = the human. |
| `--color-danger` (**rust**) | Destroy / discard / reject | Only for irreversible or negative actions. |
| `--color-meta` (**steel**) | Quiet text, dividers, scaffolding | The color of things that should recede. |

**The discipline that matters:** brass marks *where attention is* on the surface
(an annotation, a focused control). Sage and amber mark *who is speaking* in the
conversation (agent vs user). A user's annotation outline is still brass - brass
is "attention is here", not "the user did this". Keep these jobs separate and
the interface stays legible.

Backgrounds layer cool-to-warm: `--color-bg` (deepest) → `--color-bg-raised`
(panels) → `--color-bg-overlay` (hover/selected). Borders are hairlines, not
boxes.

**Fonts are self-hosted-or-bust.** The viewer is a localhost tool that must work
with no network, so the `--font-*` stacks degrade to system faces rather than
importing from a CDN. Never add a Google Fonts import.

### 3.2 Type

Three families, three jobs.

- **Serif - `--font-serif` (EB Garamond).** Prose, headlines, pull-quotes, and
  brand moments. The brand voice is **EB Garamond italic** - use it for the
  wordmark feel, hero lines, and the occasional editorial aside. Serif is where
  Lucid feels like a manuscript.
- **Sans - `--font-sans` (Geist).** All chrome: labels, buttons, panels, menus,
  tables, form controls. If a person clicks it, it's Geist.
- **Mono - `--font-mono` (Geist Mono).** Anything technical and literal: file
  paths, cursors (`evt_00042`), code, captured snippets, version hashes, CLI.

Jump the scale deliberately. Line height loosens for serif prose and tightens
for display. Uppercase eyebrow labels are small, semibold, tracked out, and
muted.

### 3.3 Space, radius, shadow

- **Space** on the 4px scale. Be generous; whitespace is the layout. Panels
  breathe, not crowd.
- **Radius** is soft, not round: `--radius-md` (7px) for buttons and cards,
  `--radius-lg` (12px) for panels and floating surfaces, pill for chips.
- **Shadow is structural, not decorative.** A shadow means "this floats above
  the page": tooltips, menus, the diff bar, the newer-version banner. In-panel
  cards and buttons get a hairline border and a background step instead -
  **never** a shadow.

### 3.4 The annotation, exactly

This is the heart of the product; get it right.

- **Element annotation = the focus outline.** 2px brass, 2px offset (the
  `annot-outline` utility). The same treatment is the keyboard focus ring.
  "Selected", "focused", and "annotated" are the same visual idea: *attention is
  here.*
- **Text-range annotation = a translucent brass highlight.** A wash of brass, no
  outline, so it reads as marked text rather than a boxed element.
- A small brass marker may sit at the start of an annotated region. Orphaned
  annotations (anchor no longer attaches) move to a tray and lose their
  on-surface mark - they are listed, never floated at a stale spot.

---

## 4. Iconography

**Words first, icons second.** Most things should be a label, not a glyph. When
an icon genuinely helps:

- Use **[Lucide](https://lucide.dev)** only. Never draw an SVG from scratch.
  Copy the path data inline: stroke style, `stroke-width: 1.5`,
  `stroke: currentColor`, no fills.
- Size to the text: 16px beside small text, 18-20px for primary actions.
- An icon pairs with a label far more often than it stands alone. Solo icons are
  for truly universal actions (close, expand) with an accessible label.
- The agent loop has its own motifs (see `assets/lucid-flow.svg`): the artifact,
  the annotation bracket, the loop arrow. Reuse those rather than inventing new
  ones.

## 5. Components

The **running chrome is the reference implementation** - `client/chrome/` is the
only source of truth for what a Lucid control looks like. There is no separate
kit to copy from; a hand-maintained twin drifts from the real thing the moment
either moves.

Chat and transcript primitives come from **assistant-ui**. Everything it does
not cover (sidebar, tabs, shell) comes from **shadcn/ui, the Base UI variant**,
vendored under `client/chrome/ui/` and reading these ramps through the
`@theme inline` bridge in `styles.css`. See `AGENTS.md` for the vendoring rules.

## 6. Assets

- `assets/lucid-wordmark.svg` - the **Lucid** wordmark (serif, with the brass
  mark). Reference it; do not redraw the letters.
- `assets/lucid-mark.svg` - the standalone logomark: a surface with one element
  held in a brass annotation bracket. It is the favicon, served by
  `src/server/server.ts`.
- `assets/lucid-flow.svg` - the agent → artifact → human → feedback loop, in
  brand color. Use in docs, empty states, and explainer slides.

All three are token-aligned (ink/cream/brass) and use live `currentColor` where
they can, so they inherit correctly when dropped into a page.

---

## 7. Caveats

- **Don't introduce a second accent.** If something needs to stand out and brass
  is taken, change weight, size, or spacing - not hue.
- **Don't shadow in-panel surfaces.** Reach for a border + background step.
- **Don't Title Case, don't exclaim, don't emoji.** Re-read §2 before writing
  copy.
- **Don't use sage/amber as decoration.** They are attribution (agent/user).
  Coloring a random heading sage breaks the one signal that color carries.
- **Don't redraw the wordmark or the mark.** Use the SVGs.
- **Don't style the artifact with this system.** It is the chrome's. The
  artifact is paper and belongs to whoever asked for it; see the `lucid-design`
  skill.
- **Accessibility:** brass-on-ink and cream-on-ink meet contrast; brass *text*
  on cream does not - use brass for marks and outlines on the surface, never for
  body copy on paper. Always pair color with a non-color cue (the outline, a
  label, a glyph).

> Point at the line. Say what you mean. The agent gets it.

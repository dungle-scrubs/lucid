# Design delta: handoff v2

The handoff at
`/Users/kevin/Downloads/design_handoff_lucid_reading_view 2`
(note the ` 2`) revises the package the design pass was built against.
Only two files differ from v1: `README.md` and `Lucid - reading view v2.dc.html`.
`spec.md` is unchanged. The v2 folder is the authority from now on; the v1
folder stays beside it for diffing.

Three changes, and one scoping ruling.

## 1. Tokens: eggshell, not cream

The process-yellow warmth is gone. The v1 local tokens `--paper` (7%
process yellow), `--sepia` and `--sepia-2` are replaced:

```
--paper:    color-mix(in srgb, #fff 94%, var(--color-bg) 6%)              /* the sheet */
--ground:   var(--color-bg)                                               /* app ground behind it */
--ground-2: color-mix(in srgb, var(--color-bg) 95%, var(--color-text) 5%) /* explainer panels */
--edge:     color-mix(in srgb, var(--color-text) 13%, transparent)
--edge-2:   color-mix(in srgb, var(--color-text) 22%, transparent)
```

"The ground is **eggshell, not cream** - Broadsheet's process yellow is
deliberately absent from every token here. An earlier version warmed the
paper with it; that was rejected."

Consequences, everywhere the v1 tokens landed:

- The sepia ground behind the sheet becomes `--ground` + the same patterns.
- The 2a at-rest ground, the 6d artifact row ("sepia row" is now the
  "ground-tinted row"), and any `--sepia-2` usage move to `--ground` /
  `--ground-2`. Explainer cards (the 3b/3c-style statement cards) sit on
  `--ground-2`.
- The injected frame stylesheet in `instrument.ts` shares the tokens; the
  behaviour reference (`reference.tsx` / `reference.css`) renders from the
  same exported `STYLE` and must keep rendering from it.

## 2. The driver line (7a-7d) - new

One line of 11.5px text docked under the prompt, aligned to the field
(46px left inset, clearing the clip button). Segments:
**harness · mode · model · effort**, separated by `·` at 50% opacity.
Voice matches the transcript datelines.

Full treatment is specified in the v2 README, section "7a-7d - The driver
line: harness, mode, model, effort". Headlines:

- At rest: neutral 52% ink, no borders, no carets - quieter than the
  composer placeholder.
- Hover: that segment only - `--color-accent-100` pill, `--color-accent-800`
  text, 9px caret. Separators do not move.
- Open: segment goes solid `--color-accent`, white text, caret flips; menu
  opens upward (the row is bottom-docked): `--paper`, 1px `--edge-2`,
  radius 10px, 5px padding, no shadow; selected row accent-100 with a check
  glyph; 12px gutter alignment; composer dims to 40%.
- Harness and model menus align left to their segment; **effort opens
  right-aligned** (no room to its right in 352px).
- Effort carries a per-option gloss ("answers fast, thinks little" /
  "the default" / "longer turns, fewer of them"). Harness and model do not.
  One reassurance line in the harness/model menu: changing the model does
  not restart the conversation.
- The separators are not siblings: each `·` is bound into one unbreakable
  flex item with the label that follows it. A wrap can only break *before*
  a separator. Never shorten labels, never truncate; wrap to a second row
  with a 5px row gap.
- Mode governs the rest of the line:
  - `interactive`: harness and model drop to 55% report ink, **no hover
    pill**, **effort absent**; composer placeholder "Interject..."; clip
    button gone.
  - `headless-session`: all four segments live; the line wraps rather than
    truncates.
  - `headless-turn`: same, plus a permanent second line, neutral 48%:
    "Each send starts the harness fresh. This record is what carries
    continuity." A 4px neutral dot marks the mode segment.
- Two reusable rules: **absent, not disabled** (a control that could never
  apply is removed, not greyed); **a consequence with no visual gets words**.
- Mode is glossed twice: hover tooltip (`--color-text` fill, `--color-bg`
  text, 232px, radius 8px, 9px/11px padding, no shadow, no tail, opens
  upward with 6px air, ~400ms delay in and none out; touch has no hover -
  there the gloss exists only in the menu), and all three glossed in the
  menu. A mode the current harness makes pointless sits at 45% with the
  reason in its gloss. Tooltip strings verbatim from the product's mode
  table in `CONTEXT.md`.
- Typography rule: the driver line is the only place accent ink appears at
  11.5px, and only on hover or open. Never set prose that small in
  `--color-accent`; use `--color-accent-700` or deeper.
- The state list gains `driver` (harness, mode, model, effort - mode
  decides which of the others are settable).

The designed **mode** here is the product's **profile**
(`interactive` | `headless-session` | `headless-turn`) - the channel
status the client already derives. The conversation header keeps naming
the same driver, so selection and status can never disagree.

## 3. Scoping ruling for this pass

> **Superseded by RFC-12** (`docs/rfc/12_choosing-the-driver.rfc.md`,
> 2026-08-29): the open menus with real harness / model / effort lists
> are now in scope - the preference file, the endpoint, and the honor
> rule that re-spawns the driver are specified there. The ruling's mode
> clause stands: mode never switches into `interactive` from this line,
> and the interactive report-only treatment stands with it.

The line renders from real state. What the browser can change today is
nothing: the harness, its profile, and the model are chosen where the
driver is spawned (`lucid2 chat/run` flags and hook attachment); an input
frame carries text and a mode, not model selection. Per the design's own
rules, a menu whose choice could not act must not be drawn as clickable.

So this pass ships: the full line (typography, segments, separators and
wrap rules, mode variants, tooltips, glosses) rendering the live driver;
the interactive composer variant ("Interject...", no clip button - the
product already attaches interactively through hooks); the headless-turn
permanent line; and the mode tooltip. The open menus with real harness /
model / effort lists land together with driver spawn control in the
substrate - a deliberate gap, recorded here, for Kevin to schedule. Mode
never switches into `interactive` from this line: the attach flow is not
designed ("close this before shipping mode as interactive").

## Definition of done

- No `sepia`, `sepia-2`, or process-yellow warming anywhere in
  `src/server/client/`; `rg -i "sepia|process.yellow"` is clean.
- The driver line renders on every conversation with a driver, in the
  mode variant the channel status names, and its tooltips read verbatim
  from `CONTEXT.md`'s mode table.
- `bun run check` and `bun run build` green on each commit.

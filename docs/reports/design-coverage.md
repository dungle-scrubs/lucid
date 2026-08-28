# Design coverage - reading-view handoff vs built browser surface

What was compared, on what:

- **Commit**: `aa8d9e8` (`design-reading-view`, "docs: coverage inventory of the built browser surface").
- **(A) Designed states**: the handoff package at `~/Downloads/design_handoff_lucid_reading_view` - `README.md` (design spec, values final), `spec.md` (product brief, authority on meaning), and all 17 canvases (2a, 2b, 3a-3g, 4a, 5a, 6a-6f) in `Lucid - reading view v2.dc.html`.
- **(B) Built surface**: `docs/reports/design-reading-view/coverage-2-browser-surface-inventory.md` (same commit), covering everything under `src/server/client/**`.
- **Approved deviations carried into this report**: one 34px header instead of the brief's two bars (driver identity moves to the conversation's own row); Save/Discard in the header instead of a bar under the sheet (the guidance line stays under the sheet).

Coverage values: **covered** (a handoff state specifies it; build as designed), **partial** (core is designed, an edge needs a gap ruling below), **gap** (no handoff state; see the Gaps section), **not-applicable** (out of scope or not a design surface).

## 1. Coverage matrix

### Layout and chrome

| Built surface | Designed as | Coverage | Decision for the implementation stages |
|---|---|---|---|
| Page shell + token set (`--bg --fg --muted --faint --line --panel --accent --error`, app.css:6-19) | Handoff §5 tokens | covered | Replace with Broadsheet variables (`_ds/broadsheet-*/styles.css`) plus local tokens `--paper --sepia --sepia-2 --edge --edge-2` carried over exactly. Source Serif 4 chrome; document body stays sans 14px/1.62. Delete the dark block (app.css:16-28) |
| Top header `.head` (conversationId, driver chip, status) | 34px header (§1) + conversation header row | covered | No full-window bar. Document column gets the 34px header; conversation column gets its own 34px row (conversation name + status pill). Driver identity lands there per the approved deviation |
| Problem banner `.notice` | 3d (dead) | partial | Split by cause: dead token -> 3d header; damaged record -> gap G1; "Not sent" -> gap G2 |
| Two-pane layout `.panes` | §1 window/columns | covered | 14px window padding and gap; document `flex:1 min-width:0`; conversation default 352px; ground bleed pattern behind the sheet |
| Pane divider `.pane-grip` | §1 divider | covered | 1px `--edge-2` line, 3x38px grab handle, `col-resize`. Keep drag, arrow nudge, clamp, localStorage persistence |
| Phone/tablet stacking (app.css:377-393) | none | not-applicable | Out of scope (§8 not designed). Leave as-is pending Kevin |
| Doc header `.doc-head` | the one 34px header (2a/2b/3d) | covered | Rebuild left to right: lucid mark (10px accent dot + 18px wordmark), 1px separator, name, version pill, mode toggle pushed right. 2b/3f fill it ink, 3d fills it magenta, ~120ms fill |
| Name button + rename field | 2a name | covered | 16px, editable in place, pencil on hover; Enter/Escape/blur behavior stays. Inline rename refusal -> gap G3 |
| Version badge `.doc-version` | 2a version pill | covered | Pill in the header |
| Version select `.doc-version-pick` + `.old` red | 2a pill + 6b | partial | Closed state renders as the designed pill (dropdown chrome -> G11). `.old` red violates colour discipline: viewing an old version is waiting, not refusal -> neutral ink. Pinned read-only chrome -> G4 |
| Compare-with select | 6b entry | covered | Pill-styled control that opens the 6b compare view |
| Follow/back button | 6b lock-chip family | partial | Keep behavior; wording and styling join the 6b Close/lock vocabulary |
| Restore button | none | partial | Keep the action; its confirm -> gap G5 |
| Mode toggle `.modes` | 2a toggle, 2b blocked, 3b inert | covered | Pushed right in the 34px header. Blocked while changes pending (2b). `⌥⌫` hotkey unchanged |
| Save bar `.doc-head.saving-bar` | 2b + 3f ink header | covered | Approved deviation: Save/Discard live in the header. Status clause, "Save as vNN" (v26 when 3f overtaken), ~120ms ink fill |
| Offscreen-changes strip `.doc-changed` | 6a off-screen offer | covered | Travel offer docks at the sheet edge nearest the target: accent fill, arrow glyph, "N changes below", white "Jump" pill; taking it centers and lights. Replaces the strip, same driver (`pulsed.offscreen`) |
| Waiting strip `.doc-waiting` (amber) | 3f | covered | Header clause "unsaved - v25 arrived while you typed"; conversation card offers "Save mine as v26" / "Show v25". Amber goes; never magenta |
| Guidance line + `.note-actions` | guidance line under sheet (deviation) | covered | Kept under the sheet. Tones split per colour discipline: waiting -> neutral ink, refusals -> magenta. Saved-outcome text stays |
| Confirm bars `.confirm` x3 | 6c | covered | Discard-edit and discard-and-show become the 6c dialog (392px, `--paper`, 1px `--edge-2`, radius 12px, `--paper` 55% + 1px blur backdrop, no shadow; "Discard them" filled `--color-text`, never magenta). Restore confirm -> G5 |
| Doc empty `.doc-empty` | 3a | covered | Header "No document", no version pill, no mode toggle; dashed-edge panel, one sentence, "Choose a file"; conversation field focused with accent border + 2px `--color-accent-200` ring |
| Unknown-artifact empty | 6d | covered | Heading names the ask (mono on neutral tint), "nothing failed" line, sepia row (file glyph, name, "vN - latest of N - saved by the agent HH:MM"), primary Open, guidance line names the other way |
| `beforeunload` guard | none | not-applicable | Browser-native dialog, not stylable. Leave as-is (G12) |

### In-frame marks (instrument.ts; separate stylesheet injected into the sandboxed frame, sharing chrome tokens - brief §10)

| Built surface | Designed as | Coverage | Decision |
|---|---|---|---|
| Frame ground defaults | §5 tokens in frame | covered | Mark stylesheet carries the chrome tokens into the frame |
| Hover `.lucid-hover` (2px blue) | §2 hover | covered | 1px solid `--color-text` @45%, radius 6px, approach only (<=80ms) |
| Crosshair + selectable | §2 | covered | Unchanged behavior, annotate mode |
| Drag-range `.lucid-range` (amber) | §2 text-span selection | covered | 1.5px accent outline, radius 3px, `--color-accent-200` fill, one box per visual line, mid-word ends |
| Editable-on-approach cue | §2 editable | covered | 1px dashed `--color-text` @35%, `outline-offset: 2px`, approach only. The `hover:none` persistent fallback stays (touch not designed; do not regress) |
| Caret tint (8% teal inset) | §2 caret block | covered | 1.5px solid `--color-text` outline + `--paper` fill, 2px accent caret |
| Selected `.lucid-selected` (amber) | §2 selected | covered | 1.5px `--color-accent` + `--color-accent-100` fill |
| Edited `.lucid-edited` (teal outline) | §2 edited channel | covered | 2px `--color-accent-400` left-edge rule; edited words bold in-block; dirty-posting unchanged |
| Noted `.lucid-noted` (dashed violet) | §2 count chip | covered | Outline removed. 17px pill at block end, `--color-accent-100`/`--color-accent-800`, 10.5px/600; inverts to `--paper` fill + `--color-accent-300` border on a selected block (6f). Driven by queued + anchored note counts |
| New-material pulse (green) | 6a pulse | covered | Accent light 1.5px outline + accent-100 fill, one pulse ~2.6s, viewport-only, reduced-motion respected |
| Focus flash (blue) | 6a on-screen | covered | Accent light in place; scroll only when target is off screen (already the built rule) |
| applyMode, click/drag pick, place reporting, `ready` | behavior | covered | Unchanged |

### Conversation column

| Built surface | Designed as | Coverage | Decision |
|---|---|---|---|
| Thread viewport + empty state | §1 conversation column | covered | Own 34px header (conversation name + status pill), scrolling turn list, composer pinned to bottom |
| Scroll-to-bottom `.to-bottom` (shadowed) | none | gap | G6: ink pill (3g vocabulary), box-shadow removed (app.css:938) |
| User row `.msg.user` | 2a/5a | covered | Serif restyle. Files under message text only where the record holds them (notes path; see section 4) |
| Agent row (+ truncation) | 3c | covered | Serif restyle; truncated turns stay at 70% ink + ellipsis, never deleted |
| Tool row `.msg.tool` | none | gap | G7: keep, fainter than speech, mono glyph, neutral ink |
| Happened pill `.msg.happened` | none | gap | G8: neutral ink pill, serif |
| Refusal row (renders as agent message, defect #176) | 6e + §4 fifth row | covered | Magenta refusal row kind, distinct from agent speech; never alongside cyan in the same component |
| Sent batch `.batch` note cards | §4 anchoring bands | covered | 5x9px bars: 3 filled (exact), 2 (reworded), 1 (by position/by path); 19px grey bar lost; 19px dashed outline not-on-this-version. `goes` cards stay buttons. Built head wording maps onto bands |
| Pending note card | §4 queued | covered | Queued band; woven at write order stays |
| Activity line + pulse dot | 3c + 6e Wait | partial | State renders in the conversation header status pill: neutral ink, count past 8s, "stopped - Nm ago" when stalled. A stall is not a refusal; no magenta. Card actions -> section 4 |
| Queue bar | §4 + 3d | covered | Keep Send ⌘⏎ and discard; neutral ink; queued cards in the timeline remain the primary display. Not the rejected under-sheet footer |
| Attached chips `.chip` (28px) | 4a state 4 | covered | Images: 64px thumbs, filename on translucent ink strip, x in corner. Other files: 32px pills (glyph, name max 128px ellipsis, size, x). One wrapping row above the field |
| Attach control `.attach` | 4a state 1 | covered | 38px clip button left of the field, matching send |
| Composer (40px buttons) | 4a six states | covered | 38px buttons; ghost send at rest, solid with attachments. States 2 and 3 are not built today and are in scope (section 5); refusal chip per 4a state 5; plain-message send refusal -> G2 |
| Note popover `.note-pop` (Radix, shadowed) | 4a composer family | partial | Same treatments as the composer: 38px buttons, 4a-4 chips, no shadow (app.css:796). Popover chrome itself -> G9 |
| Dock block | §1 pinned composer | covered | Composer pinned to bottom; restyle opaque block to `--paper`/neutral |

### Whole views

| Built surface | Designed as | Coverage | Decision |
|---|---|---|---|
| No-artifact route | 3a | covered | As above |
| Unknown-artifact route | 6d | covered | As above |
| Version travel (pin -> read-only) | none | partial | G4: lock vocabulary from 3b/6b. Modes disabled (already), notes refused, frame readOnly (already); header lock chip "viewing vNN - read-only", grey READ ONLY tab, `--edge-2` sheet border, default cursor |
| Overtaken (held version) | 3f | covered | Save lands on top via basedOn/supersededSince (already); presentation per 3f |
| Save flow + outcomes | 2b/3f | covered | Saved-as text in guidance; refused saves (too large, unreadable) -> G10 |
| Compare view `.compare` (line diff) | 6b | covered | Two whole-document 360px sheets side by side; header pill "v24 -> v25", lock chip "read-only - comparing" + Close, no modes. Changed blocks: newer side 2px accent left rule + accent-100 fill; older side neutral 30% rule + 4% fill; removed block dashed seam + centered label (same vocabulary as 3e). Legend + "never reaches the agent" line. Block diff from version-diff.ts (`controls` output finally rendered). Never magenta |
| Pulse on arrival | 6a | covered | Visible blocks pulse; offscreen -> 6a dock offer (replaces `.doc-changed` strip) |
| Place-keeping #180 | behavior | covered | Unchanged |
| Stalled / wedged | 3c | covered | Neutral status pill, truncated turn kept, "The agent stopped here." card with cost; document column does not react. Card actions -> section 4 |
| Dead driver / token | 3d | covered | The only magenta-header state: `--color-accent-2-100` fill, `--color-accent-2-800` text, "No driver" + cause, Reload only action. Sheet `--edge-2` border, grey READ ONLY - NO DRIVER tab, default cursor. Sent turns 55%, queued notes become "Held", composer 50% "Reload to write..." |
| Damaged record | none | gap | G1 |
| `version-diff.ts` `controls` output | 6b | covered | Rendered by the compare view above |

### Non-visual modules

| Built surface | Designed as | Coverage | Decision |
|---|---|---|---|
| anchor.ts, timeline.ts, route.ts, snapshot-dom.ts, layout.ts, hotkeys.ts | behavior | covered | No visual change; every designed state reads from them (mode, pendingChanges, version, driverStatus, selection, notes, noteCountByBlock, queuedNotes, attachments, incomingVersion, travelTarget, compare) |
| reference.tsx behaviour-reference page | none | not-applicable | Dev surface; inherits the frame mark stylesheet through its existing STYLE import. Leave as-is (G14) |

## 2. Gaps - built surfaces with no handoff state

Each gap gets a minimal extension of the designed system (named tokens/marks it reuses) or stays as-is pending Kevin. No new design language.

- **G1 - Damaged-record notice** (`.notice` "damaged past a point"). The handoff covers a dead driver (3d) but never a corrupt log; both are the substrate unable to continue. Handling: extend 3d - same magenta header family (`--color-accent-2-100` fill, `--color-accent-2-800` text), cause line "the record is damaged past a point", single action Reload. Recommended; confirm with Kevin that a damaged record belongs in the magenta family.
- **G2 - "Not sent" message-send refusal** (`setProblem("Not sent: ...")`, app.tsx:2195). The handoff designs attachment refusal (4a state 5) but not a refused message POST. Handling: extend 4a state 5 - magenta chip at the composer where the refused act happened (`--color-accent-2` border, `--color-accent-2-100` fill), reason on the chip, stays until dismissed, not a toast. The substrate refusing, so magenta is correct.
- **G3 - Rename refusal inline reason** (`.doc-rename-problem`). No designed rename-refusal state. Handling: extend 4a state 5's rule - inline magenta text beside the field at the lost-seam label size (11.5px); the substrate refused the title. Keep the field open with the reason (current behavior).
- **G4 - Pinned old version (version travel)**. The handoff has no pinned-version canvas: 3b is someone else's document, 6b is compare. Handling: minimal extension reusing existing vocabulary - 3b's lock glyph and 32%-ink inert edit toggle, 6b's lock-chip wording ("viewing vNN - read-only"), 3d's grey READ ONLY tab minus the driver clause, `--edge-2` sheet border, default cursor. Neutral ink, never magenta. Note: 3b's "annotate stays live" does NOT carry over - pinned old refuses notes (existing product behavior); the pin is fully read-only.
- **G5 - Restore confirm**. 6c names discard as the only destroying control, but the built restore confirm also needs a treatment and 6c is "the only dialog". Handling: reuse the 6c shell (392px, `--paper`, 1px `--edge-2`, radius 12px, 55% + blur backdrop, no shadow). Title "Restore vNN?", body states append semantics (old bytes land as a new version; nothing is destroyed), actions Keep viewing / Restore, filled `--color-text`. Neutral: restoring is not a refusal and not a destruction.
- **G6 - Scroll-to-bottom pill** (`.to-bottom`). Not designed; it will collide with the pill vocabulary if left with its shadow. Handling: ink pill from the 3g family - neutral ink fill, no shadow (delete app.css:938), same radius family as the count chip.
- **G7 - Tool rows** (`.msg.tool`). The handoff's transcript kinds are user, agent, refusal, note cards; tool events are a fifth built kind with no canvas. Handling: keep as built - fainter than speech, mono glyph, neutral `--muted` ink, serif body where it is prose. No new marks.
- **G8 - Happened pill** (`.msg.happened`, "you saved X vN"). Not a designed row. Handling: neutral ink pill, serif, same pill family as the version pill. A save is history, not a user action pending anything.
- **G9 - Note popover chrome** (`.note-pop`). The handoff says "click a block selects + opens a note" but draws no popover canvas. Handling: it is the composer in another position - apply the 4a family: 38px buttons, ghost/solid send, 4a-4 chips, 4a-5 refusal chip, 1px `--edge-2` border, radius 12px, no shadow (delete app.css:796). Anchoring to the selection rect stays.
- **G10 - Refused save outcomes** ("too large", "could not read the document back"). Not designed. Handling: guidance-line refusal tone in `--color-accent-2` text - the substrate refused the save. No new component.
- **G11 - Native select dropdown chrome** (version pick, compare pick). The handoff shows only the closed pill. Handling: restyle the closed state as the designed pill; the open dropdown stays native OS chrome. Leave the open state as-is.
- **G12 - `beforeunload` guard**. Native browser dialog, outside any design surface. Leave as-is.
- **G13 - Phone/tablet stacking and the `hover:none` persistent editable cue**. Explicitly not designed (handoff §8, §5/§8 touch). Leave both as-is pending Kevin; the light-only token pass must keep them legible (the cue's teal becomes `--color-accent` family so it does not break under the new tokens).
- **G14 - reference.tsx behaviour-reference page**. Dev documentation surface, not a product surface. Leave as-is; it inherits the mark stylesheet.

## 3. Designed-but-unbuilt states

- **3b read-only sharing ("Dana's document")** - **N/A**. Single-user product: the record carries no ownership, no other users, no lock cause. Nothing renders as 3b. Its vocabulary (lock glyph, 32% inert edit, "a note is sent, not a change") is reused by G4, with the annotate-live rule dropped because pinned old refuses notes.
- **4a state 6 - sent chips inside a turn bubble** - **mapped-to the sent note batch card**. Files ride notes only: the composer's `onNew` POSTs `{text}` alone (app.tsx:2185) and note files travel through `encodeAnnotationBatch` (app.tsx:1735). Sent files render as 4a-4 chips (no x, keep size) inside the batch card. The "read in full - N words, N rows" accent line renders only what the record states - the agent's own turn text already carries that; the client never computes it. Plain-message sent chips: **N/A pending Kevin** - the composer attach flow stores bytes and shows chips (app.tsx:1935-1986) but no send path carries them; do not fake delivery. Flag to Kevin: either composer attachments route into the next note, or the control's purpose needs a product decision.
- **4a states 2 and 3 - drag-over and uploading** - no built counterpart, **in scope** (ruling below). State 2: dragover/drop wiring plus 1.5px dashed accent outline offset 6px, field `--color-accent-100` reading "Drop to attach - the original is kept". State 3: 2px accent line along the chip's bottom edge, byte count from `file.size` (never a percentage), field stays live; `storeFiles` is a per-file fetch so in-flight is observable.
- **4a state 5 - "over the 512 MB local limit" text** - **mapped-to the real bound**: `ATTACHMENT_BYTES_MAX` is 25 MB (protocol/attachment.ts:24). Chip text reads "over the 25 MB limit"; visual treatment unchanged.
- **3c card actions "Pick it up" / "Ask again"** - "Ask again" **maps to** the existing input POST (composer send). "Pick it up" **N/A**: no distinct record behavior exists for resuming a stalled turn; render the card with the facts and Ask again only, pending Kevin.
- **3g marks-below-fold gradient + pill** - **mapped-to existing state**: block positions arrive via place reports, chip counts via queued + anchored notes, advance via `goBlock`. Pure presentation; implement as designed (56px `transparent -> --paper` gradient, ink pill "N marks below", click advances). Sibling of the 6a dock offer, not a replacement for it.
- **6a lost-travel (light the note in the conversation)** - **mapped-to** the lost batch card: 75% opacity, "lost - nothing left to point at" band, "Open v23 beside this" card (opens 6b). Document does not move; not an error.
- **6e state assignment** - the handoff asks for confirmation of the reading. Confirmed against the built states: nothing-changed -> refusal row (magenta); fix-what-you-did -> 2b/3f ink header; way-in -> 3a and 6d; wait -> working/queued/newer-arrived/stalled in neutral ink (only stalled is a warning, thresholds 3m/turn and 45s/notes already built); reload -> 3d.

## 4. Speculative turns ruling

**4a and 5a are IN scope.** The handoff marks them speculative, but the functionality shipped under RFC-11 (issues 182-194; commits 764b021, 5b8903f, abc2d89, c8ee0ef, 41fdde9, cd56aa3): store, decide-text, deliver, thumbnail, attach-to-note. RFC-11 is the spec the handoff itself asked for. Apply the 4a/5a designs to that built UI: 38px clip, 64px/32px chips with ink strip and sizes, magenta refusal chip at the composer (with the real 25 MB bound), drag-over and uploading states (section 3), sent chips in the note path. 5a's rule - attaching never disturbs the page being read; the document column stays identical to 2a - governs both attachment turns. No other speculative functionality is built.

## 5. Out-of-scope confirmations

- **Dark mode**: not designed. The `prefers-color-scheme` dark block (app.css:16-28) is deleted; the surface becomes light-only.
- **Phone and tablet**: not designed. The `max-width:900px` stacking stays as-is (G13), restyled only insofar as the shared token pass touches it.
- **Touch**: not designed. The persistent editable cue under `hover:none` stays (G13); OS selection-handle collisions are not addressed.
- **Motion vocabulary beyond the pulse**: not designed. No new motion for mode change, note landing, or version arrival. The only specified timings are the ~2.6s in-view pulse, approach marks at <=80ms, and the ~120ms ink header fill; existing 2.6s pulse machinery is restyled, not retimed.

# Coverage 2 - built browser surface inventory

Inventory of every UI element, view, and state `src/server/client/**` can render, for the reading-view design pass. Line numbers are rough (file @ line). "Data" names the state that drives it; "reach" says whether it is reachable in the product today.

## 1. Layout and chrome

| Surface | Where | Data / notes | Reach |
|---|---|---|---|
| Page shell, tokens `--bg --fg --muted --faint --line --panel --accent --error` | app.css:6-19, body 32-48; index.html | Sans 15px body (document body is sans by design; chrome serif is a design change). **Dark block at app.css:16-28 goes away** (light-only per handoff) | always |
| Top header `.head` (id, driver chip, status) | app.tsx:2368-2376; app.css:68-87, `.driver` 873 | `conversationId` from URL; `driver` = harness · model · harnessVersion from poll; `status` string right-aligned. 34px header row in design replaces this | always |
| Problem banner `.notice` (red-bordered) | app.tsx:2379; app.css:89 | `problem` state: dead token, damaged record, conversation read failure, "Not sent" | on failure |
| Two-pane layout `.panes` (document left flex:1, conversation right) | app.tsx:2381-2886; app.css:311-342 | 352px conversation column is a design change; today `clamp(340px,30%,480px)` or dragged `--conversation-width` | always |
| Pane divider `.pane-grip` (hr, drag + keyboard) | app.tsx:2866-2878, startDrag 1145-1180, nudgeDrag 1189; app.css:344-375 | Pointer capture drag; Arrow keys ±16/64px; width 280-900 clamped, doc min 320 (layout.ts:11-14); persisted `localStorage lucid.conversationWidth` | always |
| Phone/tablet stacking `@media (max-width:900px)` | app.css:377-393 | Panes stack, grip hidden. **Out of scope for design** (not designed) | <900px |
| Document header `.doc-head` (name, version, compare, follow, restore, modes) | app.tsx:2447-2553; app.css:396-433 | Replaced by one 34px header row + Save/Discard in design (approved deviation) | with doc |
| - Name button `.doc-rename` | app.tsx:99-165 (DocName); app.css:412-421 | Title from catalog, else artifactId; click to edit | with doc |
| - Rename field `.doc-renaming` + problem | app.tsx:133-164; app.css:423-388 | Input `maxLength=ARTIFACT_TITLE_MAX`, Enter commits / Escape cancels / blur commits; refusal reason shown inline (`.doc-rename-problem`) | renaming |
| - Version badge `.doc-version` (single version) | app.tsx:2466 | `catalog.versions.length < 2`; plain span, 17px count chip in design | one-version doc |
| - Version select `.doc-version-pick` (+ `.old`) | app.tsx:2469-2492; app.css:437-460 | Native select, newest first, options "vN · saved by you / by the agent · current"; picking ≠ latest pins, picking latest unpins; `.old` red when viewing old | ≥2 versions |
| - Compare-with select `.compare-pick` | app.tsx:2495-2513 | Placeholder "Compare with…", resets to "" after pick; only ≥2 versions | ≥2 versions |
| - Follow/back button `.v.latest` | app.tsx:2516-2519 | Shown only when pinned; label "Back to current" (viewingOld) or "Follow newest" | pinned |
| - Restore button `.v.restore` | app.tsx:2520-2528 | Only when pinnedOld; opens `.confirm` | pinned old |
| - Mode toggle `.modes` Edit/Annotate | app.tsx:2530-2551; app.css:943-968; hotkeys.ts:33 | Two segmented buttons, `.m.current`; disabled when pinnedOld; ⌥⌫ toggles from anywhere incl. frame | with doc, not read-only |
| Save bar `.doc-head.saving-bar` | app.tsx:2424-2444; app.css:547-562 | Replaces whole header while `edited`: "Unsaved changes" (+ "they will land on top of the newer version" when overtaken), Discard, Save/Saving… | unsaved edit |
| Offscreen-changes strip `.doc-changed` | app.tsx:2557-2573; app.css:668-684 | "N changes you cannot see. [show the first]" → `goBlock`; from frame `pulsed.offscreen` | new version, changes off screen |
| Waiting strip `.doc-waiting` (amber wash) | app.tsx:2575-2600; app.css:686-706 | "Version N has arrived." + "show it" / (edited:) "save mine first" + "discard mine and show it" | newer version while held |
| Guidance line `.doc-panel`/`.guidance` (+ `.note-actions` saved outcome) | app.tsx:2308-2350 (fn), 2850-2857; app.css:732-762, 848 | Tones idle/ready/warn; texts: no-document, refusal, read-only, unsaved (+overtaken), saved outcome ("saved as vN [based on vM — agent has since written a newer one]"), ⌘-click more, "N notes ready", annotate/edit hints | with doc |
| Confirm bars `.confirm` (3 kinds) | app.tsx:2779-2847; app.css:464-486 | Discard-unsaved-edit; discard-and-show-vN; restore-vN. Inline bar between doc and panel, not a modal (392px dialog in design) | user action |
| Doc empty `.empty.doc-empty` | app.tsx:2389-2411; app.css:109 | "Nothing to annotate yet. Ask the agent for a document." / no-doc-yet variant | no artifact |
| Unknown artifact empty | app.tsx:2387-2407 | "no artifact called 'X'" + "Open 'Y'" button (single artifact per conversation) | bad URL |
| `beforeunload` guard | app.tsx:1299-1311 | Browser-native dialog while `edited`; no lucid wording | unsaved edit |

## 2. In-frame marks (instrument.ts - `STYLE` 66-288, script 290-953)

| Surface | Where | Data / notes | Reach |
|---|---|---|---|
| Element identity + author attrs (`data-lucid-el`, `data-lucid-author`) | instrument.ts:294-310 | `e<n>` document order; author = version author, flips to "human" on touch | every doc |
| Frame ground: `overscroll-behavior:none`, `:where(html)` Canvas bg, focus outlines off | instrument.ts:66-96 | Defaults that lose to a document's own styles | every doc |
| Hover `.lucid-hover` | instrument.ts:91-94; mouseover 866-880 | 2px `#2563eb` outline, annotate mode only | annotate, not read-only |
| Crosshair cursor + selectable text `html.lucid-annotate` | instrument.ts:95-106; applyMode 303-330 | Whole frame cursor:crosshair | annotate, not read-only |
| Drag-range boxes `.lucid-range` | instrument.ts:108-122; paintRange 498-520, coalesceByLine 467-496 | Amber `rgba(251,191,36,.28)` box + `#b45309` 1px outline per visual line, absolutely positioned, `data-lucid` stripped on save | drag over words |
| Editable-on-approach cue `[contenteditable]:hover` | instrument.ts:124-144 | Dotted teal bottom border + 6% inset wash on hover; persistent under `@media (hover:none)` | edit mode |
| Caret focus tint `[contenteditable]:focus` | instrument.ts:147-150 | 8% teal inset wash instead of a ring | edit mode, typing |
| Selected `.lucid-selected` | instrument.ts:151-155; paint 522-532 | Amber 2px outline + 22% wash; click or ⌘-click; drag pick replaces | annotate pick |
| Edited `.lucid-edited` | instrument.ts:156-159; touched 825-851 | Teal 2px outline; input/change on trusted events; sets author=human, posts `dirty` once | edit mode |
| Noted `.lucid-noted` | instrument.ts:160-163; mark handler 770-785 | Dashed violet outline + wash; ids = queued note spots + anchored sent-note targets (app.tsx:2632-2637) | notes exist |
| New-material pulse `.lucid-new-a/b` | instrument.ts:175-205; pulse handler 688-730 | Green inset wash, 2.6s, rise @20% / slow fade; alternated class names to replay; reduced-motion → static green outline; only blocks intersecting viewport; off screen ones reported back instead | version arrival w/ visible changes |
| Focus flash `.lucid-focus-a/b` | instrument.ts:207-235; focus 640-670, go-block 733-750 | Blue inset wash 2.6s (reduced-motion → outline); scrollIntoView center only if not fully in view; same flash for `go-block` arrival | note-card click / show-the-first |
| Mode/readOnly application `applyMode` | instrument.ts:303-330 | contenteditable on leaf text blocks (`plaintext-only` for pre); selection dropped on edit/readOnly; blur active element | mode message + 1s timer |
| Click pick / drag pick handlers | instrument.ts:785-880 | Click = element (⌘-click toggles spot), uncollapsed selection on mouseup = words; controls' mousedown preventDefaulted; click-away clears | annotate |
| Place reporting (`kind:"place"`) | instrument.ts:787-820 (BLOCKS/blocks/reportPlace) | First block whose bottom > 0; index + unrounded top, throttled 150ms on scroll + once at load | every doc |
| Frame `ready` post | instrument.ts:821-823 | Triggers pendingRestore + pendingPulse in parent (app.tsx:724-744) | every doc load |

## 3. Conversation column

| Surface | Where | Data / notes | Reach |
|---|---|---|---|
| Thread viewport `.thread` + empty state | app.tsx:450-459; app.css:890-899, `.empty` 109 | assistant-ui Viewport autoScroll; "Nothing in this conversation yet." | empty conversation |
| Scroll-to-bottom `.to-bottom` "↓ latest" | app.tsx:461-464; app.css:922-939 | assistant-ui ScrollToBottom; hidden `[disabled]`; has box-shadow (no-shadows rule will remove) | scrolled up |
| User row `.msg.user` | app.tsx:324-330 (Message); app.css:124-151 | Right-aligned bordered bubble, white bg | user line |
| Agent row `.msg.agent` + `.who` label | app.tsx:324-330; app.css:128-134 | "agent" smallcaps label above body | agent line |
| Tool row `.msg.tool` (⚙ mark, mono, faint) | app.tsx:243-256; app.css:901-920 | `Line.event === "tool"`; rendered quieter than speech | tool event |
| Happened row `.msg.happened` (centred pill) | app.tsx:314-322; app.css:972-984 | "you saved <id> v<N>", woven at seq via catalog.afterSeq/authors (app.tsx:2210-2255) | human save |
| Refusal row | app.tsx:243-330 | **No distinct kind**: EventKind.error renders as ordinary agent message (defect #176, reference.tsx:394-410). Magenta fifth-row refusal in design maps here | refusal event |
| Sent batch `.batch` → note cards | app.tsx:258-296; app.css:1148-1160 | One card per note: head ("sent · vN", "sent · found again, exactly/reworded/position/by path · vN", "lost its target · from vN", "written against vN · not on this one"), note text, spot snippets; `goes` cards are buttons → focusSpot; orphan/later inert | sent batch in transcript |
| Card palette | app.css:1006-1059, 1190-1194 | `.sent` amber, `.orphan` red, `.later` faint/60%, `.pending` violet, left 3px border style | as above |
| Pending note card `.note-card.pending` "not sent" | app.tsx:298-312; timeline.ts weaveNotes | Unsent notes woven at write-order position | queue non-empty |
| Activity line `.activity` + `.pulse` dot | app.tsx:470-485; app.css:1104-1146; activity.ts | Labels: "the agent is working", "N sent, waiting for the agent", "N written, not delivered yet"; elapsed after 8s; `.stalled` (red, dot stops): >180s turn / >45s undelivered; `workingFor` clock from busy-start + lastChange | busy |
| Queue bar `.queue-bar` | app.tsx:487-509; app.css:1064-1102 | "N notes queued [of 20]" (max shown only within 4 of `NOTE_QUEUE_MAX`=20); Send ⌘⏎ primary; × discard (no confirm) | queue non-empty |
| Attached chips `.attached` + `.chip` | app.tsx:511-534; app.css:153-216 | Image: 28px `.thumb` via object URL; else `.thumb.kind` "text"/"file" word chip; name ellipsis; × remove (revokes URL). Design: 64px thumb / 32px pill with size | composer/note files |
| Attach control `.attach` "+" (hidden file input) | app.tsx:537-549, `.attach.small` 2698-2710; app.css:218-248 | Composer-sized and note-sized variants; `multiple` | always |
| Composer `.composer` | app.tsx:536-555; app.css:250-308 | Textarea placeholder "Send to the conversation…", Send button (40px; design 38px buttons); focus lifts textarea border; disabled styling via `.composer button:disabled` | always |
| Note popover `.note-pop` (Radix) | app.tsx:2620-2774; app.css:780-866 | Anchored to selection rect in `.doc-stage` (shared box, app.tsx:2608); side bottom, alignOffset 28, sideOffset 8, collisionPadding 12; only Escape/Cancel/Add note close (clicks outside prevented); head "N selected — ⌘-click adds more" / "N notes queued — send them before writing another"; textarea "What about this/these N? (⌘⏎ to add)"; in-note chips row; actions: attach-small +, Cancel (ghost), Add note (primary, disabled when empty or full); arrow; **has box-shadow (removed by design)**; 360px width (matches 392px dialog design? no - popover 360, dialog 392 separate) | annotate selection |
| Dock (non-scrolling bottom block) | app.tsx:466-560; app.css:1163-1188 | `.thread-wrap` scrolls; `.dock` = activity + queue + attachments + composer, opaque, one block | always |

### Attachment states vs handoff 4a/5a (six states)

| Design state | Built counterpart | Where | Notes |
|---|---|---|---|
| At rest | Composer + "+" attach control | app.tsx:537-549 | Built |
| Dragging over | **None** | - | No dragover/drop handlers anywhere in the client; only `<input type=file>` | 
| Uploading | **None** (no in-flight visual) | app.tsx:1692-1790 | `storeFiles`/`attachFiles` are async with no indicator; chip appears only on completion |
| Attached | Chips row above composer (+ in-note row) | app.tsx:511-534, 2716-2740 | 28px thumbs, no byte size shown; design says 64px thumb / 32px pill with size |
| Refused | Refusal string via `setRefusal` → guidance line `.guidance.warn` under the **document** (not near the composer); too-large bound is 25 MB (`ATTACHMENT_BYTES_MAX`, protocol/attachment.ts:24) | app.tsx:1699-1707, 1733-1741; guidance 2312-2316 | Reported far from the act; design wants magenta chip that stays until dismissed |
| Sent | Note files: ride inside batch text; sent note cards render but no per-file chips, no "read in full" line. **Composer attachments: `onNew` POSTs `{text}` only (app.tsx:2185) - attached hashes are never named in a plain input and chips never clear on send** | app.tsx:2178-2200, annotations.ts:143 | "Sent chips in the bubble" has no product counterpart today; nearest real state is the plain user bubble. Flag for design mapping, do not fake |

## 4. Whole views

| Surface | Where | Data / notes | Reach |
|---|---|---|---|
| No artifact yet | app.tsx:2408-2411 | "Nothing to annotate yet. Ask the agent for a document." (invitation, design 2a "No document" header state maps here) | conversation w/o artifact |
| Unknown artifact route | app.tsx:2387-2407 | URL names missing id; offers the real one | bad link |
| Version travel (pin) | app.tsx:1515-1531, picker 2469; version-state.ts | Pin = read-only (`pinnedOld`, RFC-07 R6/R7): modes disabled, notes refused (belt+braces 1670), frame `readOnly` drops selection, picker `.old`, restore offered, guidance warn | picker choice |
| Overtaken (held by pending work) | version-state.ts:60-70; app.tsx:1093-1101 | NOT read-only: save still live, lands on top via `basedOn`/`supersededSince` (server superseded-save path); banner + save-bar wording acknowledge it | work pending + new version |
| Save flow | app.tsx:1970-2046 | Snapshot from frame (clean html + control values), POST save; outcomes: "saved as vN", "…based on vM — the agent has since written a newer one", "not saved: …", "too large to store — nothing was saved", "could not read the document back"; follow (unpin) after | unsaved edit |
| Compare view `.compare` (covers doc pane, absolute) | app.tsx:969-1033, rendered 2597-2605; app.css:568-666 | Head: "vX against vY" + count ("identical" / "N added · N removed · N changed" / "+ too large to line up exactly" when coarse) + Close; line-diff.ts rows (same/added/removed/changed), mono 12px, line numbers both sides, washes green/red/amber; 2 columns when ≥720px (`COMPARE_COLUMN_MIN`=360 ×2), else 1 column hiding the earlier side of same/added; `.compare-unreadable` per side | compare-pick |
| Pulse on arriving version | app.tsx:1500-1545 (diff walk), 724-744 (ready→pulse); instrument.ts pulse handler | Visible blocks pulse; offscreen ones → `.doc-changed` offer; fires once per version | version arrival |
| Place-keeping (#180) | app.tsx:1493-1503, 724-733; instrument.ts restore-place 672-685 | Reader's block index + top carried via `diffVersions.carried`; restored after frame `ready`; absent block → top | version change while reading |
| Stalled / wedged reporting | activity.ts (TURN_STALL_AFTER 180, UNDELIVERED_STALL_AFTER 45); app.tsx:433-449 | `.activity.stalled` red, "nothing back for Xm Ys"; workingFor clock needs the page to witness busy-start | long turn |
| Dead driver / dead token | app.tsx:1049-1052, 1428-1431, 2190-2194; 401 → `dead` flag | `.notice` "This page's token is no longer valid — the server restarted. Reload."; all fetches stop; composer sends nothing (silent). Design 1d "READ ONLY — no driver" tab maps here | server restart |
| Damaged record | app.tsx:1450-1454 | `.notice` "damaged past a point; what follows the damage is not shown" | corrupt log |
| Status string | header `.status` | Server-side channel status (e.g. interactive-attached); opaque text today | always |

## 5. Modules with no rendering of their own

- anchor.ts - spot re-anchoring (quote/position/css, Confidence exact/approximate/position/css, sha256 source verification). Drives note-card heads + `goes` + `marked` ids. Not visual itself.
- timeline.ts - weaveNotes placement of pending notes. Data only.
- route.ts - `/c/<id>[/<artifact>[/<version>]]` parse/format; replaceState keeps the bar in step (app.tsx:1216-1228). Not visual.
- snapshot-dom.ts - `flattenNewlines` injected for pre-save. Not visual.
- version-diff.ts - block diff powering pulse/place/compare. `controls` (ControlChange) is computed but **never rendered anywhere**.
- layout.ts, hotkeys.ts - width persistence; ⌥⌫ mode toggle and ⌘⏎ queue-send (window 1284-1305 + frame postMessage).
- reference.tsx + reference.css + reference.html - the behaviour reference page (imports the real STYLE); documents states incl. broken combinations (annotated+hover invisible, annotated+selected invisible, edited+selected wash-through). Design must account for those combinations.

## Facts the design pass must carry

- No shadows anywhere: `.note-pop` (app.css:782 `box-shadow: 0 10px 30px`) and `.to-bottom` (app.css:936) currently have one.
- Light-only: the `prefers-color-scheme: dark` block (app.css:16-28) is removed.
- 352px conversation column replaces `clamp(340px,30%,480px)`; drag bounds 280-900 still apply.
- Composer buttons 38px (today 40px); image thumb 64px (today 28px); attachment pill 32px (today whole-chip); compare column min 360px matches the built `COMPARE_COLUMN_MIN`; dialog 392px vs today's inline `.confirm` bars and 360px `.note-pop`.
- Magenta is only substrate refusals: built refusals today are red `--error` (`.notice`, `.activity.stalled`, `.orphan`, `.doc-version-pick.old`, guidance warn). Diff washes stay green/red/amber neutral.

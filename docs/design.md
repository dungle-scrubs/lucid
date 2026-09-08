# Reading-view design

Use this with the [interaction brief](design-brief.md). Product behavior is
owned by [artifacts](artifacts.md) and [drivers](drivers.md). The brief lists
interaction requirements; this file records the current visual direction.
Source values live in `src/server/client/app.css`. The behavior reference is
built with `bun run build:reference`; its iframe marks use the same exported
instrumentation stylesheet as the app.

## Layout and surfaces

The document has the primary column. The conversation has a narrower reading
column with a resizable divider and no header above its transcript. Driver
controls live under Settings in the composer. Connection, waiting, and working
feedback stays just above the composer, outside the scrolling transcript,
and appears only when there is something to report. Save and discard belong
in the document header; guidance stays beneath the document. Center
the sheet within its column. The artifact can request its maximum width with
`lucid-width` metadata; without it, the sheet fills the available pane. The
Document width header control overrides that preference for this reader and
artifact. Both choices fit the available pane, with a 320px frame floor where
space permits. Spare width shows the patterned ground. The slider starts at
the measured width and displays actual pixels and percentage, while keeping
the requested preference separate. Reset follows the artifact again. The
control remains available during unsaved edits and read-only viewing; comparison
columns retain their own layout.

Keep the neutral ground cool, without process-yellow or sepia warming. The
surrounding surface is darker than the patterned document ground, which is
darker than the page. The document ground mixes the surrounding ground and
paper equally. Topography lines use 6.5% ink opacity. Edit mode uses graph
paper. No shadows: the surface colors and borders provide separation.

Source Serif 4 is the interface typeface. Agent-authored documents retain
their own typography. Cyan marks interaction and progress; magenta marks
refusal. Waiting, read-only history, and restore are not refusals.

## Driver and activity

The composer is one rounded surface: text above, a compact control row
below. The plus button opens the attachment picker. Harness, model, and
reasoning level selectors share that row, aligned to the right, in 10.5px
type. Labels omit the word "effort" and show carets. Long labels wrap;
no selector is truncated. Menus open upward. A background highlight marks
the selected menu option; there is no checkmark or reserved icon gutter. There is no send button:
Enter sends and Shift+Enter adds a line.

The compact selectors display the saved choice; actual mode is a separate
report. Saving never respawns a human-owned interactive session. The full
settings editor handles harness changes, mode, and provider. Its popover
and the working-folder editor stay within the viewport and scroll when
needed. A control for a dimension the harness cannot express is absent.
The headless-turn explanation remains visible beneath the line. Selected
menu rows use background color without a checkbox. Opening a menu does not
change the composer placeholder color.

Hub creation shows the working folder and complete settings before saving.
A definite refusal preserves the fields and its reason. An uncertain response
retains the exact request across reload and offers retry or explicit discard.

Queued input says "Waiting for the agent…"; live work says "The agent is
working…". With saved input and no agent, say "No agent is connected. Your
message is saved." That state has no progress animation or elapsed timer.
Routine progress appears only above the composer. Pending, starting, running,
and completed executions do not add transcript cards. Held, failed, and uncertain
executions retain their recovery cards. A failed
operation keeps its reason at the place where the person attempted it.

Consecutive tool calls form one collapsed activity row with a count. Expanding
it shows the recorded commands in a bounded scrolling list. Replies, errors,
user input, notes, and saved versions break activity groups and keep their
timeline positions. Tool command strings remain available in the details.

Dragging the pane divider updates the document allocation, divider, and chat
size together without size animation. Panel open/close animation remains.

Composer and note sends retain one exact request in this tab until admission
is known. A lost response or expired token keeps a visible saved-send card in
the scrolling conversation, with explicit Retry. Reload restores that card
without sending it. A matching accepted receipt clears it; a matching
admission refusal restores editable text. Malformed recovery data cannot be
sent or replaced automatically. Discarding it is explicit and does not cancel
an accepted input. The recovery card must not push the composer off-screen.

The artifact name uses 14px type and keeps its hover edit icon. Version
tags use 10.5px type, a muted background, no border, and 4px corners.
Annotate/Edit uses a segmented control with 6px outer and 4px inner
corners; cyan marks the active mode.

## Documents and notes

Pinned old versions are read-only, with neutral indicators. Restore appends
a version; confirmation must describe that, without implying history will
be deleted. Keep pending edits and notes through version navigation.

In-frame selection, edits, queued notes, and new material have separate marks.
Annotation hover uses a 2px dotted light-gray (#b8b8b8) outline with a 6px
radius. Selection keeps its solid cyan outline and takes precedence over hover.
Block selection, text-range selection, and edit focus preserve the artifact's
foreground, background, and syntax colors. Use transparent selection interiors;
never cover authored content with an opaque fill or a blend effect. Count chips
and other Lucid-owned labels supply their own complete foreground/background pair.
The annotation cursor is a text cursor directly over text and a crosshair
over surrounding space and non-text content. Links with an `href`, including
their child labels and icons, use a pointer cursor in both modes. They receive
no annotation hover outline, and direct clicks follow the link without selecting
an annotation target. Dragging across linked text can still select words for a
note; the click that ends that drag must not also navigate.
A lost target keeps its note and original snippet. Movement is offered when
the target is offscreen; do not scroll the document on the person's behalf
when an in-place mark can communicate the change. The offscreen note pill
says "notes".

File chips report observed outcomes and actual bounds. Do not claim a file
was read merely because it was offered to the agent. Uploading must not
block the rest of the composer or disturb the document being read.

At 900px and below, the panes stack. The document defaults to two-thirds
of the available height and scrolls internally. A full-width divider with
a dotted handle resizes it vertically, from 15% to 70%; Up/Down arrows
move it too. Desktop width resizing remains independent. The header wraps
its controls when the document column is narrow.

The composer keeps its full border and bottom spacing in empty records.
Before a harness is chosen, the harness selector says "Choose harness";
model and reasoning controls remain visible but disabled. Missing mode
information says "No mode recorded" with an explanation below.

## Saved content comparison

Comparison replaces the document sheet inside the existing layout. Earlier
and reviewed versions are labeled in the header and beside their passages.
The same rows use two columns at 820px of available comparison width and one
column below it. Conversation width is excluded. Narrow layouts show unchanged
text once. Additions and removals use explicit labels and distinct surfaces;
small changes add word-level underline or strike-through. Unsupported content
is disclosed beside the version controls, with saved-source inspection.

One compact note editor sits below the selected source. It starts at one row
and grows with its text. When explicit review removes that source from the
pair, its excerpt and editor span the comparison area above the rows. The
transcript remains in the conversation pane. Accepted source markers link to
the corresponding note. Stale drafts disable fresh Send until Review latest;
unresolved sends show recovery controls without changing their payload.

Comparison has light and dark token sets. The surrounding application retains
its existing light-only theme. Both comparison themes are checked at 390,
768, and 1440px; the existing narrow-pane height divider remains available.

## Limits of the design

The interface is light-only. Preserve the existing narrow-window stacking
and touch editing cues; a full mobile or touch redesign is not specified.
The artifact iframe declares both color schemes so an authored document can
respond to the system preference independently of the surrounding interface.
There is no shared-user ownership mode. Do not copy another person's locked
document state from an old handoff into this single-user product.

## Conversation panel visibility

An empty conversation displays "Start a conversation" and starts with its
conversation panel open. A conversation with documents starts closed.
An explicit URL initializer overrides this default: exactly one
`conversation-panel=open` opens it; invalid or duplicate values close it.
The default is set from the first catalog response, so a new document does not
close an already open panel. `lucid serve [conversation] --conversation-panel open|closed`
prints a link with that initializer; the command does not launch a browser.
History replacements preserve the query and fragment. Existing saved-version
links open independent views with the closed default. Manual toggles save the
current visibility per conversation in the tab's `sessionStorage`. Reloading restores that choice,
which takes precedence over the URL initializer. Invalid or unavailable storage
falls back to the initializer. Toggles do not change URLs or conversation records.

The header's Show conversation / Hide conversation button is available in all
five header branches, including empty, unsaved, historical, comparison, and
connection-error views. It exposes the expanded state and controlled panel.
Closing moves focus to that button, makes the mounted panel inert and hidden
from accessibility tools, and removes the divider from keyboard access.

The whole panel slides right while its layout space closes over about 180ms.
The document gains the available width, or full height when panes are stacked.
The layout clips the moving panel to prevent page overflow. Reduced motion
removes transitions. No timer or transition event controls usability.
Reopening uses the prior pane sizes; resizing or receiving updates never
resets visibility. Comparison columns may reflow with the available space.

The panel, composer, and document remain mounted. Toggling preserves draft
text, attachments, annotation drafts, queued notes, and unsaved document edits.
It does not reset transcript scrolling or stop the conversation's subscriptions.

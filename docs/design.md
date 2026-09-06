# Reading-view design

Use this with the [interaction brief](design-brief.md). Product behavior is
owned by [artifacts](artifacts.md) and [drivers](drivers.md). The brief lists
interaction requirements; this file records the current visual direction.
Source values live in `src/server/client/app.css`. The behavior reference is
built with `bun run build:reference`; its iframe marks use the same exported
instrumentation stylesheet as the app.

## Layout and surfaces

The document has the primary column. The conversation has a narrower reading
column with a resizable divider. Each column has one header. Save and discard
belong in the document header; guidance stays beneath the document.

Keep the neutral ground cool, without process-yellow or sepia warming. The
surrounding surface is darker than the patterned document ground, which is
darker than the page. The document ground mixes the surrounding ground and
paper equally. Topography lines use 6.5% ink opacity. Edit mode uses graph
paper. No shadows: the surface colors and borders provide separation.

Source Serif 4 is the interface typeface. Agent-authored documents retain
their own typography. Cyan marks interaction and progress; magenta marks
refusal. Waiting, read-only history, and restore are not refusals.

## Driver and activity

The driver line follows the composer's left edge. Provider, model, effort,
and profile follow the harness where applicable. Separators stay attached
to the following label on wrap; labels are not truncated. No trailing bullet
follows the profile. Harness and model menus open above their segment;
effort aligns to the right. Menu choices come from hcn, not a design list.

Interactive sessions report their driver without respawn controls. A control
for a dimension the harness cannot express is absent. The headless-turn
explanation remains visible beneath the line.

Queued input says "Waiting for the agent…"; live work says "The agent is
working…". With saved input and no agent, say "No agent is connected. Your
message is saved." That state has no progress animation or elapsed timer.
The header must distinguish waiting from working. A failed operation keeps
its reason at the place where the person attempted it.

## Documents and notes

Pinned old versions are read-only, with neutral indicators. Restore appends
a version; confirmation must describe that, without implying history will
be deleted. Keep pending edits and notes through version navigation.

In-frame selection, edits, queued notes, and new material have separate marks.
A lost target keeps its note and original snippet. Movement is offered when
the target is offscreen; do not scroll the document on the person's behalf
when an in-place mark can communicate the change. The offscreen note pill
says "notes".

File chips report observed outcomes and actual bounds. Do not claim a file
was read merely because it was offered to the agent. Uploading must not
block the rest of the composer or disturb the document being read.

## Limits of the design

The interface is light-only. Preserve the existing narrow-window stacking
and touch editing cues; a full mobile or touch redesign is not specified.
There is no shared-user ownership mode. Do not copy another person's locked
document state from an old handoff into this single-user product.

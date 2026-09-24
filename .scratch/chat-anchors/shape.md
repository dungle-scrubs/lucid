# Chat anchor links - shape comparison

## Outcome

Agent chat text that references an artifact location renders a clickable link.
Clicking travels to that spot in the document, following the same travel rule
as note cards: on screen lights in place, off screen docks a travel offer,
lost or absent stays inert.

## Usage

Agent writes in chat: `see the "Next survey" section` or `the chart caption`.
Chat renders: `see the [Next survey section] (link)` - clicking focuses that
block in the artifact frame.

## Candidate A: Server resolves references at view time

Transcript view carries resolved spans: `{ text, links: [{ start, end, elementId }] }`.
Client renders spans as buttons that call the existing `focusSpot` path.

- Matches note-card travel exactly: element ids already resolved against the
  version on screen, same focus message, same offscreen offer.
- Resolution lives where anchors live: `resolveSpot` walk runs against the
  version on screen, quote/position/path tried in order.
- Cost: every agent line needs passage matching against current bytes.
  Matching is fuzzy text search over the whole transcript on each version
  change. The walk already exists for notes but runs per spot with stored
  selectors; here there are no stored selectors, only free text.

## Candidate B: Agent emits explicit references, client resolves ids

Artifact preamble teaches a reference fence: agent names the passage it means
by quoting it. Client matches the quote against the version on screen with
the existing `resolveSpot` machinery and renders a link only on a match.

- No free-text mining: only quoted passages the agent marked become links.
- Unmatched quotes render as plain text: same rule as a lost note, never a
  guess dressed as a fact.
- Cost: preamble grows, agent must learn a second fence. Agents already emit
  two fences (artifact, patch); a third is the same shape.

## Shared constraints

- Plain text stays plain: assistant-ui renders agent text as one `<p>` with
  `whiteSpace: pre-line`. A custom Text component can render spans.
- Never re-point: a reference that does not resolve renders as text, not as
  a link to the wrong block. Same rule as lost anchors.
- Pinned old version refuses travel: same guard as `goToSpot`.
- Lost target lights nothing in the document: same rule as lost notes.

## Judge

Candidate B. Candidate A requires mining free agent prose for location
references with no stored selectors - a fuzzy match over every line on every
version change, with false positives that point at the wrong block. The
product already refuses to guess for notes; it should refuse the same way
here.

Candidate B reuses the settled machinery: agent quotes a passage, client
resolves it through `selectorsForQuote` + `resolveSpot` against the version
on screen, renders a link only on a match, travels through `focusSpot`.
The failure mode is plain text, which is the correct fallback.

Open question for implementation: the exact fence shape and whether the
reference rides inline in chat text or as a trailing block. Inline quoting
(`"quoted words"` plus an element address) is fragile; a trailing reference
block with explicit quotes is the artifact-fence shape the agent already knows.

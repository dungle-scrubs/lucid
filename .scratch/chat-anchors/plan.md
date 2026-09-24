# Chat anchor links - implementation plan

## Slice 1: reference fence + view strip (protocol, no UI)

Agent emits:

```lucid-references
{"artifactId": "<id>", "version": <n>, "refs": [{"quote": "<exact words from the document>", "label": "<short name>"}]}
```

- `src/protocol/chat-references.ts`: detect, validate, strip. Same shape as
  annotation fence: tolerant read, strict write. Quote capped at 2000 chars
  (SNIPPET_MAX), refs capped at 20 (NOTE_QUEUE_MAX).
- `stripMessageBlocks` in `src/tui/view.ts` strips the fence. Log keeps raw.
- Preamble addition in `src/protocol/artifacts.ts`: teach the fence in one
  paragraph. Agent quotes exact words, gives a short label.
- Tests: `test/protocol/chat-references.test.ts` - detect valid, refuse
  malformed, strip leaves prose, cap enforced.

Slice 1 proves: agent can emit references, view hides the fence, no bytes leak.

## Slice 2: client link rendering + travel (UI)

- `src/server/client/chat-references.ts`: parse stripped?? No - parse from
  what? The view strips the fence, so the client needs the refs. Options:
  (a) view keeps refs as structured data beside text, (b) client parses raw
  text. (a): `ConversationLine` gains `refs?: ChatRef[]`, server includes
  them, client resolves.
- Client resolves each quote against version on screen via `selectorsForQuote`
  + `resolveSpot` against parsed `doc.bytes`. Match renders as button with
  accent underline; miss renders nothing (prose stays as agent wrote it).
- Click calls `goToSpot([elementId])` - same path as note cards, same pinned
  guard, same offscreen offer.
- Custom `Text` component in `MessagePrimitive.Parts` renders the spans.
- Tests: `test/server/chat-references.test.ts` - resolve exact, resolve
  reworded, miss stays text, click travels (jsdom + focusSpot spy).

Slice 2 proves: chat reference travels to the artifact block.

## Slice 3: polish

- Style: accent underline + pointer, hover outline like annotation hover.
- Tooltip on hover: "Go to <label> in the document".
- Behaviour reference entry.
- Docs: design-brief §5 "A note takes you to what it points at" extends to
  agent references.

## What this slice does NOT do

- No free-text mining. Only fenced quotes become links.
- No version pinning. Refs resolve against the version on screen; a ref from
  an old version that no longer matches renders as text.
- No server-side resolution. Client holds the bytes; resolution is local.

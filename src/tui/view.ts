/**
 * ConversationView — the deep module that owns the conversation view
 * projection (C1).
 *
 * Before, the transcript→view pipeline was split across three files:
 * `src/store/log.ts:collectTranscript` assembled the durable history,
 * `src/store/store.ts` re-exported it, and `src/tui/view.ts:buildView`
 * projected it — with the filtering rules (token/message dedup, `done`
 * exclusion, aborted-vs-completed reconciliation) fragmented across the
 * pipeline and the HarnessEvent kind vocabulary mirrored as literals in
 * `view.ts` (`KIND = {token, message, done, ...}`). Fixing a rendering
 * edge required bouncing across `log + store + view` — three edits,
 * three test files — and a normalizer rename silently broke the view
 * (caught only by the live smoke).
 *
 * Now one module owns the whole render policy — which events render,
 * token/message dedup, `done` marker suppression, aborted reconciliation,
 * and the `eventText` extraction — and hides it behind a small, deep
 * interface: `buildView({transcript, status, rung, draft}) → TuiView`.
 * The kind vocabulary is imported once from `protocol/events:EventKind`,
 * never mirrored, so a rename is a single edit. The durable
 * `Transcript` shape stays in `store/log.ts`; this module is the view
 * policy, not the durability. Deletion test: deleting this module would
 * scatter `EventKind` imports, token/message suppression, `done` filtering,
 * and abort reconciliation across every CLI and TUI consumer.
 *
 * Depth: small interface, large hidden policy. What it is NOT: it is not
 * the durable log (ConversationLog owns fold/repair/flock), not the
 * frame codec, and not the liveness/presence projection — it reads what
 * the store already folded (D-009: the view IS fold(log)).
 */

import { EventKind } from "../protocol/events.js";
import type { ChannelStatus } from "../protocol/index.js";
import type { Transcript, TranscriptInput } from "../store/store.js";

/** The disposition mark shown beside a human input line, keyed by the
 * durable last-outcome the transcript records (which, unlike live state,
 * keeps applied and distinguishes rejected). */
const INPUT_MARK: Record<TranscriptInput["status"], string> = {
  outstanding: "…", // requested, no disposition yet
  queued: "»", // accepted, held for a boundary
  applied: "✓", // durably applied
  rejected: "✗", // returned to the queue (never dropped)
};

export interface ConversationLine {
  /** "agent" for a rendered event, "human" for a queued/sent input. */
  readonly kind: "agent" | "human";
  readonly seq?: number;
  readonly text: string;
  /** For a human line: its disposition mark; agent lines have none. */
  readonly mark?: string;
  /** True when this line's turn was retired by an abort-turn (the renderer
   * dims it unless a later `done` shows it completed - the store's
   * transcript documents aborted as a raw signal, not a verdict). */
  readonly aborted?: boolean;
}

export interface TuiView {
  readonly lines: readonly ConversationLine[];
  /** The status line: channel state + selected rung + input box. */
  readonly status: string;
  readonly rung: string;
  readonly inputBox: string;
}

/** Extract renderable text from a folded event payload. Only the rendered
 * classes (message/token text, tool name, progress) surface; the view is
 * a projection, so an unclassifiable payload renders its kind, never a
 * crash. Kind strings are imported from the single `EventKind` vocabulary
 * (`protocol/events`), never mirrored — a rename is a single edit. */
/** hcn's question protocol travels in the message text as a fenced
 * `hcn-question` block AND as a `question` event beside it. The block is
 * protocol, not prose: rendering it raw puts a wall of JSON in the middle
 * of a conversation, which is what it looked like the first time a harness
 * asked something. The log keeps the message verbatim; this projection
 * drops the fence, and the `question` event carries the meaning. */
const stripQuestionBlock = (text: string): string =>
  text
    .replace(/```hcn-question[\s\S]*?```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const eventText = (event: Record<string, unknown>): string => {
  const kind = typeof event.kind === "string" ? event.kind : "event";
  if (kind === EventKind.message && typeof event.text === "string")
    return stripQuestionBlock(event.text);
  if (kind === EventKind.token && typeof event.text === "string") return event.text;
  if (kind === EventKind.question && typeof event.question === "string") {
    const options = Array.isArray(event.options) ? event.options : [];
    const recommended = typeof event.recommended === "string" ? event.recommended : undefined;
    return [
      `? ${event.question}`,
      ...options.map((o, i) => `    ${i + 1}. ${String(o)}`),
      ...(recommended === undefined ? [] : [`    → recommended: ${recommended}`]),
    ].join("\n");
  }
  if (kind === EventKind.tool && typeof event.name === "string") return `⚙ ${event.name}`;
  // An error you cannot read is worse than no error: it says something went
  // wrong and refuses to say what. This fell to the `[kind]` fallback, so a
  // live session that failed to open showed a bare `[error]` while the log
  // held "session did not open: could not spawn hcn ...".
  if ((kind === EventKind.error || kind === EventKind.limit) && typeof event.message === "string")
    return `${kind === EventKind.error ? "✗" : "!"} ${event.message}`;
  if (kind === EventKind.progress && typeof event.label === "string") return `… ${event.label}`;
  return `[${kind}]`;
};

/** Bookkeeping the human transcript does not show. `done` marks the end of a
 * turn and `identity` names the session the harness minted - both belong in
 * the durable log, and neither is anything a person said or was told. Left
 * unfiltered, `identity` fell through to the `[kind]` fallback and printed a
 * bare `[identity]` line between the question and the answer. */
const UNRENDERED: ReadonlySet<string> = new Set([EventKind.done, EventKind.identity]);

export const buildView = (input: {
  readonly transcript: Transcript;
  readonly status: ChannelStatus;
  readonly rung: string;
  readonly draft: string;
}): TuiView => {
  const { events, inputs } = input.transcript;
  const abortedTurns = new Set(input.transcript.aborted);
  // A turn is only shown aborted if it was retired AND never produced a
  // `done` (the store's abort signal includes clean detaches, so a turn
  // with a done in the transcript actually completed - reconcile here).
  const completed = new Set(
    events.filter((e) => (e.event.kind as string) === EventKind.done).map((e) => e.turnId),
  );
  // A turn's text arrives twice by design (token deltas AND the trailing
  // message - events.ts); once the message exists, suppress that turn's
  // token deltas so the view shows the text once, never concatenated.
  const turnsWithMessage = new Set(
    events.filter((e) => (e.event.kind as string) === EventKind.message).map((e) => e.turnId),
  );

  const agentLines: ConversationLine[] = events
    .filter(
      (e) => !((e.event.kind as string) === EventKind.token && turnsWithMessage.has(e.turnId)),
    )
    .filter((e) => !UNRENDERED.has(e.event.kind as string))
    .map((e) => ({
      kind: "agent",
      seq: e.seq,
      text: eventText(e.event),
      aborted: abortedTurns.has(e.turnId) && !completed.has(e.turnId),
    }));

  // Human lines come from the durable transcript, NOT live state: an
  // applied input is trimmed out of ChannelState.inputs, so reading state
  // would drop every message the agent acted on. The transcript keeps it.
  const humanLines: ConversationLine[] = inputs.map((i) => ({
    kind: "human",
    seq: i.seq,
    text: i.text,
    mark: INPUT_MARK[i.status],
  }));

  // One ordered stream by seq - the human input and the agent output
  // interleave exactly as lucid sequenced them (D-009: no separate state,
  // the seq order IS the render order).
  const lines = [...agentLines, ...humanLines].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

  return {
    lines,
    status: `[${input.status}]`,
    rung: `rung:${input.rung}`,
    inputBox: `> ${input.draft}`,
  };
};

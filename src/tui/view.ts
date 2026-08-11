/**
 * The TUI view-model: a PURE projection of the durable conversation into
 * exactly what the terminal shows (D-009 - the view IS fold(log), never a
 * second copy of state). Given the store's transcript, channel status,
 * the selected rung, and the in-progress input buffer, it produces the
 * renderable lines: the conversation, a per-item disposition mark, and
 * the state + rung indicator. Keeping this pure is what lets the rendering
 * be verified without a live terminal - the render() sibling only paints
 * these lines. NOT responsible for input handling, spawning, or the
 * protocol; it reads what the store already folded.
 */

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

/** The HarnessEvent kinds the view keys on, mirrored from the normalizer's
 * event vocabulary in one place so a rename is a single edit, not literals
 * scattered through the projection (a stray "done" literal that stopped
 * matching would silently break abort reconciliation). A cross-repo
 * rename is caught by the M7.2 real-harness smoke. */
const KIND = {
  token: "token",
  message: "message",
  done: "done",
  tool: "tool",
  progress: "progress",
} as const;

/** Extract renderable text from a folded event payload. Only the rendered
 * classes (message/token text, tool name, progress) surface; the view is
 * a projection, so an unclassifiable payload renders its kind, never a
 * crash. */
const eventText = (event: Record<string, unknown>): string => {
  const kind = typeof event.kind === "string" ? event.kind : "event";
  if ((kind === KIND.message || kind === KIND.token) && typeof event.text === "string")
    return event.text;
  if (kind === KIND.tool && typeof event.name === "string") return `⚙ ${event.name}`;
  if (kind === KIND.progress && typeof event.label === "string") return `… ${event.label}`;
  return `[${kind}]`;
};

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
    events.filter((e) => (e.event.kind as string) === KIND.done).map((e) => e.turnId),
  );
  // A turn's text arrives twice by design (token deltas AND the trailing
  // message - events.ts); once the message exists, suppress that turn's
  // token deltas so the view shows the text once, never concatenated.
  const turnsWithMessage = new Set(
    events.filter((e) => (e.event.kind as string) === KIND.message).map((e) => e.turnId),
  );

  const agentLines: ConversationLine[] = events
    .filter((e) => !((e.event.kind as string) === KIND.token && turnsWithMessage.has(e.turnId)))
    .filter((e) => (e.event.kind as string) !== KIND.done) // done is a marker, not a rendered line
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

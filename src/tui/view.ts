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

import type { ChannelStatus, Disposition, QueuedInput } from "../protocol/index.js";
import type { Transcript } from "../store/store.js";

/** The disposition mark shown beside a human input line. */
const INPUT_MARK: Record<Disposition | "outstanding", string> = {
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
 * crash. */
const eventText = (event: Record<string, unknown>): string => {
  const kind = typeof event.kind === "string" ? event.kind : "event";
  if ((kind === "message" || kind === "token") && typeof event.text === "string") return event.text;
  if (kind === "tool" && typeof event.name === "string") return `⚙ ${event.name}`;
  if (kind === "progress" && typeof event.label === "string") return `… ${event.label}`;
  return `[${kind}]`;
};

export const buildView = (input: {
  readonly transcript: Transcript;
  readonly inputs: readonly QueuedInput[];
  readonly status: ChannelStatus;
  readonly rung: string;
  readonly draft: string;
}): TuiView => {
  const abortedTurns = new Set(input.transcript.aborted);
  // A turn is only shown aborted if it was retired AND never produced a
  // `done` (the store's abort signal includes clean detaches, so a turn
  // with a done in the transcript actually completed - reconcile here).
  const completed = new Set(
    input.transcript.events.filter((e) => (e.event.kind as string) === "done").map((e) => e.turnId),
  );

  const agentLines: ConversationLine[] = input.transcript.events.map((e) => ({
    kind: "agent",
    seq: e.seq,
    text: eventText(e.event),
    aborted: abortedTurns.has(e.turnId) && !completed.has(e.turnId),
  }));

  const humanLines: ConversationLine[] = input.inputs.map((i) => ({
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

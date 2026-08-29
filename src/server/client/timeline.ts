/**
 * The order things happened in.
 *
 * A note you have written but not sent is not in the record yet, so it
 * cannot come back from the log with a seq like everything else. It still
 * happened at a moment: write a note, say something to the agent, write
 * another, and all three belong in the order you did them.
 *
 * That order is the whole reason a pending note goes in the timeline rather
 * than in a list beside it, so it is worked out here, where it can be
 * proven, instead of inside a component.
 */
import type { AnnotationSpot } from "../../protocol/annotations.js";

export interface Msg {
  readonly id: string;
  readonly role: "assistant" | "user";
  readonly text: string;
  /** A tool call: the agent working, not the agent talking. */
  readonly tool?: boolean;
  /** lucid refusing the agent - an error or a limit event, the substrate
   * saying no. The fifth transcript kind: magenta, never mistaken for the
   * agent speaking. */
  readonly refusal?: boolean;
  /** The harness failing a turn (rate limit, spawn failure) rather than
   * lucid refusing. Same magenta treatment, different headline: who said
   * no is the difference between "lucid refused" and "the turn failed". */
  readonly harnessFailed?: boolean;
  /** Something that happened rather than something anyone said. */
  readonly note?: boolean;
  /** Where this line sits in the record. Used to place a saved version at the
   * moment it was saved rather than after everything. */
  readonly seq?: number;
  /** A note written but not sent. */
  readonly pendingNote?: PendingNote;
  /** A batch that was sent, drawn where it was sent rather than as a line
   * of stripped text. */
  readonly sentBatch?: SentBatch;
}

export interface SentBatch {
  readonly artifactId: string;
  readonly version: number;
  readonly notes: readonly {
    readonly note: string;
    readonly spots: readonly AnnotationSpot[];
    /** Files the note carried, when it carried any (RFC-11). The record's
     * own references - hash, size, type, name - never bytes. */
    readonly files?: readonly import("../../protocol/annotations.js").AttachedFile[];
  }[];
}

/** A note not yet sent. `at` is how many timeline items existed when it was
 * written, which is what puts it back in the right place. */
export interface PendingNote {
  readonly note: string;
  readonly spots: readonly AnnotationSpot[];
  readonly at: number;
  /** Files attached to this note, by hash. The references are resolved when
   * the batch is built; the queue holds only what identifies them. */
  readonly files?: readonly import("../../protocol/annotations.js").AttachedFile[];
}

/** Put pending notes back where they were written.
 *
 * A note lands before the item that was next when it was written. Notes
 * handed over out of order are placed in order; nothing is dropped and
 * nothing is repeated. */
export const weaveNotes = (messages: readonly Msg[], notes: readonly PendingNote[]): Msg[] => {
  if (notes.length === 0) return [...messages];
  const ordered = [...notes].sort((a, b) => a.at - b.at);
  const out: Msg[] = [];
  let n = 0;
  for (let i = 0; i <= messages.length; i += 1) {
    while (n < ordered.length && (ordered[n] as PendingNote).at <= i) {
      const pn = ordered[n] as PendingNote;
      out.push({
        id: `pending-${n}-${pn.spots.map((sp) => sp.id).join(",")}`,
        role: "user",
        text: pn.note,
        pendingNote: pn,
      });
      n += 1;
    }
    const m = messages[i];
    if (m !== undefined) out.push(m);
  }
  return out;
};

import type { Anchor } from "../anchors/anchor.ts";
import type { WaitPayload } from "../core/payload.ts";

/**
 * Planner <- Lucid bridge (ingest half). Maps a `lucid wait` payload back onto
 * plan-db, keyed by each annotation's anchor: a `D-NNN` anchor is feedback on a
 * ledger decision (-> finding), a `Q-NNN` anchor is the human's answer to a
 * question (-> a decision), and an unmarked located note or a message is a
 * general review finding. The planner runs (or refines) the emitted commands.
 */

export type IngestKind =
  | "decision-feedback"
  | "question-answer"
  | "located-note"
  | "message"
  | "revert"
  | "approve";

export interface IngestItem {
  readonly kind: IngestKind;
  /** Ledger ref (D-NNN / Q-NNN) when the anchor carries one. */
  readonly ref?: string;
  readonly note: string;
  /** Captured target text, for context. */
  readonly snippet?: string;
}

export interface IngestResult {
  readonly plan: string;
  readonly items: readonly IngestItem[];
  /** Suggested plan-db commands (one per item) for the planner to run. */
  readonly commands: readonly string[];
}

const refOf = (target: Anchor): string | undefined => {
  if (target.kind === "element" && target.lucidId && /^[DQ]-\d+$/.test(target.lucidId)) {
    return target.lucidId;
  }
  return undefined;
};

const snippetOf = (target: Anchor): string =>
  (target.kind === "range" ? target.quote.exact : target.snippet)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

const esc = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const PLANDB = "plan-db"; // shorthand; the planner expands to its full mise/tsx invocation

/** Build the ingest result from a wait payload. */
export const ingestPayload = (payload: WaitPayload, plan: string): IngestResult => {
  const items: IngestItem[] = [];
  const commands: string[] = [];
  const add = (item: IngestItem, command: string): void => {
    items.push(item);
    commands.push(command);
  };

  for (const a of payload.annotations) {
    const ref = refOf(a.target);
    const snippet = snippetOf(a.target);
    if (ref?.startsWith("Q-")) {
      add(
        { kind: "question-answer", ref, note: a.note, snippet },
        `${PLANDB} record-decision --plan ${esc(plan)} --topic ${esc(snippet)} --decision ${esc(a.note)} --rationale ${esc("human answer via Lucid")} --decided-by human`,
      );
    } else if (ref?.startsWith("D-")) {
      add(
        { kind: "decision-feedback", ref, note: a.note, snippet },
        `${PLANDB} add-finding --plan ${esc(plan)} --category review --description ${esc(`re ${ref}: ${a.note}`)}`,
      );
    } else {
      add(
        { kind: "located-note", note: a.note, snippet },
        `${PLANDB} add-finding --plan ${esc(plan)} --category review --description ${esc(`${a.note} (at: ${snippet})`)}`,
      );
    }
  }

  for (const m of payload.messages) {
    if (m.role !== "human") continue;
    add(
      { kind: "message", note: m.text },
      `${PLANDB} add-finding --plan ${esc(plan)} --category review --description ${esc(m.text)}`,
    );
  }

  for (const r of payload.reverts ?? []) {
    const ref = refOf(r.target);
    add(
      { kind: "revert", ...(ref ? { ref } : {}), note: r.why },
      `${PLANDB} add-finding --plan ${esc(plan)} --category revert --description ${esc(`revert ${ref ?? snippetOf(r.target)} to v${r.targetVersion}: ${r.why}`)}`,
    );
  }

  if (payload.reviewResolved) {
    items.push({ kind: "approve", note: "human approved the plan review in Lucid" });
    commands.push(
      `# human approved - consider: ${PLANDB} check-convergence --plan ${esc(plan)} (this review counts as a clean pass)`,
    );
  }

  return { plan, items, commands };
};

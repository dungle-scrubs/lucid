import { type AnnotationBatch, encodeAnnotationBatch } from "../../protocol/annotations.js";
import type { HistoricalSpot } from "../../protocol/comparison-note.js";
import { comparisonMetadata, historicalSnippet } from "../../protocol/comparison-note.js";
import type { Passage } from "../../protocol/content-comparison.js";
import type { ComparisonPair } from "./content-comparison.js";
export interface ComparisonDraft {
  readonly spot: HistoricalSpot;
  readonly text: string;
  /** Preserve all evidence when a saved request returns to the editor. */
  readonly restoredNote?: AnnotationBatch["notes"][number];
  readonly restoredText?: string;
}
export const draftForPassage = (
  passage: Passage,
  version: number,
  hash: string,
  start = 0,
  end = passage.text.length,
): ComparisonDraft => {
  const exact = passage.text.slice(start, end);
  const before = passage.selectors.quote.prefix + passage.text.slice(0, start);
  const after = passage.text.slice(end) + passage.selectors.quote.suffix;
  return {
    text: "",
    spot: {
      id: passage.id,
      author: passage.author,
      sourceVersion: version,
      sourceHash: hash,
      snippet: historicalSnippet(exact),
      selectors: {
        css: passage.selectors.css,
        position: {
          start: passage.selectors.position.start + start,
          end: passage.selectors.position.start + end,
        },
        quote: { exact, prefix: before.slice(-32), suffix: after.slice(0, 32) },
      },
    },
  };
};
export const comparisonDraftText = (
  artifactId: string,
  pair: ComparisonPair,
  draft: ComparisonDraft,
): string | null => {
  if (!pair.reviewed) return null;
  const original = draft.restoredText ? comparisonMetadata(draft.restoredText) : null;
  const encoded = encodeAnnotationBatch({
    ...(original?.kind === "comparison" ? original.batch : {}),
    artifactId,
    version: draft.spot.sourceVersion,
    comparison: {
      earlierVersion: pair.earlierVersion,
      reviewedVersion: pair.reviewedVersion,
      reviewedHash: pair.reviewed.hash,
    },
    notes: [
      {
        ...draft.restoredNote,
        note: draft.text,
        spots: draft.restoredNote?.spots ?? [draft.spot],
      },
    ],
  });
  const summary = `Historical note: source v${draft.spot.sourceVersion}; reviewed v${pair.reviewedVersion}.`;
  return draft.restoredText
    ? draft.restoredText
        .replace(/^Historical note: source v\d+; reviewed v\d+\./, () => summary)
        .replace(/```[ \t]*lucid-annotations[ \t]*\n[\s\S]*?```/, () => encoded)
    : `${summary}\n\n${encoded}`;
};
export const restoreComparisonDraft = (text: string): ComparisonDraft | null => {
  const metadata = comparisonMetadata(text);
  if (metadata.kind !== "comparison") return null;
  const spot = metadata.batch.notes[0].spots[0];
  return spot
    ? {
        spot,
        text: metadata.batch.notes[0].note,
        restoredNote: metadata.batch.notes[0],
        restoredText: text,
      }
    : null;
};
export const draftIsOnPassage = (
  draft: ComparisonDraft,
  passage: Passage,
  version: number,
): boolean =>
  draft.spot.sourceVersion === version &&
  draft.spot.id === passage.id &&
  (draft.spot.selectors?.position.start ?? -1) >= passage.selectors.position.start &&
  (draft.spot.selectors?.position.end ?? -1) <= passage.selectors.position.end;

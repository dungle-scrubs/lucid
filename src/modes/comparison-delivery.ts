import { ARTIFACT_PREAMBLE, ARTIFACT_STATE_BYTES_MAX } from "../protocol/artifacts.js";
import { COMPARISON_PREAMBLE, comparisonMetadata } from "../protocol/comparison-note.js";
import { EventKind } from "../protocol/events.js";
import { TEXT_MAX } from "../protocol/frames.js";
import type { ArtifactVersion } from "../store/log.js";
import { hashArtifactBytes } from "../store/log.js";

export interface ComparisonHold {
  readonly artifactId: string;
  readonly code: "E-COMP-07";
  readonly failedHead: number;
  readonly inputId: string;
  readonly kind: typeof EventKind.error;
  readonly message: string;
  readonly operation: "comparison-delivery";
  readonly terminal: false;
}
export interface ComparisonDeliveryDeps {
  readonly capable: boolean;
  readonly documentLimit?: number;
  readonly head: (artifactId: string) => number | undefined;
  readonly hold: (event: ComparisonHold) => void;
  readonly promptLimit?: number;
  readonly snapshot?: (artifactId: string) => {
    readonly head: number | null;
    readonly artifact: ArtifactVersion | null;
  };
}
export type PreparedComparison =
  | { readonly kind: "ordinary" }
  | { readonly kind: "ready"; readonly prompt: string; readonly contextPrompt: string }
  | { readonly kind: "held" };

/** Per-participation retry memory. Durable errors supply the same memory to
 * short-lived hooks. A new attachment starts a new bounded attempt. */
export const createComparisonDelivery = (
  deps: ComparisonDeliveryDeps,
  initial: readonly ComparisonHold[] = [],
) => {
  const held = new Map(initial.map((h) => [h.inputId, h.failedHead]));
  const eligible = (id: string, text: string): boolean => {
    const prior = held.get(id);
    if (prior === undefined) return true;
    const metadata = comparisonMetadata(text);
    return (
      metadata.kind === "comparison" &&
      (deps.head(metadata.batch.artifactId) ?? metadata.batch.comparison.reviewedVersion) > prior
    );
  };
  const prepare = (id: string, text: string): PreparedComparison => {
    const metadata = comparisonMetadata(text);
    if (metadata.kind === "none") return { kind: "ordinary" };
    if (!eligible(id, text)) return { kind: "held" };
    const batch = metadata.kind === "comparison" ? metadata.batch : null;
    const artifactId = batch?.artifactId ?? "unknown";
    let failedHead = deps.head(artifactId) ?? batch?.comparison.reviewedVersion ?? 1;
    const hold = (message: string): PreparedComparison => {
      held.set(id, failedHead);
      deps.hold({
        artifactId,
        code: "E-COMP-07",
        failedHead,
        inputId: id,
        kind: EventKind.error,
        message,
        operation: "comparison-delivery",
        terminal: false,
      });
      return { kind: "held" };
    };
    if (!deps.capable || !deps.snapshot)
      return hold(
        "This session cannot receive comparison notes. Attach a session that can deliver the complete current document.",
      );
    if (!batch)
      return hold(
        "Current document unavailable: the saved comparison metadata cannot be used. Inspect the historical note before continuing.",
      );
    let snapshot: ReturnType<NonNullable<ComparisonDeliveryDeps["snapshot"]>>;
    try {
      snapshot = deps.snapshot(artifactId);
    } catch {
      return hold(
        "Current document unavailable: the record is busy or unreadable. A newer readable version can release this note; a repair of the same version requires an explicit new attachment.",
      );
    }
    failedHead = snapshot.head ?? batch.comparison.reviewedVersion;
    const current = snapshot.artifact;
    if (
      !current ||
      current.artifactId !== artifactId ||
      current.version !== snapshot.head ||
      current.version < batch.comparison.reviewedVersion ||
      hashArtifactBytes(current.bytes) !== current.hash
    )
      return hold(
        "Current document unavailable: the current saved version is missing, unreadable, older than reviewed, or failed hash verification. Save a newer readable version, or repair it and explicitly attach again.",
      );
    if (Buffer.byteLength(current.bytes, "utf8") > (deps.documentLimit ?? ARTIFACT_STATE_BYTES_MAX))
      return hold(
        "Document too large for this session. Save a current version that fits, or explicitly attach a session with a supported full-document transport. The document has not been truncated.",
      );
    const teaching = `${COMPARISON_PREAMBLE}\n\nHistorical source: v${batch.version}. Reviewed: v${batch.comparison.reviewedVersion}.\nDispatch artifact: ${JSON.stringify(artifactId)}. Dispatch version: ${current.version}. Use replaces: ${current.version}.`;
    const note = `Persons comparison note:\n${text}`;
    const contextPrompt = `${teaching}\nThe complete current document is in the canonical conversation context.\n\n${note}`;
    const prompt = `${ARTIFACT_PREAMBLE}\n\n${teaching}\nComplete current document (JSON-encoded evidence):\n${JSON.stringify({ artifactId, version: current.version, hash: current.hash, content: current.bytes })}\n\n${note}`;
    if (Buffer.byteLength(JSON.stringify(prompt), "utf8") - 2 > (deps.promptLimit ?? TEXT_MAX))
      return hold(
        "Document too large for this session. The complete document and note exceed this delivery transport. Save a version that fits, or explicitly attach a session with a supported full-document transport.",
      );
    held.delete(id);
    return { kind: "ready", prompt, contextPrompt };
  };
  return { eligible, prepare };
};

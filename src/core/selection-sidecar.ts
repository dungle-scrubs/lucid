import { readFile } from "node:fs/promises";
import { writeJsonFile } from "./atomic-json.ts";
import type { SessionPaths } from "./paths.ts";
import type { SelectionState } from "../protocol/wire.ts";

/**
 * The sticky selection sidecar: its types, its validator, and its reader/
 * writer (M1.9). This is core-owned - the sidecar path (`paths.selectionPath`)
 * is a core layout concern, and `viewer-state` (core) reads it - so the I/O
 * lives here rather than in `launch/selection.ts`, which is what created the
 * one core -> launch import this deletes.
 *
 * `launch/selection.ts` keeps the per-harness flag adapters
 * (`selectionArgs`/`insertSelectionArgs`/`applySelection`) - those depend on
 * the recipe and are launch-tier - and re-exports these for its callers.
 */

/** A human's model/effort pick. Absent (or "default") fields emit nothing. */
export interface Selection {
  readonly model?: string;
  readonly effort?: string;
}

/** The per-artifact sticky selection (`.lucid/<name>/selection.json`): the
 *  model/effort every later unattended turn reuses. `harness` records which
 *  vocabulary the pick was made in, so a resume under a different harness is
 *  detectable rather than silently misapplied. An alias of the wire
 *  `SelectionState` (M2.3): one type for the sticky pick, read by the sidecar
 *  and the wire alike. */
export type ArtifactSelection = SelectionState;

/** Bound + clean one selection field: a string with control chars stripped,
 *  trimmed, non-empty and not "default" (which means "no explicit pick"). */
export const cleanField = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const cleaned = [...value]
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return c > 0x1f && c !== 0x7f;
    })
    .join("")
    .trim()
    .slice(0, max);
  return cleaned.length > 0 && cleaned !== "default" ? cleaned : undefined;
};

/** The ONE selection normalizer, shared by every reader and writer (route
 *  bodies, the sidecar file), so a malformed field is dropped - bounded,
 *  control-free - no matter which surface it arrived through. Returns
 *  undefined when nothing usable remains. */
export const sanitizeSelection = (input: unknown): ArtifactSelection | undefined => {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  const harness = cleanField(o.harness, 64);
  const model = cleanField(o.model, 128);
  const effort = cleanField(o.effort, 32);
  if (!harness && !model && !effort) return undefined;
  return {
    ...(harness ? { harness } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
};

/** Read the artifact's sticky selection. Absent or unreadable = none: the
 *  sidecar is advisory, and a corrupt one must not stall delivery. */
export const readSelection = async (
  paths: SessionPaths,
): Promise<ArtifactSelection | undefined> => {
  try {
    return sanitizeSelection(JSON.parse(await readFile(paths.selectionPath, "utf8")));
  } catch {
    return undefined;
  }
};

/** Persist the artifact's sticky selection (whole-file overwrite; last write
 *  wins, like the other advisory sidecars). Normalized on the way OUT as well
 *  as in, so what is stored is exactly what `readSelection` gives back - an
 *  over-long harness name or model id that only got bounded on read would no
 *  longer match its own registry entry, and every later resume would reject
 *  the pick it just accepted. */
export const writeSelection = async (
  paths: SessionPaths,
  selection: ArtifactSelection,
): Promise<void> => {
  const clean = sanitizeSelection(selection) ?? {};
  await writeJsonFile(paths.selectionPath, clean);
};

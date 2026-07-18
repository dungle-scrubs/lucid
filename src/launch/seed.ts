import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Anchor } from "../anchors/anchor.ts";
import type { ForkRecord } from "../core/fold.ts";
import { pastedRelPath, type SessionPaths } from "../core/paths.ts";

/**
 * A fork's context, materialized as the markdown a spawned agent reads to start
 * the new artifact. A fork's whole context IS the selected region plus the
 * directive - not the parent conversation - so the seed is self-contained and
 * the child inherits nothing from the parent process. Written under the PARENT
 * session dir (`forks/<id>/seed.md`) so it travels with the review record.
 */

const regionText = (target: Anchor): string =>
  (target.kind === "range" ? target.quote.exact : target.snippet).trim();

/**
 * Collapse a fork id to a safe, non-empty path component. The server already
 * enforces a strict charset, but every filesystem use of a fork id passes
 * through here so a bad id can never escape the forks directory (defense in
 * depth against path traversal), and the full id is preserved so distinct
 * forks never collide onto one path.
 */
export const safeForkId = (forkId: string): string => {
  const cleaned = forkId.replace(/[^A-Za-z0-9_-]/g, "");
  return cleaned.length > 0 ? cleaned : "fork";
};

export interface SeededFork {
  readonly seedPath: string;
  readonly forkDir: string;
}

export const forkDirFor = (parent: SessionPaths, forkId: string): string =>
  join(parent.sessionDir, "forks", safeForkId(forkId));

export const writeForkSeed = async (
  parent: SessionPaths,
  fork: ForkRecord,
): Promise<SeededFork> => {
  const forkDir = forkDirFor(parent, fork.id);
  await mkdir(forkDir, { recursive: true });
  const images = (fork.images ?? []).map(
    (img) => `- ${img.name}: ${join(parent.sessionDir, pastedRelPath(img.file))}`,
  );
  const quoted = regionText(fork.target)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const body = [
    "# Fork seed",
    "",
    "A region of a Lucid review was spun off into this new artifact + session.",
    "",
    `**Directive:** ${fork.note}`,
    "",
    `**Source artifact:** ${parent.artifactPath} (v${fork.version})`,
    "",
    "**Selected region:**",
    "",
    quoted,
    ...(images.length > 0 ? ["", "**Attached images:**", ...images] : []),
    "",
  ].join("\n");
  const seedPath = join(forkDir, "seed.md");
  await writeFile(seedPath, body);
  return { seedPath, forkDir };
};

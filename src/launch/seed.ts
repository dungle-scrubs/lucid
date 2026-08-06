import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Anchor, anchorText } from "../anchors/anchor.ts";
import type { ForkRecord } from "../core/fold.ts";
import { pastedRelPath, type SessionPaths } from "../core/paths.ts";

/**
 * A fork's context, materialized as the markdown a spawned agent reads to start
 * the new artifact. A fork's whole context IS the selected region plus the
 * directive - not the parent conversation - so the seed is self-contained and
 * the child inherits nothing from the parent process. Written under the PARENT
 * session dir (`forks/<id>/seed.md`) so it travels with the review record.
 */

/** The region as the human saw it, block-shaped: the seed quotes it, so its
 *  own line breaks are structure the spawned agent reads. */
const regionText = (target: Anchor): string => anchorText(target, { keepLines: true });

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

export interface ForkPaths {
  /** The fork's own directory: `<sessionDir>/forks/<safe-id>/`. */
  readonly dir: string;
  /** `seed.md` inside the fork dir. */
  readonly seedPath: string;
  /** `COMMAND.txt` written when no spawn recipe exists. */
  readonly commandFile: string;
  /** The create turn's out-log, under the fork's own `run/`. */
  readonly createOutLog: string;
}

/** The shared parent of every fork dir for a session: `<sessionDir>/forks/`. */
export const forksDir = (parent: SessionPaths): string => join(parent.sessionDir, "forks");

/** The handled-set marker that sits beside the fork dirs (not inside one). */
export const handledForksPath = (parent: SessionPaths): string =>
  join(forksDir(parent), "handled.json");

/**
 * The on-disk layout of one fork (M1.1): a typed sub-layout rather than a bare
 * dir string, so the fork's paths (seed, command file, create out-log) are not
 * caller-spelled `join`s scattered across fork-launcher. `dir` is still the
 * sanitized path the traversal guard (`safeForkId`) produces.
 */
export const forkDirFor = (parent: SessionPaths, forkId: string): ForkPaths => {
  const dir = join(forksDir(parent), safeForkId(forkId));
  return {
    dir,
    seedPath: join(dir, "seed.md"),
    commandFile: join(dir, "COMMAND.txt"),
    createOutLog: join(dir, "run", "create.out.log"),
  };
};

export const writeForkSeed = async (parent: SessionPaths, fork: ForkRecord): Promise<ForkPaths> => {
  const fp = forkDirFor(parent, fork.id);
  await mkdir(fp.dir, { recursive: true });
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
  await writeFile(fp.seedPath, body);
  return fp;
};

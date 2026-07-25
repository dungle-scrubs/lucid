import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Development asset override (the `bun run dev` loop). Production servers
 * serve the bundles EMBEDDED in the binary (D-034) - offline, one artifact.
 * With `LUCID_DEV_ASSETS=<dir>` set, the same routes serve `<dir>/chrome.js`,
 * `chrome.css` and `client.js` fresh from disk on every request instead, so
 * a watcher rebuilding those files updates a running hub without a binary
 * rebuild or restart. Never set in normal use.
 */

export type DevAssetName = "chrome.js" | "chrome.css" | "client.js";

export const devAssetsDir = (): string | undefined => {
  const dir = process.env.LUCID_DEV_ASSETS;
  return dir && dir.length > 0 ? dir : undefined;
};

/** The asset's current bytes, or undefined when dev mode is off or the file
 *  is unreadable (callers fall back to the embedded copy). */
export const readDevAsset = async (name: DevAssetName): Promise<string | undefined> => {
  const dir = devAssetsDir();
  if (!dir) return undefined;
  try {
    return await readFile(join(dir, name), "utf8");
  } catch {
    return undefined;
  }
};

/** A stamp that changes when the dev bundle changes (chrome.js mtime), or
 *  undefined outside dev mode. The shell reloads itself when it moves. */
export const devBundleStamp = (): string | undefined => {
  const dir = devAssetsDir();
  if (!dir) return undefined;
  try {
    return String(statSync(join(dir, "chrome.js")).mtimeMs);
  } catch {
    return undefined;
  }
};

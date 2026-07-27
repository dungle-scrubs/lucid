import { Glob } from "bun";
import { stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { SessionSummary } from "../protocol/wire.ts";
import { discoverLiveServer, readServerDescriptor, viewerUrl } from "../server/discovery.ts";
import { readLastAttendant } from "./attendant.ts";
import { foldLog } from "./fold.ts";
import { readEvents } from "./log.ts";
import { sessionPaths } from "./paths.ts";
import type { SessionPaths } from "./paths.ts";

// The summary is wire contract (src/protocol/wire.ts); re-exported here so
// server-side callers keep importing it from the module that produces it.
export type { SessionSummary } from "../protocol/wire.ts";

export const projectRoot = async (paths: SessionPaths): Promise<string> => {
  let current = paths.artifactDir;
  while (true) {
    try {
      await stat(join(current, ".git"));
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return paths.artifactDir;
      current = parent;
    }
  }
};

export const listSessions = async (root: string): Promise<SessionSummary[]> => {
  const scanRoot = resolve(root);
  // Every log, in either layout: `<dir>/<stem>/log.ndjson` (a session folder
  // beside its artifact) and `<dir>/.lucid/<stem>/log.ndjson` (the old nested
  // container, until that session is next opened and moves forward).
  const glob = new Glob("**/log.ndjson");
  const sessions: SessionSummary[] = [];

  for await (const rel of glob.scan({ cwd: scanRoot, dot: true, onlyFiles: true })) {
    const parts = rel.split("/");
    const stem = parts.at(-2);
    if (stem === undefined) continue;
    // Drop the `.lucid` level when it is there, so both layouts resolve to the
    // same artifact directory.
    const dirParts = parts.slice(0, -2);
    const artifactDir = resolve(
      scanRoot,
      ...(dirParts.at(-1) === ".lucid" ? dirParts.slice(0, -1) : dirParts),
    );

    try {
      // The log the GLOB found, not the new-layout path recomputed from the
      // artifact dir: for a legacy `.lucid/<stem>/` row those differ, the
      // recomputed file does not exist, `readEvents` answers `{events: []}`
      // on ENOENT, and the fold's `none` dropped every legacy session from
      // the listing while its log sat right where the glob had seen it.
      const state = foldLog((await readEvents(resolve(scanRoot, rel))).events);
      if (state.status === "none") continue;

      const reconstructed = resolve(artifactDir, state.artifact || `${stem}.html`);
      const descriptor = await readServerDescriptor(sessionPaths(reconstructed));
      const artifactPath = descriptor?.session ?? reconstructed;
      const canonical = sessionPaths(artifactPath);
      // Independent reads, and the first can burn a full handshake timeout on
      // a stale descriptor - inside a per-session loop the shell polls, so
      // sequencing the attendant read behind it was pure addition.
      const [identity, attendant] = await Promise.all([
        discoverLiveServer(canonical),
        readLastAttendant(canonical),
      ]);

      sessions.push({
        session: artifactPath,
        name: basename(artifactPath),
        status: identity ? "active" : state.status === "active" ? "suspended" : state.status,
        version: state.version,
        segment: state.segment,
        annotations: state.annotations.length,
        live: identity !== undefined,
        ...(identity ? { viewer: viewerUrl(identity) } : { resume: `lucid open ${artifactPath}` }),
        ...(attendant
          ? {
              lastAttendant: {
                harness: attendant.harness,
                at: attendant.at,
                ...(attendant.resume ? { resume: attendant.resume } : {}),
                ...(attendant.model ? { model: attendant.model } : {}),
                ...(attendant.effort ? { effort: attendant.effort } : {}),
              },
            }
          : {}),
      });
    } catch {
      /* unreadable log: skip rather than fail the listing */
    }
  }

  return sessions.sort((left, right) => {
    if (left.live !== right.live) return left.live ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
};

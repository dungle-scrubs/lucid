import { Glob } from "bun";
import { basename, resolve } from "node:path";
import type { SessionSummary } from "../protocol/wire.ts";
import { discoverLiveServer, readServerDescriptor } from "../server/discovery.ts";
import { selectOpenUrl, type View } from "../server/view.ts";
import { artifactCheckout } from "./project.ts";
import { readLastAttendant } from "./attendant.ts";
import { foldLog } from "./fold.ts";
import { readEvents } from "./log.ts";
import { canonicalArtifactPath, sessionPaths } from "./paths.ts";
import type { SessionPaths } from "./paths.ts";

// The summary is wire contract (src/protocol/wire.ts); re-exported here so
// server-side callers keep importing it from the module that produces it.
export type { SessionSummary } from "../protocol/wire.ts";

/**
 * The project a session belongs to, as a scan root: the checkout the artifact
 * SITS in (`core/project.ts` owns the rule, including why `.lucid` is never a
 * project). A listing scans this folder, so a scratchpad artifact groups where
 * its own record is, not where its agent was working.
 */
export const projectRoot = async (paths: SessionPaths): Promise<string> => artifactCheckout(paths);

/**
 * @param view Which view the rows' `viewer` URLs are for. PASSED, never read
 * off `process.env` here: a long-lived server would then serve whichever view
 * the invocation that spawned it happened to carry, to every client that asks.
 * Over HTTP the subject is the REQUESTER, so the session host asks for `shell`;
 * `lucid` on a terminal is its own subject and passes what it resolved.
 */
export const listSessions = async (
  root: string,
  view: View = "shell",
): Promise<SessionSummary[]> => {
  const scanRoot = resolve(root);
  // Every record's `log.ndjson`: `<dir>/<stem>/log.ndjson`. In the canonical
  // layout that `<dir>` is a project's `.lucid/`, so the artifact sits beside
  // the record INSIDE `.lucid/` and the artifact dir is the record's own
  // parent - no `.lucid` stripping (plan 02, MB.2). The old nested layout,
  // where the artifact lived OUTSIDE `.lucid/`, is gone; the migration moves
  // such records to canonical.
  const glob = new Glob("**/log.ndjson");
  const sessions: SessionSummary[] = [];

  for await (const rel of glob.scan({ cwd: scanRoot, dot: true, onlyFiles: true })) {
    const parts = rel.split("/");
    const stem = parts.at(-2);
    if (stem === undefined) continue;
    const artifactDir = resolve(scanRoot, ...parts.slice(0, -2));

    try {
      // The log the GLOB found, not the new-layout path recomputed from the
      // artifact dir: for a legacy `.lucid/<stem>/` row those differ, the
      // recomputed file does not exist, `readEvents` answers `{events: []}`
      // on ENOENT, and the fold's `none` dropped every legacy session from
      // the listing while its log sat right where the glob had seen it.
      const state = foldLog((await readEvents(resolve(scanRoot, rel))).events);
      if (state.status === "none") continue;

      // CANONICAL, like every other identity surface (plan 05, M1.1): the scan
      // root is whatever spelling the roots file holds, and a listing row that
      // reported `/tmp/x.html` while the session's own server reported
      // `/private/tmp/x.html` gave the shell two keys for one session - the tab
      // it opened could never be found again.
      const reconstructed = canonicalArtifactPath(
        resolve(artifactDir, state.artifact || `${stem}.html`),
      );
      const descriptor = await readServerDescriptor(sessionPaths(reconstructed));
      const artifactPath = canonicalArtifactPath(descriptor?.session ?? reconstructed);
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
        // View-aware, exactly as `open`'s `url` is (plan 06): an integration
        // running in a chat app's pane lists sessions and surfaces `viewer`,
        // and handing it the shell URL there is the failure this plan exists
        // to remove - one emitter honouring the rule while another quietly
        // emits the thing it forbids.
        ...(identity
          ? { viewer: selectOpenUrl({ view, hubShell: undefined, identity }) }
          : { resume: `lucid open ${artifactPath}` }),
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

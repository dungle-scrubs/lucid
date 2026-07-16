import { Glob } from "bun";
import { stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { discoverLiveServer, readServerDescriptor } from "../server/discovery.ts";
import { readLastAttendant } from "./attendant.ts";
import { foldLog } from "./fold.ts";
import { readEvents } from "./log.ts";
import { sessionPaths } from "./paths.ts";
import type { SessionPaths } from "./paths.ts";

export interface SessionSummary {
  readonly session: string;
  readonly name: string;
  readonly status: "active" | "suspended" | "ended";
  readonly version: number;
  readonly segment: number;
  readonly annotations: number;
  readonly live: boolean;
  readonly viewer?: string;
  readonly resume?: string;
  readonly lastAttendant?: { harness: string; at: string; resume?: string };
}

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
  const glob = new Glob("**/.lucid/*/log.ndjson");
  const sessions: SessionSummary[] = [];

  for await (const rel of glob.scan({ cwd: scanRoot, dot: true, onlyFiles: true })) {
    const parts = rel.split("/");
    const idx = parts.lastIndexOf(".lucid");
    if (idx === -1 || parts[idx + 1] === undefined) continue;
    const artifactDir = resolve(scanRoot, ...parts.slice(0, idx));

    try {
      const stem = parts[idx + 1];
      const probe = sessionPaths(resolve(artifactDir, `${stem}.html`));
      const state = foldLog((await readEvents(probe.logPath)).events);
      if (state.status === "none") continue;

      const reconstructed = resolve(artifactDir, state.artifact || `${stem}.html`);
      const descriptor = await readServerDescriptor(sessionPaths(reconstructed));
      const artifactPath = descriptor?.session ?? reconstructed;
      const canonical = sessionPaths(artifactPath);
      const identity = await discoverLiveServer(canonical);
      const attendant = await readLastAttendant(canonical);

      sessions.push({
        session: artifactPath,
        name: basename(artifactPath),
        status: identity ? "active" : state.status === "active" ? "suspended" : state.status,
        version: state.version,
        segment: state.segment,
        annotations: state.annotations.length,
        live: identity !== undefined,
        ...(identity
          ? { viewer: `http://127.0.0.1:${identity.port}/__lucid/viewer` }
          : { resume: `lucid open ${artifactPath}` }),
        ...(attendant
          ? {
              lastAttendant: {
                harness: attendant.harness,
                at: attendant.at,
                ...(attendant.resume ? { resume: attendant.resume } : {}),
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

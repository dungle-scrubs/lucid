/**
 * Phase A of the portable-review-records migration: the record inventory.
 *
 * A READ-ONLY sweep. It finds every Lucid review record on this machine across
 * all three layouts, and emits one line per record with enough to prove the
 * migration lost nothing: the artifact, the layout, the record path, the event
 * count, and a hash of the log's bytes. Every later phase checks its result
 * against this file - discovery parity (the same records exist after the move)
 * and data integrity (the same log bytes) both read it.
 *
 * It moves nothing, opens no session, and writes only its own output file. The
 * freeze it declares (no `lucid open` on a legacy record until Phase B) is a
 * discipline this script cannot enforce - it can only give the baseline the
 * discipline protects.
 *
 * Usage:
 *   bun run scripts/inventory-lucid-records.ts --out <path> [--root <dir> ...]
 * Defaults: roots = defaultRoots() ∪ the registry's artifact dirs; out =
 *   .plans/02-portable-review-records/inventory-<hostname>.json
 */

import { createHash } from "node:crypto";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { defaultRoots, registryFilePath } from "../src/core/registry.ts";
import {
  ARTIFACT_EXTS,
  classifyLucidRecord,
  probeForLucidRecord,
  type RecordLayout,
} from "../src/core/inventory.ts";
import { findRecords } from "../src/core/records.ts";

interface RecordEntry {
  readonly artifact: string | null;
  readonly layout: RecordLayout;
  readonly recordPath: string;
  readonly eventCount: number;
  readonly logHash: string;
  /** True when the record lives under a volatile temp root (an agent
   *  scratchpad). Such records are NOT durable review history - the M5.5 work
   *  established `/tmp` as non-portable - so they are inventoried for
   *  completeness but excluded from the migration target (D-022). */
  readonly ephemeral: boolean;
}

/** The realpath'd temp root, so `/tmp/...` and `/private/tmp/...` (the same
 *  bytes via a macOS symlink) are recognised as one volatile place. Set once in
 *  `main` before any record is classified. */
let tmpReal = "";
const isEphemeral = (p: string): boolean => tmpReal !== "" && p.startsWith(tmpReal);

/** Which of a stem's candidate artifact files exist, as an absolute-path set. */
const existingArtifacts = async (candidates: readonly string[]): Promise<Set<string>> => {
  const found = new Set<string>();
  await Promise.all(
    candidates.map(async (p) => {
      try {
        if ((await stat(p)).isFile()) found.add(p);
      } catch {
        /* absent */
      }
    }),
  );
  return found;
};

/** The artifact basename the log itself records (session_opened stores it), a
 *  cross-check on the filesystem probe. Null if unreadable or absent. */
const artifactFromLog = (text: string): string | null => {
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const ev = JSON.parse(line) as { t?: string; artifact?: string };
      if (ev.t === "session_opened" && typeof ev.artifact === "string") return ev.artifact;
    } catch {
      /* torn line: keep scanning */
    }
  }
  return null;
};

const inventoryOne = async (logPath: string): Promise<RecordEntry> => {
  const recordDir = dirname(logPath); // <D>/(.lucid/)?<stem>
  const stem = basename(recordDir);
  const parent = dirname(recordDir);
  const underLucid = basename(parent) === ".lucid";

  let text = "";
  try {
    text = await readFile(logPath, "utf8");
  } catch {
    /* unreadable: reported with an empty hash and zero count below */
  }
  const eventCount = text.split("\n").filter((l) => l.trim() !== "").length;
  const logHash = createHash("sha256").update(text).digest("hex");

  let layout: RecordLayout;
  let artifact: string | null;
  if (underLucid) {
    const probe = probeForLucidRecord(logPath);
    const existing = await existingArtifacts([...probe.insideLucid, ...probe.besideRecord]);
    layout = classifyLucidRecord(probe, existing);
    artifact = [...probe.insideLucid, ...probe.besideRecord].find((p) => existing.has(p)) ?? null;
  } else {
    // No `.lucid` level: the record sits beside its artifact (the #50 sibling
    // layout) when the artifact file exists next to it.
    const candidates = ARTIFACT_EXTS.map((ext) => join(parent, `${stem}${ext}`));
    const existing = await existingArtifacts(candidates);
    artifact = candidates.find((p) => existing.has(p)) ?? null;
    layout = artifact ? "sibling" : "unknown";
  }

  // The log's own record of its artifact is advisory here (it stores a
  // basename, not a path); the filesystem is authoritative for WHERE the file
  // is. Keep the log's basename only when the filesystem found nothing.
  if (artifact === null) {
    const named = artifactFromLog(text);
    if (named) artifact = join(underLucid ? dirname(parent) : parent, named);
  }

  return {
    artifact,
    layout,
    recordPath: recordDir,
    eventCount,
    logHash,
    ephemeral: isEphemeral(recordDir),
  };
};

const parseArgs = (argv: string[]): { out: string; roots: string[] } => {
  const roots: string[] = [];
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = argv[++i];
    else if (argv[i] === "--root") {
      const r = argv[++i];
      if (r) roots.push(resolve(r));
    }
  }
  return {
    out:
      out ??
      join(
        "/Users/kevin/dev/lucid/.plans/02-portable-review-records",
        `inventory-${hostname().split(".")[0]}.json`,
      ),
    roots,
  };
};

/** The registry's artifact directories, so a record whose artifact sits outside
 *  every default root is still swept. */
const registryDirs = async (): Promise<string[]> => {
  try {
    const raw = await readFile(registryFilePath(), "utf8");
    const rows = JSON.parse(raw) as Array<{ artifact?: string }>;
    return [
      ...new Set(
        rows
          .map((r) => r.artifact)
          .filter((a): a is string => !!a)
          .map(dirname),
      ),
    ];
  } catch {
    return [];
  }
};

const main = async (): Promise<void> => {
  const { out, roots: explicit } = parseArgs(process.argv.slice(2));
  const roots =
    explicit.length > 0 ? explicit : [...new Set([...defaultRoots(), ...(await registryDirs())])];

  tmpReal = await realpath(tmpdir()).catch(() => tmpdir());

  // Dedup by the log's REAL path, so a record reachable through a symlinked
  // root (macOS `/tmp` -> `/private/tmp`) is inventoried exactly once. This is
  // the same realpath-identity that plan 05 (#41) gives sessions; here it keeps
  // the baseline count honest.
  const seen = new Set<string>();
  const records: RecordEntry[] = [];
  for (const root of roots) {
    for (const logPath of await findRecords([root])) {
      const real = await realpath(logPath).catch(() => logPath);
      if (seen.has(real)) continue;
      seen.add(real);
      records.push(await inventoryOne(real));
    }
  }
  records.sort((a, b) => a.recordPath.localeCompare(b.recordPath));

  const durable = records.filter((r) => !r.ephemeral);
  const countBy = (rs: RecordEntry[]): Record<string, number> =>
    rs.reduce<Record<string, number>>((acc, r) => {
      acc[r.layout] = (acc[r.layout] ?? 0) + 1;
      return acc;
    }, {});

  const payload = {
    machine: basename(out).replace(/^inventory-|\.json$/g, ""),
    scannedRoots: roots,
    recordCount: records.length,
    // The migration target: durable records only. Ephemeral scratchpad records
    // are counted separately so the baseline is complete but the discovery-
    // parity check does not depend on volatile temp dirs surviving.
    durableCount: durable.length,
    ephemeralCount: records.length - durable.length,
    byLayout: countBy(records),
    durableByLayout: countBy(durable),
    records,
  };
  await writeFile(out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`inventoried ${records.length} record(s) -> ${out}`);
  console.log(`  durable: ${durable.length} ${JSON.stringify(countBy(durable))}`);
  console.log(
    `  ephemeral (scratchpad, excluded from migration): ${records.length - durable.length}`,
  );
};

await main();

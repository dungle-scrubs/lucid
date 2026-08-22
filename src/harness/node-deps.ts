/**
 * The real hcn process: node's spawn behind the injected seam, plus the
 * binary resolution and the version floor.
 *
 * The binary is resolved in one place so a test, a CI run, and a developer's
 * shell all agree on which hcn ran, and the choice is logged. lucid depends
 * on the surface hcn shipped in HCN_MIN_VERSION; an older binary on PATH
 * fails loudly here rather than producing a stream lucid cannot read.
 */
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessDeps, HcnProcess, SpawnHcn } from "./process.js";
import { HarnessSpawnError, HarnessVersionError } from "./runner.js";
import { belowFloor, HCN_MIN_VERSION } from "./version.js";

/** LUCID_HCN, then the package-local bin, then PATH. */
export const resolveHcnBin = (): { bin: string; source: string } => {
  const fromEnv = process.env.LUCID_HCN;
  if (fromEnv !== undefined && fromEnv !== "") return { bin: fromEnv, source: "env" };
  const here = dirname(fileURLToPath(import.meta.url));
  const local = resolve(here, "..", "..", "node_modules", ".bin", "hcn");
  if (existsSync(local)) return { bin: local, source: "node_modules" };
  return { bin: "hcn", source: "path" };
};

/** Read `hcn --version` once and refuse a binary below the floor. */
export const assertHcnVersion = (bin: string): string => {
  const probe = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (probe.error !== undefined || probe.status !== 0) {
    throw new HarnessSpawnError(probe.error ?? `hcn --version exited ${probe.status}`);
  }
  const found = probe.stdout.trim();
  if (belowFloor(found)) {
    throw new HarnessVersionError(found, HCN_MIN_VERSION);
  }
  return found;
};

const toLines = (stream: NodeJS.ReadableStream | null): AsyncIterable<string> => ({
  async *[Symbol.asyncIterator]() {
    if (stream === null) return;
    for await (const chunk of stream) yield String(chunk);
  },
});

export const nodeSpawnHcn: SpawnHcn = (argv, opts): HcnProcess => {
  const [bin, ...args] = argv;
  if (bin === undefined) throw new HarnessSpawnError("empty argv");
  let child: ReturnType<typeof nodeSpawn>;
  try {
    child = nodeSpawn(bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    });
  } catch (cause) {
    throw new HarnessSpawnError(cause);
  }
  return {
    stdout: toLines(child.stdout),
    stderr: toLines(child.stderr),
    exited: new Promise<number | null>((res) => {
      child.on("close", (code) => res(code));
      child.on("error", () => res(null));
    }),
    write(line: string): void {
      child.stdin?.write(line);
    },
    endInput(): void {
      child.stdin?.end();
    },
    kill(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
      child.kill(signal);
    },
  };
};

/** Production deps: the resolved binary, version-checked, with the choice
 * recorded so evidence names which hcn actually ran. */
export const nodeHarnessDeps = (log?: (event: Record<string, unknown>) => void): HarnessDeps => {
  const { bin, source } = resolveHcnBin();
  const version = assertHcnVersion(bin);
  log?.({ event: "hcn_resolved", bin, source, version });
  return { spawn: nodeSpawnHcn, bin, ...(log === undefined ? {} : { log }) };
};

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
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { selfInvocation } from "../cli/invocation.js";
import type { HarnessDeps, HcnProcess, SpawnHcn } from "./process.js";
import { HarnessSpawnError, HarnessVersionError } from "./runner.js";
import { belowFloor, HCN_MIN_VERSION } from "./version.js";

/** Where to look, injected so both package-local branches are reachable in
 * a test. Production passes nothing. */
export interface HcnBinLookup {
  readonly env?: string;
  /** Stands in for this module's own directory. */
  readonly moduleDir?: string;
  readonly cwd?: string;
  readonly executablePath?: string;
}

/** LUCID_HCN, then the package-local bin, then PATH.
 *
 * The package-local bin is looked for twice, and the second look is the
 * one that matters for a built binary. `import.meta.url` inside a
 * `bun build --compile` executable points into the embedded filesystem, so
 * a path resolved from it names something that cannot exist and the lookup
 * falls straight through to PATH. `bun run build` is the documented
 * install, so the documented path was the one that silently picked up
 * whatever `hcn` happened to be on PATH — a stale global, in the case that
 * found this.
 *
 * Looking beside the current directory as well fixes it for the case that
 * matters: a built binary run from inside a checkout, which is what the
 * README tells you to do. */
export const resolveHcnBin = (opts: HcnBinLookup = {}): { bin: string; source: string } => {
  const env = opts.env ?? process.env.LUCID_HCN;
  if (env !== undefined && env !== "") return { bin: env, source: "env" };
  const here = opts.moduleDir ?? dirname(fileURLToPath(import.meta.url));
  // Resolve the installed dependency from this package, including npm hoisting.
  try {
    const manifest = createRequire(resolve(here, "lookup.cjs")).resolve(
      "@dungle-scrubs/harness-cli-normalizer/package.json",
    );
    const bin = resolve(dirname(manifest), "dist/cli.js");
    if (existsSync(bin)) return { bin, source: "package-dependency" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
  }
  const beside = resolve(here, "..", "..", "node_modules", ".bin", "hcn");
  if (existsSync(beside)) return { bin: beside, source: "node_modules" };
  const executable =
    opts.executablePath ??
    (import.meta.url.startsWith("file:///$bunfs/") ? process.execPath : undefined);
  if (executable) {
    const bin = resolve(dirname(executable), "..", "node_modules", ".bin", "hcn");
    if (existsSync(bin)) return { bin, source: "node_modules(executable)" };
  }
  const fromCwd = resolve(opts.cwd ?? process.cwd(), "node_modules", ".bin", "hcn");
  if (existsSync(fromCwd)) return { bin: fromCwd, source: "node_modules(cwd)" };
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
    throw new HarnessVersionError(found, HCN_MIN_VERSION, bin);
  }
  return found;
};

const toLines = (stream: NodeJS.ReadableStream | null): AsyncIterable<string> => ({
  async *[Symbol.asyncIterator]() {
    if (stream === null) return;
    for await (const chunk of stream) yield String(chunk);
  },
});

/** Kept separate so compiled routing can be checked without launching a child. */
export const hcnSupervisorInvocation = (argv: readonly string[]): readonly string[] => {
  return selfInvocation(["_hcn-supervise", ...argv]);
};

const spawnHcn = (
  argv: readonly string[],
  opts: { readonly cwd?: string },
  supervised: boolean,
): HcnProcess => {
  const supervisor = hcnSupervisorInvocation(argv);
  const [bin, ...args] = supervised ? supervisor : argv;
  if (bin === undefined) throw new HarnessSpawnError("empty argv");
  let child: ReturnType<typeof nodeSpawn>;
  try {
    child = nodeSpawn(bin, args, {
      stdio: supervised ? ["pipe", "pipe", "pipe", "ipc"] : ["pipe", "pipe", "pipe"],
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    });
  } catch (cause) {
    throw new HarnessSpawnError(cause);
  }
  if (supervised) {
    child.send("ready", () => {});
  }
  const inputError = new Promise<void>((resolve) => {
    child.stdin?.once("error", () => resolve());
  });
  return {
    inputError,
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
    disposeOutput(): void {
      child.stdout?.destroy();
      child.stderr?.destroy();
    },
    kill(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
      child.kill(signal);
    },
  };
};

export const nodeSpawnHcn: SpawnHcn = (argv, opts) => spawnHcn(argv, opts, false);

/** Production deps: the resolved binary, version-checked, with the choice
 * recorded so evidence names which hcn actually ran. */
export const nodeHarnessDeps = (log?: (event: Record<string, unknown>) => void): HarnessDeps => {
  const { bin, source } = resolveHcnBin();
  const version = assertHcnVersion(bin);
  log?.({ event: "hcn_resolved", bin, source, version });
  return {
    spawn: (argv, opts) => spawnHcn(argv, opts, true),
    bin,
    ...(log === undefined ? {} : { log }),
  };
};

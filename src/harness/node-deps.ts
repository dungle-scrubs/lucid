import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { selfInvocation } from "../cli/invocation.js";
import type { CompatibilityDiagnostic, HcnInstallation } from "./compatibility.js";
import type { HarnessDeps, HcnProcess, SpawnHcn } from "./process.js";
import { HarnessSpawnError } from "./runner.js";

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

function selectedInstallation(lookup: HcnBinLookup): {
  readonly bin: string;
  readonly installation: HcnInstallation;
} {
  const selected = resolveHcnBin(lookup);
  const path = isAbsolute(selected.bin)
    ? selected.bin
    : Bun.which(selected.bin, { cwd: lookup.cwd ?? process.cwd() });
  const bin = path ?? selected.bin;
  return {
    bin,
    installation: {
      lookupRoot:
        selected.source === "package-dependency"
          ? dirname(dirname(bin))
          : selected.source.startsWith("node_modules")
            ? dirname(dirname(dirname(bin)))
            : null,
      path,
      source: selected.source,
    },
  };
}

export interface HarnessStartup {
  readonly deps: HarnessDeps | null;
  readonly diagnostics: readonly CompatibilityDiagnostic[];
}

/** Resolve the executable without launching it. Operations report their own failures. */
export async function prepareNodeHarness(lookup: HcnBinLookup = {}): Promise<HarnessStartup> {
  return { deps: nodeHarnessDeps(undefined, lookup), diagnostics: [] };
}

export const nodeHarnessDeps = (
  log?: (event: Record<string, unknown>) => void,
  lookup: HcnBinLookup = {},
): HarnessDeps => {
  const { bin, installation } = selectedInstallation(lookup);
  log?.({ event: "hcn_resolved", bin, source: installation.source });
  return checkedDeps(bin, installation, log);
};

function checkedDeps(
  bin: string,
  installation: HcnInstallation,
  log?: (event: Record<string, unknown>) => void,
): HarnessDeps {
  return {
    installation,
    spawn: (argv, opts) => spawnHcn(argv, opts, true),
    bin,
    ...(log === undefined ? {} : { log }),
  };
}

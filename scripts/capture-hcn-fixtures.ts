/**
 * Capture real `hcn --json` stdout as fixtures for the harness seam's tests.
 *
 * The fixtures are evidence: recorded from the pinned hcn against a real
 * harness, committed, never hand-edited. A test that needs a sequence no
 * fixture shows composes it inline and says so.
 *
 * Usage: bun scripts/capture-hcn-fixtures.ts [--harness HARNESS] [--model MODEL] [--provider PROVIDER]
 * Writes test/fixtures/hcn/*.ndjson. Skips a capture whose harness binary is
 * absent rather than failing the run.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HCN = join(import.meta.dir, "..", "node_modules", ".bin", "hcn");
const OUT = join(import.meta.dir, "..", "test", "fixtures", "hcn");

const selection = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
  return value;
};
const harness = selection("--harness") ?? "claude";
const model = selection("--model");
const provider = selection("--provider");
const route = [
  ...(model === undefined ? [] : ["--model", model]),
  ...(provider === undefined ? [] : ["--provider", provider]),
];

const available = (bin: string): boolean =>
  spawnSync("command", ["-v", bin], { shell: true, encoding: "utf8" }).status === 0;

/** One-shot turn: `hcn run <h> --json "<prompt>"`. */
const captureRun = (name: string, args: string[]): Promise<void> =>
  new Promise((resolve) => {
    const child = spawn(HCN, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => {
      out += String(c);
    });
    child.on("close", () => {
      writeFileSync(join(OUT, `${name}.ndjson`), out);
      console.log(`${name}: ${out.trim().split("\n").length} lines`);
      resolve();
    });
  });

/** Session: write commands on stdin, record the whole stdout stream. */
const captureSession = (name: string, args: string[], commands: unknown[]): Promise<void> =>
  new Promise((resolve) => {
    const child = spawn(HCN, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => {
      out += String(c);
    });
    // Feed each command once the previous turn has closed, so the recording
    // shows real turn boundaries rather than everything queued at once.
    let sent = 0;
    const feed = () => {
      if (sent >= commands.length) {
        child.stdin.end();
        return;
      }
      child.stdin.write(`${JSON.stringify(commands[sent++])}\n`);
    };
    child.stdout.on("data", (c) => {
      for (const line of String(c).split("\n")) {
        if (line.includes('"kind":"done"')) feed();
      }
    });
    feed();
    child.on("close", () => {
      writeFileSync(join(OUT, `${name}.ndjson`), out);
      console.log(`${name}: ${out.trim().split("\n").length} lines`);
      resolve();
    });
  });

mkdirSync(OUT, { recursive: true });

// Refusals need no harness binary at all: hcn decides them before spawning.
await captureRun("session-refusal-no-session-mode", ["session", "codex", "--json"]);
await captureRun("inspect-capabilities-claude", ["inspect", "claude", "--capabilities"]);

if (!available(harness)) {
  console.log(`${harness} is not installed; skipped the live captures`);
  process.exit(0);
}

await captureRun("run-clean", [
  "run",
  harness,
  "--json",
  ...route,
  "--access",
  "read",
  "--timeout",
  "60",
  "Reply with exactly: ok",
]);

await captureSession(
  "session-two-turns",
  ["session", harness, "--json", ...route],
  [
    { op: "send", id: "in-1", text: "Reply with exactly: one" },
    { op: "send", id: "in-2", text: "Reply with exactly: two" },
    { op: "close" },
  ],
);

console.log("done");

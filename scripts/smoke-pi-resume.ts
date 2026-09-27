/**
 * Pi verify-after-open resume as its own lane (RFC 28 slice 2, RFC 35).
 *
 * A fresh Pi session answers once. Each case then resumes it through the
 * harness seam the managed path uses: hcn re-verifies the native settings
 * fingerprint, Pi loads Lucid's extension, and `classifyPiResume` applies
 * RFC 28's outcome table to the attestation and the event stream.
 *
 * - control: the bound session opens; the outcome is `verified`.
 * - raced (P1): a PATH shim moves the session file aside after hcn's
 *   checks and before Pi opens it, so Pi creates an empty session; the
 *   outcome is a proven refusal (`session-empty`, exit 3, no agent events).
 * - folder mismatch: the attempt expects another folder; a proven refusal.
 * - second extension: a raced resume with another extension whose `input`
 *   handler returns `continue`, loaded before and after Lucid's; the
 *   refusal still holds in both orders.
 *
 * Every case records the full list of hcn event kinds.
 *
 * Sessions go to a temporary flat store (PI_CODING_AGENT_SESSION_DIR); the
 * provider comes from the developer's Pi configuration.
 *
 * Run: bun scripts/smoke-pi-resume.ts [--provider lmstudio]
 *        [--model qwen3.6-35b-a3b-ud-mlx]
 * Evidence: artifacts/evidence/pi-resume.md
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEvent } from "../src/harness/events.js";
import { createHcnRunner } from "../src/harness/hcn-runner.js";
import { nodeHarnessDeps } from "../src/harness/node-deps.js";
import {
  classifyPiResume,
  isAgentEventKind,
  isNativeExit3,
  type PiResumeOutcome,
  piNativeTurn,
  preparePiVerification,
} from "../src/harness/pi-verification.js";
import type { NativeTurnOptions } from "../src/harness/runner.js";
import { EventKind } from "../src/protocol/events.js";

const flagValue = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
};
// pro's lmstudio route declares a 262144-token context. lmstudio-mini
// declares 65536 with an 8192-token output budget, and a resumed Pi prompt
// (about 61.6k input tokens) leaves it no room: it stops on `length`.
const PROVIDER = flagValue("--provider") ?? "lmstudio";
const MODEL = flagValue("--model") ?? "qwen3.6-35b-a3b-ud-mlx";

const lines: string[] = [];
const log = (s: string) => {
  console.log(s);
  lines.push(s);
};

const root = realpathSync(mkdtempSync(join(tmpdir(), "lucid-pi-resume-")));
const work = join(root, "work");
const elsewhere = join(root, "elsewhere");
const sessions = join(root, "sessions");
const aside = join(root, "aside");
for (const dir of [work, elsewhere, sessions, aside]) mkdirSync(dir);
// Set before the runner exists: hcn and Pi inherit the process environment.
process.env.PI_CODING_AGENT_SESSION_DIR = sessions;

// The P1 shim: hcn has already checked the store and the fingerprint when
// it spawns `pi`, so moving the file here races Pi's own open.
const realPi = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
const shimDir = join(root, "shim");
mkdirSync(shimDir);
writeFileSync(
  join(shimDir, "pi"),
  `#!/bin/sh\nif [ -n "$LUCID_SMOKE_RACE" ]; then mv "${sessions}"/*_"$LUCID_SMOKE_RACE".jsonl "${aside}/"; fi\nexec "${realPi}" "$@"\n`,
);
chmodSync(join(shimDir, "pi"), 0o755);
process.env.PATH = `${shimDir}:${process.env.PATH ?? ""}`;

// A second extension whose `input` handler lets every prompt through.
const passing = join(root, "passing.ts");
writeFileSync(
  passing,
  `export default function (pi) {\n  pi.on("input", async () => ({ action: "continue" }));\n}\n`,
);

const runner = createHcnRunner(nodeHarnessDeps());

interface Observed {
  readonly sessionId: string | undefined;
  readonly kinds: string[];
  readonly completed: boolean;
  readonly agentEvents: boolean;
  readonly nativeExit3: boolean;
  readonly text: string;
}

const drain = async (events: AsyncIterable<HarnessEvent>): Promise<Observed> => {
  const kinds: string[] = [];
  let failed = false;
  let done = false;
  let agentEvents = false;
  let nativeExit3 = false;
  let text = "";
  let sessionId: string | undefined;
  for await (const event of events) {
    const record = event as Readonly<Record<string, unknown>>;
    kinds.push(event.kind);
    // Control events carry no conversation text; their detail is evidence.
    if (event.kind === EventKind.error || event.kind === EventKind.failure)
      log(
        `  ${event.kind}: ${JSON.stringify({
          class: record.class,
          code: record.code,
          nativeExitCode: record.nativeExitCode,
          message: typeof record.message === "string" ? record.message.slice(0, 300) : undefined,
          terminal: record.terminal,
        })}`,
      );
    if (event.kind === EventKind.done) log(`  done: ${JSON.stringify(record)}`);
    if (event.kind === EventKind.identity && typeof record.sessionId === "string")
      sessionId = record.sessionId;
    if (event.kind === EventKind.failure) failed = true;
    if (event.kind === EventKind.done) done = true;
    if (event.kind === EventKind.message && typeof record.text === "string") text += record.text;
    if (isAgentEventKind(event.kind)) agentEvents = true;
    if (isNativeExit3(record)) nativeExit3 = true;
  }
  return { sessionId, kinds, completed: done && !failed, agentEvents, nativeExit3, text };
};

let sessionId = "";
let ok = true;

const resume = async (
  label: string,
  opts: {
    readonly expectedCwd?: string;
    readonly race?: boolean;
    readonly extensions?: (lucid: string) => readonly string[];
    readonly expect: PiResumeOutcome["kind"];
    readonly reason?: string;
  },
): Promise<void> => {
  log(`\n## ${label}`);
  const settings = await runner.inspectNativeContinuation?.({
    cwd: work,
    harness: "pi",
    resume: sessionId,
  });
  if (settings?.status !== "available" || settings.continuation !== "resume") {
    log(`FAIL: native settings ${JSON.stringify(settings)}`);
    ok = false;
    return;
  }
  log(`settings: ${settings.provider}/${settings.model}, thinking ${settings.effort}`);
  const verification = preparePiVerification({
    root,
    recordDir: join(root, "record"),
    launchId: crypto.randomUUID(),
    sessionId,
    workingDirectory: opts.expectedCwd ?? work,
  });
  const turn = piNativeTurn(verification, settings.fingerprint);
  const native: NativeTurnOptions = {
    ...turn,
    env: opts.race ? { ...turn.env, LUCID_SMOKE_RACE: sessionId } : turn.env,
    extensions: opts.extensions?.(verification.extensionPath) ?? turn.extensions,
  };
  log(
    `extensions: ${native.extensions.map((p) => (p === passing ? "passing" : "lucid")).join(", ")}`,
  );
  const observed = await drain(
    runner.streamTurn({
      harness: "pi",
      prompt: "Reply with the single word RESUMED.",
      resume: sessionId,
      cwd: work,
      turnId: crypto.randomUUID(),
      timeoutSeconds: 300,
      native,
    }),
  );
  const outcome = classifyPiResume(verification, observed);
  log(`kinds: ${observed.kinds.join(" ")}`);
  log(
    `completed ${observed.completed}, agent events ${observed.agentEvents}, exit 3 ${observed.nativeExit3}`,
  );
  log(`outcome: ${JSON.stringify(outcome)}`);
  const pass =
    outcome.kind === opts.expect &&
    (opts.reason === undefined || (outcome.kind === "refused" && outcome.reason === opts.reason));
  log(pass ? "PASS" : `FAIL: expected ${opts.expect}${opts.reason ? ` ${opts.reason}` : ""}`);
  if (!pass) ok = false;
  if (opts.race) execFileSync("sh", ["-c", `mv "${aside}"/*.jsonl "${sessions}/"`]);
};

const main = async (): Promise<void> => {
  log(`# pi resume - ${PROVIDER}/${MODEL}`);
  log(`root: ${root}`);

  log("\n## fresh");
  const fresh = await drain(
    runner.streamTurn({
      harness: "pi",
      prompt: "Reply with the single word READY.",
      provider: PROVIDER,
      model: MODEL,
      cwd: work,
      turnId: crypto.randomUUID(),
      timeoutSeconds: 300,
    }),
  );
  log(`kinds: ${fresh.kinds.join(" ")}`);
  sessionId = fresh.sessionId ?? "";
  log(`session: ${sessionId}`);
  if (!fresh.completed || sessionId === "") {
    log("FAIL: the fresh turn did not complete");
    ok = false;
  } else {
    await resume("control", { expect: "verified" });
    await resume("raced (P1)", { race: true, expect: "refused", reason: "session-empty" });
    await resume("folder mismatch", {
      expectedCwd: elsewhere,
      expect: "refused",
      reason: "folder-mismatch",
    });
    await resume("second extension, loaded first", {
      race: true,
      extensions: (lucid) => [passing, lucid],
      expect: "refused",
      reason: "session-empty",
    });
    await resume("second extension, loaded last", {
      race: true,
      extensions: (lucid) => [lucid, passing],
      expect: "refused",
      reason: "session-empty",
    });
  }

  log(`\nresult: ${ok ? "PASS" : "FAIL"}`);
  mkdirSync("artifacts/evidence", { recursive: true });
  writeFileSync("artifacts/evidence/pi-resume.md", `${lines.join("\n")}\n`);
  process.exit(ok ? 0 : 1);
};

await main();

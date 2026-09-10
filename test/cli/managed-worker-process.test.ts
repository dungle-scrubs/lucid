import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import { managedWorkerEnvironment } from "../../src/cli/managed-worker.js";

const SYNTHETIC_HCN_IDENTITY = "synthetic";

import { createConversationHost, viewSnapshot } from "../../src/store/conversation-host.js";
import { presenceHeld } from "../../src/store/presence.js";
import { replaceSettings } from "../../src/store/settings.js";
import { createConversationRecord } from "../../src/store/store.js";

function workerFixture(hang = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lucid-worker-process-")));
  const { paths } = createConversationRecord(root, "process", { workingDirectory: root });
  replaceSettings(paths.dir, "process", 0, {
    harness: "claude",
    model: "selected",
    effort: "high",
    profile: "headless-turn",
  });
  const host = createConversationHost(paths.dir, {
    now: Date.now,
    presence: () => false,
    executorLease: () => false,
    onEffect: () => {},
    onRecord: () => {},
  });
  host.acceptInput(
    { id: "accepted", text: "Synthetic process task", mode: "queue" },
    { managed: true },
  );
  host.close();
  const binary = join(root, "fake-hcn");
  const launches = join(root, "task-launches.ndjson");
  // Synthetic hcn protocol, not a recorded fixture. No model or network calls.
  writeFileSync(
    binary,
    `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';
const args=process.argv.slice(2); const get=(flag)=>args[args.indexOf(flag)+1];
const output=(value)=>console.log(JSON.stringify(value));
const executable={path:'/fake/native',version:'test'};
if(args.includes('--version')) console.log('${SYNTHETIC_HCN_IDENTITY}');
else if(args[0]==='inspect') {
 if(args.includes('--context')) { await Bun.stdin.text(); output({v:1,harness:'claude',mode:get('--mode'),verifiedAgainst:'test',executable,accounting:{status:'available',method:'native-context-estimate',model:'selected',inputLimitTokens:10000,contextWindowTokens:20000,totalTokens:1000}}); }
 else if(args.includes('--argv') || args.includes('--runtime')) output({v:1,argv:['/fake/native'],verifiedAgainst:'test',executable,resume:{status:'supported',reason:null}});
 else output({name:'claude',sessionMode:null,verifiedAgainst:'test',bin:'/fake/native'});
} else if(args[0]==='run') { const prompt=await Bun.stdin.text(); appendFileSync(${JSON.stringify(launches)},JSON.stringify({pid:process.pid,cwd:process.cwd(),args,prompt})+'\\n'); output({kind:'identity',sessionId:'native-process',authority:'harness-minted'}); output({kind:'message',role:'assistant',text:'Process answer'}); if (${hang}) await new Promise(()=>{}); else output({kind:'done',cause:'clean',exitCode:0}); }
else process.exit(2);
`,
  );
  chmodSync(binary, 0o700);
  const argv = [
    process.execPath,
    resolve(import.meta.dir, "../../src/cli/main.ts"),
    "_managed-worker",
    root,
    "process",
    "accepted",
  ];
  const env = {
    ...managedWorkerEnvironment(process.env, root),
    LUCID_HCN: binary,
    LUCID_HARNESS: "muse",
  };
  return { root, paths, argv, env, launches };
}

test("contender worker processes run one accepted task and exit without holding its lease", async () => {
  const { root, paths, argv, env, launches } = workerFixture();
  const children = Array.from({ length: 2 }, () =>
    Bun.spawn(argv, { env, stdout: "ignore", stderr: "pipe" }),
  );
  try {
    expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0]);
    const records = readFileSync(launches, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0].cwd).toBe(root);
    expect(records[0].args).toContain("claude");
    expect(records[0].args).toContain("selected");
    expect(records[0].prompt).toContain("Synthetic process task");
    expect(viewSnapshot(paths.dir).state.executions.accepted).toMatchObject({
      kind: "attempt-ended",
      attempt: 1,
      outcome: { kind: "completed" },
    });
    expect(presenceHeld(paths.dir)).toBe(false);
  } finally {
    for (const child of children) child.kill();
    await Promise.all(children.map((child) => child.exited));
    rmSync(root, { recursive: true, force: true });
  }
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("compiled background launch completes one task and all worker processes exit", async () => {
  const f = workerFixture();
  const budget = join(f.root, "process-budget");
  const binary = join(f.root, "compiled-worker");
  mkdirSync(budget);
  try {
    await Bun.build({
      compile: { autoloadBunfig: false, autoloadDotenv: false, outfile: binary },
      entrypoints: [resolve(import.meta.dir, "../helpers/compiled-worker.ts")],
      plugins: [tailwind],
      throw: true,
    });
    const child = Bun.spawn([binary, "launch-worker", f.root, "process", "accepted"], {
      env: { ...f.env, LUCID_TEST_PROCESS_BUDGET: budget },
      stderr: "pipe",
      stdout: "pipe",
      timeout: 5000,
    });
    expect(await child.exited).toBe(0);
    const pids = (): number[] =>
      readdirSync(budget).map((name) => Number(readFileSync(join(budget, name), "utf8")));
    for (let tick = 0; tick < 1000; tick++) {
      const execution = viewSnapshot(f.paths.dir).state.executions.accepted;
      if (execution?.kind === "attempt-ended" && pids().every((pid) => !alive(pid))) break;
      await Bun.sleep(10);
    }
    expect(viewSnapshot(f.paths.dir).state.executions.accepted).toMatchObject({
      kind: "attempt-ended",
      attempt: 1,
      outcome: { kind: "completed" },
    });
    expect(readFileSync(f.launches, "utf8").trim().split("\n")).toHaveLength(1);
    expect(presenceHeld(f.paths.dir)).toBe(false);
    expect(pids().length).toBeLessThan(16);
    expect(pids().every((pid) => !alive(pid))).toBe(true);
  } finally {
    for (const name of readdirSync(budget)) {
      const pid = Number(readFileSync(join(budget, name), "utf8"));
      if (alive(pid)) process.kill(pid, "SIGKILL");
    }
    rmSync(f.root, { force: true, recursive: true });
  }
}, 20000);

test("worker death terminates its child and leaves one uncertain attempt without replay", async () => {
  const f = workerFixture(true);
  const child = Bun.spawn(f.argv, { env: f.env, stdout: "ignore", stderr: "ignore" });
  let nativePid: number | undefined;
  try {
    for (let n = 0; n < 300; n++) {
      try {
        nativePid = JSON.parse(readFileSync(f.launches, "utf8").trim()).pid;
        break;
      } catch {
        await Bun.sleep(5);
      }
    }
    if (nativePid === undefined) throw new Error("Task did not launch");
    expect(alive(nativePid)).toBe(true);
    child.kill("SIGKILL");
    await child.exited;
    for (let n = 0; n < 100 && alive(nativePid); n++) await Bun.sleep(5);
    expect(alive(nativePid)).toBe(false);
    const successor = Bun.spawn(f.argv, { env: f.env, stdout: "ignore", stderr: "pipe" });
    const exit = await successor.exited;
    if (exit !== 0) throw new Error(await new Response(successor.stderr).text());
    expect(viewSnapshot(f.paths.dir).state.executions.accepted).toMatchObject({
      kind: "attempt-ended",
      attempt: 1,
      outcome: { kind: "uncertain" },
    });
    expect(readFileSync(f.launches, "utf8").trim().split("\n")).toHaveLength(1);
  } finally {
    child.kill();
    await child.exited;
    if (nativePid !== undefined && alive(nativePid)) process.kill(nativePid, "SIGKILL");
    rmSync(f.root, { recursive: true, force: true });
  }
});

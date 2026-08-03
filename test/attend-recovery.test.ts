import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeAttendantSidecar } from "../src/core/attendant.ts";
import type { LogEvent } from "../src/core/events.ts";
import { appendEvent, readEvents } from "../src/core/log.ts";
import { sessionPaths, type SessionPaths } from "../src/core/paths.ts";
import {
  resetPresenceCache,
  resetProcessLister,
  resetSessionCwdCache,
  setProcessLister,
} from "../src/core/presence.ts";
import { openSession } from "../src/core/session.ts";
import { createAttendant, resetSessionsInFlight, type Attendant } from "../src/server/attend.ts";
import { applyUnitEnv } from "./unit-env.ts";

/**
 * The delivery failures of 2026-08-03, each reproduced (see the PR for the
 * live timeline they come from):
 *
 * - a healthy `claude -p` turn writes NO stdout until it ends, so the stall
 *   watchdog measured 8 minutes of "silence" on a working turn and killed it
 *   (exit 143) - once seconds after the turn had already replied;
 * - a declared session id was never checked against the local store before
 *   entering `--resume` argv, so a bad one died as a two-word error;
 * - a hub restart orphaned an in-flight turn's working window, and the panel
 *   reported its ancient ack as live forever;
 * - two artifacts legitimately bound to ONE session raced concurrent resumes;
 * - three failures earned a five-minute pause announced with no diagnosis.
 */

const DOC =
  '<!doctype html><html><head><title>t</title></head><body><h1 data-lucid-id="h">Hello</h1></body></html>';

const elementTarget = {
  kind: "element" as const,
  lucidId: "h",
  fingerprint: "f",
  domPath: "h1",
  snippet: "Hello",
};

const SESS = "11111111-1111-4111-8111-111111111111";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const fileExists = (path: string): Promise<boolean> => Bun.file(path).exists();

describe("attend recovery", () => {
  let dir: string;
  let proj: string;
  let store: string;
  let transcriptDir: string;
  let transcript: string;
  let harnessesPath: string;
  let artifact: string;
  let paths: SessionPaths;
  const logs: string[] = [];
  const warns: { code: string; message: string }[] = [];
  const attendants: Attendant[] = [];

  beforeEach(async () => {
    logs.length = 0;
    warns.length = 0;
    dir = await mkdtemp(join(tmpdir(), "lucid-recovery-"));
    proj = join(dir, "tree", "proj");
    await mkdir(proj, { recursive: true });
    process.env.LUCID_ROOTS = join(dir, "roots.json");
    process.env.LUCID_CLAUDE_SESSIONS = join(dir, "claude-sessions");
    await mkdir(join(dir, "claude-sessions"), { recursive: true });
    // A real (test-local) claude projects store: pre-flight and the
    // transcript-as-activity signal both read it. The directory name is
    // deliberately NOT flattened-path-shaped, so cwd recovery falls back to
    // the recorded cwd and the store answers only existence questions.
    store = join(dir, "claude-projects");
    transcriptDir = join(store, "proj-store");
    await mkdir(transcriptDir, { recursive: true });
    transcript = join(transcriptDir, `${SESS}.jsonl`);
    process.env.LUCID_CLAUDE_PROJECTS = store;
    resetPresenceCache();
    resetSessionCwdCache();
    harnessesPath = join(dir, "harnesses.json");
    artifact = join(proj, "plan.html");
    await writeFile(artifact, DOC);
    paths = sessionPaths(artifact);
    await openSession(paths, {
      attendant: { harness: "claude-code", sessionId: SESS, cwd: paths.artifactDir },
    });
    await mergeAttendantSidecar(paths, {
      harness: "claude-code",
      sessionId: SESS,
      sessionIdAuthority: "declared",
      nextCursor: "evt_00001",
      at: new Date().toISOString(),
    });
  });

  afterEach(async () => {
    for (const a of attendants) a.stop();
    attendants.length = 0;
    applyUnitEnv();
    resetPresenceCache();
    resetSessionCwdCache();
    // Module-global state a failed test could leak into the next: a stuck
    // in-flight claim silences every later spawn, and a stubbed `ps` makes
    // presence lie for whatever runs afterwards.
    resetSessionsInFlight();
    resetProcessLister();
    await rm(dir, { recursive: true, force: true });
  });

  /** A registry whose "claude-code" resume argv runs the given bun script. */
  const writeRegistry = async (resumeScript: string): Promise<void> => {
    await writeFile(
      harnessesPath,
      JSON.stringify({
        default: "claude-code",
        harnesses: {
          "claude-code": {
            sessionIdentity: {
              source: "caller-assigned",
              argument: "--sid",
              resumeArgument: "--resume",
            },
            spawn: [process.execPath, "run", resumeScript, "--sid", "{id}", "{prompt}"],
            resume: [process.execPath, "run", resumeScript, "--resume", "{id}", "{prompt}"],
          },
        },
      }),
    );
  };

  const makeAttendant = (
    target: SessionPaths,
    opts: {
      stallIdleMs?: number;
      cooloffMs?: number;
      orphanMinAgeMs?: number;
      workingGraceMs?: number;
    } = {},
  ): Attendant => {
    const attendant = createAttendant({
      paths: target,
      agentsListening: () => 0,
      harnessesPath,
      debounceMs: 10,
      log: (m) => logs.push(m),
      warn: (code, message) => warns.push({ code, message }),
      ...opts,
    });
    attendants.push(attendant);
    return attendant;
  };

  const annotate = async (target: SessionPaths, note: string): Promise<LogEvent> =>
    appendEvent(target.logPath, {
      t: "annotation",
      id: crypto.randomUUID(),
      version: 1,
      target: elementTarget,
      note,
    });

  const tickUntil = async (
    attendant: Attendant,
    predicate: () => Promise<boolean> | boolean,
    timeoutMs: number,
  ): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await attendant.tick();
      if (await predicate()) return true;
      await sleep(40);
    }
    return predicate();
  };

  test("a buffered-stdout turn is judged by its transcript, not its silent out-log", async () => {
    // The stub behaves exactly like `claude -p` mid-turn: total stdout
    // silence while the session transcript grows on every step. The idle
    // window is far shorter than the run; only transcript activity can keep
    // this turn alive.
    await writeFile(transcript, "");
    const marker = join(dir, "marker.json");
    const stub = join(dir, "stub-buffered.ts");
    await writeFile(
      stub,
      `import { appendFileSync } from "node:fs";
for (let i = 0; i < 16; i += 1) {
  appendFileSync(${JSON.stringify(transcript)}, "tick\\n");
  await Bun.sleep(150);
}
await Bun.write(${JSON.stringify(marker)}, JSON.stringify({ done: true }));
`,
    );
    await writeRegistry(stub);
    await annotate(paths, "keep this turn alive");
    // 2s idle vs a 150ms write cadence: wide enough that a scheduling hiccup
    // cannot fail the test, short enough that the silent out-log (2.4s of
    // nothing) would still get the turn killed without the transcript signal.
    const attendant = makeAttendant(paths, { stallIdleMs: 2_000 });

    expect(await tickUntil(attendant, () => fileExists(marker), 12_000)).toBe(true);
    const events = (await readEvents(paths.logPath)).events;
    const ended = events.filter((e) => e.t === "agent_turn_ended").at(-1) as
      | { reason?: string }
      | undefined;
    expect(ended?.reason).toBe("done");
  }, 20_000);

  test("pre-flight refuses a resume whose session has no local transcript", async () => {
    // No transcript in the store: the declared id names a conversation this
    // machine does not hold. The old behavior was to spawn anyway and learn
    // it from a two-word "Execution error"; the engine must now refuse
    // before a process exists, and say why.
    const marker = join(dir, "marker.json");
    const stub = join(dir, "stub-never.ts");
    await writeFile(stub, `await Bun.write(${JSON.stringify(marker)}, "ran");\n`);
    await writeRegistry(stub);
    await annotate(paths, "this must not spawn");
    const attendant = makeAttendant(paths);

    await tickUntil(attendant, () => logs.some((l) => l.includes("pre-flight refused")), 3_000);
    // Give a wrongly-spawned stub time to run before asserting it never did.
    await sleep(400);
    expect(await fileExists(marker)).toBe(false);
    expect(logs.some((l) => l.includes("pre-flight refused"))).toBe(true);
    expect(
      warns.some(
        (w) =>
          w.code === "HARNESS_SESSION_UNAVAILABLE" && w.message.includes("no local transcript"),
      ),
    ).toBe(true);
  }, 15_000);

  test("an orphaned working window is closed on startup and its batch re-driven", async () => {
    // What a hub killed mid-turn leaves behind: an ack claiming the batch,
    // no terminator, no process. A fresh watcher must close the window (the
    // panel stops reporting an ancient ack as live), roll the claim back,
    // and deliver the batch - not wait out a ten-minute grace on a ghost.
    await writeFile(transcript, "");
    const marker = join(dir, "marker.json");
    const stub = join(dir, "stub-redrive.ts");
    await writeFile(
      stub,
      `await Bun.write(${JSON.stringify(marker)}, JSON.stringify({ ran: true }));\n`,
    );
    await writeRegistry(stub);
    const note = await annotate(paths, "orphaned batch");
    await appendEvent(paths.logPath, {
      t: "agent_ack",
      id: crypto.randomUUID(),
      covers: note.seq,
      turnId: "t-orphan",
      attendant: { harness: "claude-code", sessionId: SESS, cwd: paths.artifactDir },
    });
    const attendant = makeAttendant(paths, { orphanMinAgeMs: 0 });

    expect(await tickUntil(attendant, () => fileExists(marker), 10_000)).toBe(true);
    const events = (await readEvents(paths.logPath)).events;
    const orphaned = events.find(
      (e) => e.t === "agent_turn_ended" && (e as { turnId?: string }).turnId === "t-orphan",
    ) as { reason?: string; code?: string } | undefined;
    expect(orphaned?.reason).toBe("failed");
    expect(orphaned?.code).toBe("orphaned");
    expect(logs.some((l) => l.includes("orphaned by a restart"))).toBe(true);
  }, 20_000);

  test("two artifacts bound to one session never resume it concurrently", async () => {
    // An agent that splits one artifact into two legitimately declares its
    // session on both. Each half's attendant then wants a resume - and two
    // `--resume` processes on one session are two writers appending a single
    // transcript. The claim must serialize them; both batches still land.
    await writeFile(transcript, "");
    const trace = join(dir, "trace.log");
    const stub = join(dir, "stub-slow.ts");
    await writeFile(
      stub,
      `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(trace)}, \`S \${Date.now()}\\n\`);
await Bun.sleep(700);
appendFileSync(${JSON.stringify(trace)}, \`E \${Date.now()}\\n\`);
`,
    );
    await writeRegistry(stub);

    const other = join(proj, "sibling.html");
    await writeFile(other, DOC);
    const otherPaths = sessionPaths(other);
    await openSession(otherPaths, {
      attendant: { harness: "claude-code", sessionId: SESS, cwd: otherPaths.artifactDir },
    });
    await mergeAttendantSidecar(otherPaths, {
      harness: "claude-code",
      sessionId: SESS,
      sessionIdAuthority: "declared",
      nextCursor: "evt_00001",
      at: new Date().toISOString(),
    });
    await annotate(paths, "batch for the first half");
    await annotate(otherPaths, "batch for the second half");

    const a = makeAttendant(paths);
    const b = makeAttendant(otherPaths);
    const ranBoth = async (): Promise<boolean> =>
      (await readFile(trace, "utf8").catch(() => "")).split("\n").filter(Boolean).length >= 4;
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline && !(await ranBoth())) {
      await Promise.all([a.tick(), b.tick()]);
      await sleep(40);
    }
    expect(await ranBoth()).toBe(true);

    const lines = (await readFile(trace, "utf8")).split("\n").filter(Boolean);
    const spans: { start: number; end: number }[] = [];
    for (let i = 0; i < lines.length - 1; i += 2) {
      const start = Number((lines[i] as string).split(" ")[1]);
      const end = Number((lines[i + 1] as string).split(" ")[1]);
      expect((lines[i] as string).startsWith("S")).toBe(true);
      expect((lines[i + 1] as string).startsWith("E")).toBe(true);
      spans.push({ start, end });
    }
    // Runs strictly one after the other: any interleaving would put a second
    // "S" before the first "E", failing the pairing above - and the span
    // times must not overlap either.
    for (let i = 1; i < spans.length; i += 1) {
      expect((spans[i] as { start: number }).start).toBeGreaterThanOrEqual(
        (spans[i - 1] as { end: number }).end,
      );
    }
  }, 25_000);

  test("three failures pause with the harness's own last words, then retry after the cooloff", async () => {
    // The failure the human stared at for 101 minutes was announced as
    // "Delivery failed 3x and is paused" - no exit code, no output, no clue.
    // The warning must carry what the harness actually said, and the pause
    // must genuinely end: the cheap gate keeps evaluating a clocked batch,
    // so the next attempt follows the cooloff without any log change.
    await writeFile(transcript, "");
    const attempts = join(dir, "attempts.log");
    const stub = join(dir, "stub-fail.ts");
    await writeFile(
      stub,
      `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(attempts)}, "x\\n");
console.error("Execution error");
process.exit(1);
`,
    );
    await writeRegistry(stub);
    await annotate(paths, "doomed batch");
    const attendant = makeAttendant(paths, { cooloffMs: 500 });

    const attemptCount = async (): Promise<number> =>
      (await readFile(attempts, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
    expect(
      await tickUntil(
        attendant,
        () => warns.some((w) => w.code === "ATTEND_DELIVERY_FAILED"),
        10_000,
      ),
    ).toBe(true);
    expect(await attemptCount()).toBe(3);
    const failure = warns.find((w) => w.code === "ATTEND_DELIVERY_FAILED");
    expect(failure?.message).toContain("exit 1");
    expect(failure?.message).toContain("Execution error");

    // The pause ends and the SAME batch is retried - a fourth attempt.
    expect(await tickUntil(attendant, async () => (await attemptCount()) >= 4, 10_000)).toBe(true);
  }, 30_000);

  test("a resume killed for total silence retires the session for the batch, out loud", async () => {
    // Everything watchable exists and none of it moves: a genuinely wedged
    // harness process. The engine must not burn every retry on the same
    // doomed resume - and must not fall through silently either.
    await writeFile(transcript, "");
    const stub = join(dir, "stub-wedged.ts");
    await writeFile(stub, "await Bun.sleep(30_000);\n");
    await writeRegistry(stub);
    await annotate(paths, "wedged batch");
    const attendant = makeAttendant(paths, { stallIdleMs: 400 });

    expect(
      await tickUntil(
        attendant,
        () => logs.some((l) => l.includes("wrote nothing and was stopped")),
        10_000,
      ),
    ).toBe(true);
    expect(warns.some((w) => w.code === "ATTEND_RESUME_STALLED")).toBe(true);
  }, 20_000);

  test("an unreadable presence store closes nothing: absence is only evidence where presence would show", async () => {
    // On a machine with no ~/.claude/sessions at all, an empty presence map
    // means "cannot see", not "nothing is running". Closing windows on that
    // evidence would orphan LIVE turns and re-drive their batches.
    await rm(join(dir, "claude-sessions"), { recursive: true, force: true });
    await writeFile(transcript, "");
    const marker = join(dir, "marker.json");
    const stub = join(dir, "stub-blind.ts");
    await writeFile(stub, `await Bun.write(${JSON.stringify(marker)}, "ran");\n`);
    await writeRegistry(stub);
    const note = await annotate(paths, "held by a turn we cannot see");
    await appendEvent(paths.logPath, {
      t: "agent_ack",
      id: crypto.randomUUID(),
      covers: note.seq,
      turnId: "t-unseen",
      attendant: { harness: "claude-code", sessionId: SESS, cwd: paths.artifactDir },
    });
    const attendant = makeAttendant(paths, { orphanMinAgeMs: 0 });

    for (let i = 0; i < 5; i += 1) {
      await attendant.tick();
      await sleep(40);
    }
    const events = (await readEvents(paths.logPath)).events;
    expect(events.some((e) => e.t === "agent_turn_ended")).toBe(false);
    // And the working window still gates: nothing spawned over the held batch.
    expect(await fileExists(marker)).toBe(false);
  }, 15_000);

  test("the sweep closes only the dead turn; a live turn's claim and window survive it", async () => {
    // Two open turns at mount: one orphan, one alive (its process shows in
    // presence). Disowning ALL claims - not just the orphan's - made the live
    // turn's window stop gating, and the hub drove a second resume over the
    // batch that turn was mid-flight on.
    await writeFile(transcript, "");
    const liveSession = "22222222-2222-4222-8222-222222222222";
    const livePid = process.pid;
    // kind "print", not "interactive": a HEADLESS live turn. An interactive
    // one is blocked earlier by the human-at-a-keyboard guard, which would
    // mask the thing under test - that the live turn's CLAIM and window are
    // what keep the hub out after the sweep.
    await writeFile(
      join(dir, "claude-sessions", `${livePid}.json`),
      JSON.stringify({ pid: livePid, sessionId: liveSession, kind: "print" }),
    );
    // The pid is really alive (it is this test process); only the command
    // string the OS would report is substituted, so the liveness check sees
    // a claude process without this suite having to spawn one.
    setProcessLister(async () => `${livePid} claude --resume ${liveSession}\n`);
    const marker = join(dir, "marker.json");
    const stub = join(dir, "stub-second.ts");
    await writeFile(stub, `await Bun.write(${JSON.stringify(marker)}, "ran");\n`);
    await writeRegistry(stub);
    const a1 = await annotate(paths, "the orphan's batch");
    await appendEvent(paths.logPath, {
      t: "agent_ack",
      id: crypto.randomUUID(),
      covers: a1.seq,
      turnId: "t-dead",
      attendant: { harness: "claude-code", sessionId: SESS, cwd: paths.artifactDir },
    });
    const a2 = await annotate(paths, "the live turn's batch");
    await appendEvent(paths.logPath, {
      t: "agent_ack",
      id: crypto.randomUUID(),
      covers: a2.seq,
      turnId: "t-alive",
      attendant: { harness: "claude-code", sessionId: liveSession, cwd: paths.artifactDir },
    });
    const attendant = makeAttendant(paths, { orphanMinAgeMs: 0 });

    for (let i = 0; i < 6; i += 1) {
      await attendant.tick();
      await sleep(40);
    }
    const events = (await readEvents(paths.logPath)).events;
    const ended = events.filter((e) => e.t === "agent_turn_ended") as {
      turnId?: string;
      code?: string;
    }[];
    expect(ended.map((e) => e.turnId)).toEqual(["t-dead"]);
    expect(ended[0]?.code).toBe("orphaned");
    // The live turn still holds the artifact: no resume was driven under it.
    expect(await fileExists(marker)).toBe(false);
  }, 15_000);

  test("a pre-flight refusal expires with the cooloff instead of stranding the batch", async () => {
    // A single-candidate artifact never delivers, so its batch boundary never
    // moves - a rule-out only a delivery could clear would be permanent, and
    // a transient store miss would strand the feedback forever.
    const marker = join(dir, "marker.json");
    const stub = join(dir, "stub-late.ts");
    await writeFile(stub, `await Bun.write(${JSON.stringify(marker)}, "ran");\n`);
    await writeRegistry(stub);
    await annotate(paths, "the store catches up");
    const attendant = makeAttendant(paths, { cooloffMs: 250 });

    expect(
      await tickUntil(attendant, () => logs.some((l) => l.includes("pre-flight refused")), 5_000),
    ).toBe(true);
    // The conversation ARRIVES (a sync, a copied store, a first turn that
    // filed it) - and the expired verdict is re-tested rather than final.
    await writeFile(transcript, "");
    expect(await tickUntil(attendant, () => fileExists(marker), 10_000)).toBe(true);
  }, 20_000);

  test("a remounted attendant for the same artifact queues behind its predecessor's live child", async () => {
    // An idle-evicted mount stops its attendant but not the child it spawned.
    // The remount's fresh attendant must queue behind that child like any
    // other claimant - "same artifact" is not a licence for a second writer.
    await writeFile(transcript, "");
    const trace = join(dir, "trace.log");
    const stub = join(dir, "stub-slow2.ts");
    await writeFile(
      stub,
      `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(trace)}, \`S \${Date.now()}\\n\`);
await Bun.sleep(700);
appendFileSync(${JSON.stringify(trace)}, \`E \${Date.now()}\\n\`);
`,
    );
    await writeRegistry(stub);
    await annotate(paths, "first batch");

    const first = makeAttendant(paths);
    await first.tick();
    await sleep(30);
    const inFlight = first.tick(); // this pass spawns; ~700ms in flight
    await sleep(200);
    first.stop(); // the eviction: the attendant dies, its child does not

    await annotate(paths, "second batch, for the remount");
    // workingGraceMs 1: the predecessor's un-terminated ack must not gate the
    // remount for ten minutes - the CLAIM is what must serialize the spawn.
    const second = makeAttendant(paths, { workingGraceMs: 1, orphanMinAgeMs: 60_000 });
    const ranTwice = async (): Promise<boolean> =>
      (await readFile(trace, "utf8").catch(() => "")).split("\n").filter(Boolean).length >= 4;
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline && !(await ranTwice())) {
      await second.tick();
      await sleep(40);
    }
    await inFlight;
    expect(await ranTwice()).toBe(true);
    const lines = (await readFile(trace, "utf8")).split("\n").filter(Boolean);
    for (let i = 0; i < lines.length - 1; i += 2) {
      expect((lines[i] as string).startsWith("S")).toBe(true);
      expect((lines[i + 1] as string).startsWith("E")).toBe(true);
    }
  }, 25_000);
});

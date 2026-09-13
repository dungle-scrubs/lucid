import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { HarnessEvent } from "../../src/harness/events.js";
import { createHcnRunner } from "../../src/harness/hcn-runner.js";
import type { NativeApprovalChannel } from "../../src/harness/runner.js";
import { FakeHcnProcess, fakeSpawner } from "./fakes.js";

test("native continuation refuses an explicitly supplied empty model instead of discarding it", () => {
  const spawner = fakeSpawner([]);
  const runner = createHcnRunner({ bin: "/fake/hcn", spawn: spawner.spawn });
  expect(() =>
    runner.streamTurn({
      cwd: "/fixture",
      harness: "codex",
      model: "",
      prompt: "Synthetic prompt",
      resume: "207feafe-e82b-4df4-91ba-4f1aeb987508",
      turnId: "turn",
      nativeApprovals: {
        fingerprint: "a".repeat(64),
        connect: () => ({ closed: () => {}, event: () => {} }),
      },
    }),
  ).toThrow("without setting overrides");
  expect(spawner.calls).toEqual([]);
});

test("verified native approval transport keeps decisions on stdin and retires its owned channel after cleanup", async () => {
  const proc = new FakeHcnProcess();
  const spawner = fakeSpawner([proc]);
  const runner = createHcnRunner({ bin: "/fake/hcn", spawn: spawner.spawn });
  const connected = Promise.withResolvers<NativeApprovalChannel>();
  const requested = Promise.withResolvers<void>();
  const approvals: HarnessEvent[] = [];
  let closed = 0;
  const prompt = "Complete synthetic prompt\n<scope>ไทย</scope>";
  const stream = runner.streamTurn({
    cwd: "/fixture",
    harness: "codex",
    nativeApprovals: {
      fingerprint: "a".repeat(64),
      connect: (channel) => {
        connected.resolve(channel);
        return {
          event: (event) => {
            approvals.push(event);
            requested.resolve();
          },
          closed: () => {
            closed++;
          },
        };
      },
    },
    prompt,
    resume: "207feafe-e82b-4df4-91ba-4f1aeb987508",
    turnId: "lucid-turn",
  });
  const output = (async () => {
    const events: HarnessEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
  })();
  try {
    const argv = spawner.calls[0]?.argv ?? [];
    expect(argv).toContain("--native-approvals");
    expect(argv).toContain("--native-settings-fingerprint");
    expect(argv).not.toContain("--model");
    const path = argv[argv.indexOf("--prompt-file") + 1];
    if (!path) throw new Error("Missing native prompt file");
    expect(path).not.toBe("-");
    expect(readFileSync(path, "utf8")).toBe(prompt);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(proc.inputEnded).toBe(false);
    expect(proc.writes).toEqual([]);
    const channel = await connected.promise;
    // Synthetic normalized events, not a hand-written recording.
    proc.emit({
      v: 1,
      kind: "approval-request",
      requestId: "307feafe-e82b-4df4-91ba-4f1aeb987508",
      sessionId: "207feafe-e82b-4df4-91ba-4f1aeb987508",
      turnId: "native-turn",
      category: "command",
      details: "Command: echo fixture",
      choices: [{ id: "once", label: "Approve once", scope: "once" }],
    });
    await requested.promise;
    expect(proc.writes).toEqual([]);
    const decision = {
      id: "407feafe-e82b-4df4-91ba-4f1aeb987508",
      requestId: "307feafe-e82b-4df4-91ba-4f1aeb987508",
      choiceId: "once",
    };
    channel.answer(decision);
    expect(proc.commands).toEqual([{ ...decision, op: "approval", v: 1 }]);
    proc.emit({
      kind: "approval-disposition",
      v: 1,
      id: decision.id,
      requestId: decision.requestId,
      status: "sent",
    });
    proc.emit({ kind: "message", text: "Completed fixture" });
    proc.emit({ kind: "done", cause: "clean", exitCode: 0 });
    proc.exit(0);
    expect(await output).toEqual([
      { kind: "message", text: "Completed fixture" },
      { kind: "done", cause: "clean", exitCode: 0 },
    ]);
    expect(approvals.map((event) => event.kind)).toEqual([
      "approval-request",
      "approval-disposition",
    ]);
    expect(closed).toBe(1);
    expect(channel.alive()).toBe(false);
    expect(() => channel.answer(decision)).toThrow();
    expect(proc.commands).toHaveLength(1);
    expect(existsSync(path)).toBe(false);
  } finally {
    proc.exit(0);
    await output;
  }
});

test("a native turn iterable cannot start the same native session twice", async () => {
  const first = new FakeHcnProcess();
  const accidental = new FakeHcnProcess();
  const spawner = fakeSpawner([first, accidental]);
  const stream = createHcnRunner({ bin: "/fake/hcn", spawn: spawner.spawn }).streamTurn({
    cwd: "/fixture",
    harness: "codex",
    prompt: "Synthetic prompt",
    resume: "207feafe-e82b-4df4-91ba-4f1aeb987508",
    turnId: "one-turn",
    nativeApprovals: {
      fingerprint: "a".repeat(64),
      connect: () => ({ closed: () => {}, event: () => {} }),
    },
  });
  const read = stream[Symbol.asyncIterator]().next();
  const duplicate = stream[Symbol.asyncIterator]().next();
  void duplicate.catch(() => {});
  try {
    expect(spawner.calls).toHaveLength(1);
    await expect(duplicate).rejects.toThrow("already started");
  } finally {
    first.exit(0);
    accidental.exit(0);
    await Promise.allSettled([read, duplicate]);
  }
});

test("an expired dispatch callback cannot create an HCN process after its channel closes", async () => {
  const proc = new FakeHcnProcess();
  const spawner = fakeSpawner([proc]);
  const runner = createHcnRunner({ bin: "/fake/hcn", spawn: spawner.spawn });
  let savedInvoke: (() => undefined) | undefined;
  let closed = 0;
  proc.exit(0);
  const stream = runner.streamTurn({
    cwd: "/fixture",
    harness: "codex",
    prompt: "Keep this queued",
    resume: "native",
    turnId: "turn",
    nativeApprovals: {
      fingerprint: "a".repeat(64),
      connect: () => ({
        event: () => {},
        closed: () => {
          closed++;
        },
      }),
      dispatch: (invoke) => {
        savedInvoke = invoke;
      },
    },
  });
  await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow("not admitted");
  expect(closed).toBe(1);
  expect(savedInvoke).toBeDefined();
  expect(() => savedInvoke?.()).toThrow("canceled");
  expect(spawner.calls).toHaveLength(0);
});

test("refusing the attempt's channel prevents HCN process creation", async () => {
  const proc = new FakeHcnProcess();
  const spawner = fakeSpawner([proc]);
  const runner = createHcnRunner({ bin: "/fake/hcn", spawn: spawner.spawn });
  const stream = runner.streamTurn({
    cwd: "/fixture",
    harness: "codex",
    prompt: "Synthetic prompt",
    resume: "207feafe-e82b-4df4-91ba-4f1aeb987508",
    turnId: "turn",
    nativeApprovals: {
      fingerprint: "a".repeat(64),
      connect: () => {
        throw new Error("Attempt already owns a channel");
      },
    },
  });
  await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow("already owns a channel");
  expect(spawner.calls).toEqual([]);
});

test("a request admission failure keeps cleanup pending until the owned process actually exits", async () => {
  const killed = Promise.withResolvers<void>();
  const proc = new FakeHcnProcess();
  // The process seam reports both signals but deliberately withholds exit evidence.
  proc.kill = (signal = "SIGTERM") => {
    proc.signals.push(signal);
    if (signal === "SIGKILL") killed.resolve();
  };
  const spawner = fakeSpawner([proc]);
  const runner = createHcnRunner({ bin: "/fake/hcn", spawn: spawner.spawn, refusalGraceMs: 1 });
  let closed = false;
  let settled = false;
  const reading = runner
    .streamTurn({
      cwd: "/fixture",
      harness: "codex",
      prompt: "Synthetic prompt",
      resume: "207feafe-e82b-4df4-91ba-4f1aeb987508",
      turnId: "turn",
      nativeApprovals: {
        fingerprint: "a".repeat(64),
        connect: () => ({
          closed: () => {
            closed = true;
          },
          event: () => {
            throw new Error("Request admission refused");
          },
        }),
      },
    })
    [Symbol.asyncIterator]()
    .next();
  void reading.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  proc.emit({ v: 1, kind: "approval-request" });
  try {
    await killed.promise;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect(closed).toBe(false);
    proc.exit(null);
    await expect(reading).rejects.toThrow("Request admission refused");
    expect(closed).toBe(true);
  } finally {
    proc.exit(null);
    await reading.catch(() => {});
  }
});

test("process output preserves approval text when UTF-8 characters cross pipe chunks", async () => {
  const { nodeSpawnHcn } = await import("../../src/harness/node-deps.js");
  const child = nodeSpawnHcn(
    [
      process.execPath,
      "-e",
      'const bytes = Buffer.from("ไทย"); process.stdout.write(bytes.subarray(0, 2)); setTimeout(() => process.stdout.end(bytes.subarray(2)), 30);',
    ],
    {},
  );
  try {
    let output = "";
    for await (const chunk of child.stdout) output += chunk;
    expect(await child.exited).toBe(0);
    expect(output).toBe("ไทย");
  } finally {
    child.disposeOutput();
    child.kill();
  }
});

import { expect, test } from "bun:test";
import { createHcnRunner } from "../../src/harness/hcn-runner.js";
import type { InteractiveControlRecord, OpenInteractiveOptions } from "../../src/harness/runner.js";
import { FakeHcnProcess } from "./fakes.js";

function setup(proc = new FakeHcnProcess(), log?: (event: Record<string, unknown>) => void) {
  const calls: { argv: readonly string[]; cwd?: string }[] = [];
  const runner = createHcnRunner({
    bin: "/fake/hcn",
    log,
    refusalGraceMs: 1,
    spawn: () => {
      throw new Error("Native terminal launch must not use headless I/O");
    },
    spawnInteractive: (argv, options) => {
      calls.push({ argv, ...options });
      return {
        control: proc.stdout,
        exited: proc.exited,
        kill: (signal) => proc.kill(signal),
        disposeControl: () => proc.disposeOutput(),
      };
    },
  });
  const options: OpenInteractiveOptions = {
    cwd: "/tmp/native folder",
    harness: "codex",
    interface: "codex-cli",
    launchId: crypto.randomUUID(),
    resume: crypto.randomUUID(),
  };
  const open = (overrides: Partial<OpenInteractiveOptions> = {}) => {
    if (!runner.openInteractive) throw new Error("Missing native terminal operation");
    return runner.openInteractive({ ...options, ...overrides });
  };
  const record = (body: Record<string, unknown>) => ({
    v: 1,
    operation: "interactive",
    launchId: options.launchId,
    ...body,
  });
  const started = record({
    kind: "started",
    cwd: options.cwd,
    interface: options.interface,
    sessionId: options.resume,
    owner: { executable: "/native/codex", pid: 123, startedAt: "123:456" },
  });
  return { proc, calls, options, open, record, started };
}

test("native terminal launch uses a separate control stream and settles correlated cleanup", async () => {
  const { proc, calls, options, open } = setup();
  const { cwd, launchId, resume: sessionId } = options;
  const owner = { executable: "/native/codex", pid: 123, startedAt: "123:456" };
  const handle = open();
  const control = Array.fromAsync(handle.control);
  // Synthetic HCN control records, not captured native output.
  const records: InteractiveControlRecord[] = [
    { v: 1, operation: "interactive", launchId, kind: "ready" },
    {
      v: 1,
      operation: "interactive",
      launchId,
      kind: "started",
      sessionId,
      cwd,
      interface: "codex-cli",
      owner,
    },
    {
      v: 1,
      operation: "interactive",
      launchId,
      kind: "closed",
      cleanupComplete: true,
      exitCode: 0,
    },
  ];
  for (const record of records) proc.emit(record);
  proc.exit(0);
  expect(await control).toEqual(records);
  expect(await handle.settled).toEqual({ kind: "closed", cleanupComplete: true, exitCode: 0 });
  expect(calls).toEqual([
    {
      argv: [
        "/fake/hcn",
        "interactive",
        "codex",
        "--interface",
        "codex-cli",
        "--launch-id",
        launchId,
        "--resume",
        sessionId,
        "--cwd",
        cwd,
        "--control-fd",
        "3",
      ],
      cwd,
    },
  ]);
});

test("a failed diagnostic sink cannot interrupt native lifecycle evidence", async () => {
  const f = setup(new FakeHcnProcess(), () => {
    throw new Error("Diagnostic sink failed");
  });
  const handle = f.open();
  const reading = Array.fromAsync(handle.control);
  f.proc.emit(f.record({ kind: "ready" }));
  f.proc.emit(f.started);
  f.proc.emit(f.record({ kind: "closed", cleanupComplete: true, exitCode: 0 }));
  f.proc.exit(0);
  expect((await reading).map((record) => record.kind)).toEqual(["ready", "started", "closed"]);
  expect(await handle.settled).toEqual({ kind: "closed", cleanupComplete: true, exitCode: 0 });
});

test.each([
  "missing",
  "ready-only",
  "missing-close",
  "wrong-launch",
  "wrong-session",
  "wrong-folder",
  "wrong-interface",
  "missing-owner",
  "duplicate-ready",
  "closed-first",
  "refused-then-started",
  "cleanup-false",
  "truncated",
  "oversized",
] as const)("native control %s retains uncertainty", async (failure) => {
  const f = setup();
  const handle = f.open();
  const reading = Array.fromAsync(handle.control);
  const ready = f.record({ kind: "ready" });
  const closed = f.record({ kind: "closed", cleanupComplete: true, exitCode: 0 });
  const refused = f.record({
    kind: "refused",
    evidence: "spawn-not-attempted",
    reason: "resume-unavailable",
  });
  const records: unknown[] = [];
  if (failure === "ready-only") records.push(ready);
  else if (failure === "missing-close") records.push(ready, f.started);
  else if (failure === "wrong-launch") records.push({ ...ready, launchId: crypto.randomUUID() });
  else if (failure === "wrong-session")
    records.push(ready, { ...f.started, sessionId: crypto.randomUUID() });
  else if (failure === "wrong-folder") records.push(ready, { ...f.started, cwd: "/different" });
  else if (failure === "wrong-interface")
    records.push(ready, { ...f.started, interface: "codex-desktop" });
  else if (failure === "missing-owner") records.push(ready, { ...f.started, owner: undefined });
  else if (failure === "duplicate-ready") records.push(ready, ready);
  else if (failure === "closed-first") records.push(closed);
  else if (failure === "refused-then-started") records.push(refused, f.started);
  else if (failure === "cleanup-false")
    records.push(ready, f.started, { ...closed, cleanupComplete: false });
  for (const record of records) f.proc.emit(record);
  if (failure === "truncated") f.proc.stdoutChannel.push(JSON.stringify(refused));
  if (failure === "oversized") f.proc.stdoutChannel.push("x".repeat(16_385));
  f.proc.exit(0);
  await reading;
  expect(await handle.settled).toMatchObject({ kind: "uncertain" });
  expect(f.calls).toHaveLength(1);
});

test("native preflight refusal is final only after HCN exit", async () => {
  const f = setup();
  const handle = f.open();
  const iterator = handle.control[Symbol.asyncIterator]();
  f.proc.emit(
    f.record({ kind: "refused", evidence: "spawn-not-attempted", reason: "unsupported-interface" }),
  );
  expect((await iterator.next()).value).toMatchObject({ kind: "refused" });
  f.proc.stdoutChannel.close();
  let finished = false;
  const drained = iterator.next().then((value) => {
    finished = true;
    return value;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  f.proc.exit(2);
  await drained;
  expect(await handle.settled).toEqual({
    kind: "refused",
    evidence: "spawn-not-attempted",
    reason: "unsupported-interface",
  });
});

test("cancellation before reading and a retained invocation cannot create a native terminal", async () => {
  const cancelled = setup();
  const handle = cancelled.open();
  handle.cancel();
  expect(await handle.settled).toMatchObject({ kind: "refused", evidence: "dispatch-not-called" });
  expect(await Array.fromAsync(handle.control)).toEqual([]);
  expect(cancelled.calls).toHaveLength(0);
  const delayed = setup();
  let retained: (() => undefined) | undefined;
  const withheld = delayed.open({
    dispatch: (invoke) => {
      retained = invoke;
    },
  });
  expect(await Array.fromAsync(withheld.control)).toEqual([]);
  expect(await withheld.settled).toMatchObject({
    kind: "refused",
    evidence: "dispatch-not-called",
  });
  expect(() => retained?.()).toThrow();
  expect(delayed.calls).toHaveLength(0);
});

test("cancelling an invoked terminal waits for process exit and retains missing native cleanup evidence", async () => {
  const escalated = Promise.withResolvers<void>();
  class DelayedExit extends FakeHcnProcess {
    override kill(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
      this.signals.push(signal);
      if (signal === "SIGKILL") escalated.resolve();
    }
  }
  const f = setup(new DelayedExit());
  const handle = f.open();
  const iterator = handle.control[Symbol.asyncIterator]();
  f.proc.emit(f.record({ kind: "ready" }));
  f.proc.emit(f.started);
  await iterator.next();
  await iterator.next();
  let settled = false;
  void handle.settled.then(() => {
    settled = true;
  });
  const drained = iterator.next();
  handle.cancel();
  await escalated.promise;
  expect(settled).toBe(false);
  expect(f.proc.signals).toEqual(["SIGTERM", "SIGKILL"]);
  f.proc.exit(null);
  await drained;
  expect(await handle.settled).toMatchObject({ kind: "uncertain" });
  expect(f.calls).toHaveLength(1);
});

test("an undocumented native refusal cannot establish pre-start evidence", async () => {
  const f = setup();
  const handle = f.open();
  const reading = Array.fromAsync(handle.control);
  f.proc.emit(
    f.record({ kind: "refused", evidence: "spawn-not-attempted", reason: "unknown-refusal" }),
  );
  f.proc.exit(2);
  expect(await reading).toEqual([]);
  expect(await handle.settled).toMatchObject({ kind: "uncertain" });
});

test("split control records keep one reader and cannot start a second terminal", async () => {
  const f = setup();
  const handle = f.open();
  const reader = handle.control[Symbol.asyncIterator]();
  const ready = f.record({ kind: "ready" });
  const next = reader.next();
  const second = handle.control[Symbol.asyncIterator]();
  await expect(second.next()).rejects.toMatchObject({ name: "HarnessRefusal" });
  const wire = `${JSON.stringify(ready)}\n`;
  f.proc.stdoutChannel.push(wire.slice(0, 17));
  f.proc.stdoutChannel.push(wire.slice(17));
  expect((await next).value).toEqual(ready);
  f.proc.emit(f.started);
  f.proc.emit(f.record({ kind: "closed", cleanupComplete: true, exitCode: 0 }));
  f.proc.exit(0);
  expect((await reader.next()).value).toEqual(f.started);
  expect((await reader.next()).value).toMatchObject({ kind: "closed" });
  expect((await reader.next()).done).toBe(true);
  expect(await handle.settled).toMatchObject({ kind: "closed" });
  expect(f.calls).toHaveLength(1);
});

test("a synchronous terminal spawn exception retains possible creation", async () => {
  let calls = 0;
  const runner = createHcnRunner({
    bin: "/fake/hcn",
    spawn: () => {
      throw new Error("Wrong transport");
    },
    spawnInteractive: () => {
      calls++;
      throw new Error("Spawn returned no handle");
    },
  });
  const handle = runner.openInteractive?.(setup().options);
  if (!handle) throw new Error("Missing interactive transport");
  expect(await Array.fromAsync(handle.control)).toEqual([]);
  expect(await handle.settled).toMatchObject({ kind: "uncertain" });
  expect(calls).toBe(1);
});

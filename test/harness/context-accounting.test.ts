import { expect, test } from "bun:test";
import { createHcnRunner } from "../../src/harness/hcn-runner.js";
import { nodeSpawnHcn } from "../../src/harness/node-deps.js";
import { FakeHcnProcess, fakeSpawner } from "./fakes.js";

const request = {
  harness: "claude" as const,
  model: "claude-opus-5",
  effort: "high",
  profile: "headless-turn" as const,
  cwd: "/fixture",
  prompt: "Current artifact and request",
  resume: "native-1",
};
const response = {
  v: 1,
  harness: "claude",
  mode: "headless-turn",
  verifiedAgainst: "2.1.263",
  executable: { path: "/selected/claude", version: "2.1.263" },
  accounting: {
    status: "available",
    method: "native-context-estimate",
    model: "claude-opus-5",
    contextWindowTokens: 1000000,
    inputLimitTokens: 967000,
    totalTokens: 920000,
  },
};

test("context accounting uses hcn stdin and retains measured native occupancy", async () => {
  const child = new FakeHcnProcess();
  const spawn = fakeSpawner([child]);
  const runner = createHcnRunner({ bin: "/hcn", spawn: spawn.spawn });
  const result = runner.countContext(request);
  child.emit(response);
  child.exit(0);
  expect(await result).toEqual({
    status: "available",
    method: "native-context-estimate",
    model: "claude-opus-5",
    executable: { path: "/selected/claude", version: "2.1.263" },
    totalTokens: 920000,
    inputLimitTokens: 967000,
  });
  expect(spawn.calls[0]?.opts.cwd).toBe("/fixture");
  expect(spawn.calls[0]?.argv).toContain("--context");
  expect(spawn.calls[0]?.argv).toContain("--resume");
  expect(spawn.calls[0]?.argv).toContain("native-1");
  expect(spawn.calls[0]?.argv).toContain("--prompt-file");
  expect(spawn.calls[0]?.argv).not.toContain(request.prompt);
  expect(child.writes.join("")).toBe(request.prompt);
  expect(child.inputEnded).toBe(true);
});

test.each([
  { changed: { accounting: { status: "available", contextWindowTokens: 1000000 } } },
  { changed: { executable: { path: null, version: "2.1.263" } } },
  { changed: { accounting: { ...response.accounting, model: "different" } } },
  { changed: { accounting: { ...response.accounting, totalTokens: -1 } } },
])("incomplete or mismatched accounting stays unavailable", async ({ changed }) => {
  const child = new FakeHcnProcess();
  const runner = createHcnRunner({ bin: "/hcn", spawn: fakeSpawner([child]).spawn });
  const result = runner.countContext(request);
  child.emit({ ...response, ...changed });
  child.exit(0);
  expect((await result).status).toBe("unavailable");
});

test("an unavailable native budget carries a bounded reason, never a guessed window", async () => {
  const child = new FakeHcnProcess();
  const runner = createHcnRunner({ bin: "/hcn", spawn: fakeSpawner([child]).spawn });
  const result = runner.countContext(request);
  child.emit({ ...response, accounting: { status: "unavailable", reason: "auth" } });
  child.exit(0);
  expect(await result).toEqual({ status: "unavailable", reason: "auth" });
});

test.each(["auth", "limit", "native-exit"])(
  "a failed probe preserves its structured %s reason",
  async (reason) => {
    const child = new FakeHcnProcess();
    const runner = createHcnRunner({ bin: "/hcn", spawn: fakeSpawner([child]).spawn });
    const result = runner.countContext(request);
    child.emit({ ...response, accounting: { status: "unavailable", reason } });
    child.exit(1);
    expect(await result).toEqual({ status: "unavailable", reason });
  },
);

test("an observed model change has a distinct hold reason", async () => {
  const child = new FakeHcnProcess();
  const runner = createHcnRunner({ bin: "/hcn", spawn: fakeSpawner([child]).spawn });
  const result = runner.countContext(request);
  child.emit({ ...response, accounting: { ...response.accounting, model: "another-model" } });
  child.exit(0);
  expect(await result).toEqual({ status: "unavailable", reason: "model-divergence" });
});

test("a failed process cannot authorize dispatch with an available count", async () => {
  const child = new FakeHcnProcess();
  const runner = createHcnRunner({ bin: "/hcn", spawn: fakeSpawner([child]).spawn });
  const result = runner.countContext(request);
  child.emit(response);
  child.exit(1);
  expect(await result).toEqual({ status: "unavailable", reason: "accounting-refused" });
});

test("summary accounting requests the same isolated route and unmodified prompt", async () => {
  const child = new FakeHcnProcess();
  const spawn = fakeSpawner([child]);
  const runner = createHcnRunner({ bin: "/hcn", spawn: spawn.spawn });
  const result = runner.countContext({ ...request, resume: undefined, isolation: "tool-free" });
  child.emit(response);
  child.exit(0);
  expect((await result).status).toBe("available");
  expect(spawn.calls[0]?.argv).toContain("tool-free");
  expect(spawn.calls[0]?.argv).toContain("none");
  expect(spawn.calls[0]?.argv).not.toContain("--resume");
});

test("cancelling accounting stops its hcn process and preserves no dispatch result", async () => {
  const child = new FakeHcnProcess();
  const controller = new AbortController();
  const runner = createHcnRunner({ bin: "/hcn", spawn: fakeSpawner([child]).spawn });
  const result = runner.countContext({ ...request, signal: controller.signal });
  controller.abort();
  expect(await result).toEqual({ status: "unavailable", reason: "cancelled" });
  expect(child.signals).toEqual(["SIGTERM"]);
});

test("unbounded or silent inspection output is terminated", async () => {
  for (const reason of ["response-limit", "timeout"] as const) {
    const child = new FakeHcnProcess();
    const runner = createHcnRunner({
      bin: "/hcn",
      spawn: fakeSpawner([child]).spawn,
      accountingTimeoutMs: 10,
    });
    const result = runner.countContext(request);
    if (reason === "response-limit") child.emitRaw("x".repeat(70_000));
    expect(await result).toEqual({ status: "unavailable", reason });
    expect(child.signals).toEqual(["SIGTERM"]);
  }
});

test("accounting retains structured refusal issues without raw diagnostics", async () => {
  const child = new FakeHcnProcess();
  const logs: unknown[] = [];
  const runner = createHcnRunner({
    bin: "/hcn",
    spawn: fakeSpawner([child]).spawn,
    log: (event) => logs.push(event),
  });
  const result = runner.countContext(request);
  child.emit({
    kind: "failure",
    class: "rejected",
    issue: "unknown-effort",
    message: "raw diagnostic",
    retryable: false,
  });
  child.exit(2);
  expect(await result).toEqual({
    status: "unavailable",
    reason: "accounting-refused",
    issue: "unknown-effort",
  });
  expect(JSON.stringify(logs)).not.toContain("raw diagnostic");
  expect(logs).toHaveLength(2);
});

test("accounting escalates when hcn ignores termination", async () => {
  class ResistantProcess extends FakeHcnProcess {
    override kill(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
      if (signal === "SIGTERM") this.signals.push(signal);
      else super.kill(signal);
    }
  }
  const child = new ResistantProcess();
  const runner = createHcnRunner({
    bin: "/hcn",
    spawn: fakeSpawner([child]).spawn,
    accountingTimeoutMs: 1,
    refusalGraceMs: 1,
  });
  expect(await runner.countContext(request)).toEqual({ status: "unavailable", reason: "timeout" });
  expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
});

test("an early real process refusal handles broken stdin without crashing Lucid", async () => {
  const runner = createHcnRunner({ bin: "/usr/bin/false", spawn: nodeSpawnHcn });
  expect((await runner.countContext({ ...request, prompt: "x".repeat(1024 * 1024) })).status).toBe(
    "unavailable",
  );
});

import { expect, test } from "bun:test";
import { createHcnRunner } from "../../src/harness/hcn-runner.js";
import { FakeHcnProcess, fakeSpawner } from "./fakes.js";

test("native continuation reads uncached HCN settings for the exact session and folder", async () => {
  const first = new FakeHcnProcess();
  const changed = new FakeHcnProcess();
  const spawner = fakeSpawner([first, changed]);
  const runner = createHcnRunner({ bin: "/fake/hcn", spawn: spawner.spawn });
  const target = { harness: "codex", resume: "exact-native-id", cwd: "/exact/folder" } as const;
  const snapshot = {
    v: 1,
    status: "available",
    source: "codex-rollout-v1",
    harness: "codex",
    sessionId: target.resume,
    cwd: target.cwd,
    model: "native-model",
    effort: "high",
    provider: "native-provider",
    fingerprint: "a".repeat(64),
    permissions: {
      status: "recorded",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      filesystem: "read-only",
      network: "restricted",
    },
  };
  // Synthetic normalized HCN responses, not native transcripts or recordings.
  first.stdoutChannel.push(`${JSON.stringify(snapshot)}\n`);
  first.exit(0);
  expect(await runner.inspectNativeContinuation?.(target)).toEqual({
    status: "available",
    continuation: "native-approvals",
    model: snapshot.model,
    effort: snapshot.effort,
    provider: snapshot.provider,
    fingerprint: snapshot.fingerprint,
  });
  changed.stdoutChannel.push(`${JSON.stringify({ ...snapshot, sessionId: "another-session" })}\n`);
  changed.exit(0);
  expect(await runner.inspectNativeContinuation?.(target)).toMatchObject({ status: "unavailable" });
  expect(spawner.calls.map((call) => call.argv)).toEqual(
    Array.from({ length: 2 }, () => [
      "/fake/hcn",
      "inspect",
      "codex",
      "--native-settings",
      "--resume",
      target.resume,
      "--cwd",
      target.cwd,
      "--json",
    ]),
  );
  expect(first.writes).toEqual([]);
  expect(changed.writes).toEqual([]);
});

test.each([
  [
    "a Pi resume snapshot without permissions is accepted",
    { source: "pi-session-v1", continuation: "resume" },
    "available",
  ],
  [
    "a Codex snapshot that names the approval transport keeps its permission checks",
    { continuation: "native-approvals", permissions: undefined },
    "unavailable",
  ],
  [
    "a non-Codex snapshot without a continuation is refused",
    { source: "pi-session-v1", permissions: undefined },
    "unavailable",
  ],
  ["an unknown continuation is refused", { continuation: "teleport" }, "unavailable"],
] as const)("%s", async (_label, change, status) => {
  const proc = new FakeHcnProcess();
  const runner = createHcnRunner({ bin: "/fake/hcn", spawn: fakeSpawner([proc]).spawn });
  const target = { harness: "pi", resume: "exact-native-id", cwd: "/exact/folder" } as const;
  // Synthetic normalized HCN response, not a native transcript or recording.
  proc.stdoutChannel.push(
    `${JSON.stringify({
      v: 1,
      status: "available",
      source: "codex-rollout-v1",
      harness: "pi",
      sessionId: target.resume,
      cwd: target.cwd,
      model: "glm-5.3",
      effort: "high",
      provider: "zai",
      fingerprint: "b".repeat(64),
      ...change,
    })}\n`,
  );
  proc.exit(0);
  const settings = await runner.inspectNativeContinuation?.(target);
  expect(settings?.status).toBe(status);
  if (settings?.status === "available") expect(settings.continuation).toBe("resume");
});

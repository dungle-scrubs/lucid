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

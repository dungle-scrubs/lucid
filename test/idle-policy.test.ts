import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent } from "../src/core/log.ts";
import { sessionPaths, type SessionPaths } from "../src/core/paths.ts";
import { ensureSessionDirs, openSession } from "../src/core/session.ts";
import { createSessionHost } from "../src/server/session-host.ts";

/**
 * M3.2: the idle-suspend policy is one method on SessionHost (`startIdlePolicy`),
 * consumed by both owners - the per-session server (which self-suspends) and the
 * hub's mounts (which evict). Two inline `setInterval` copies used to restate
 * the poll/suspend/onSuspended shape; one owner keeps them from drifting.
 */

let dir: string;
let paths: SessionPaths;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "lucid-idle-")));
  paths = sessionPaths(join(dir, "plan.html"));
  await writeFile(
    paths.artifactPath,
    "<!doctype html><html><head><title>t</title></head><body></body></html>",
  );
  ensureSessionDirs(paths);
  await openSession(paths);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const host = () => createSessionHost(paths, { getPort: () => 0, onEnded: () => {} });

describe("M3.2: startIdlePolicy - the one idle-suspend owner", () => {
  test("a non-positive idleMs disables the policy (returns no timer)", () => {
    const h = host();
    expect(h.startIdlePolicy(0, () => {})).toBeUndefined();
    expect(h.startIdlePolicy(-1, () => {})).toBeUndefined();
    h.stop();
  });

  test("suspends and calls onSuspended once the session is idle past idleMs", async () => {
    const h = host();
    // Touch activity so lastActivityAt is now, then arm a short policy.
    await appendEvent(paths, {
      t: "annotation",
      id: "a",
      version: 1,
      target: { kind: "element", lucidId: "h", fingerprint: "f", domPath: "h1", snippet: "x" },
      note: "x",
    });
    let suspended = 0;
    // Like the real owners, onSuspended clears the timer - the policy fires
    // once, then the owner tears down.
    const ref: { timer: ReturnType<typeof setInterval> | undefined } = { timer: undefined };
    ref.timer = h.startIdlePolicy(40, () => {
      suspended += 1;
      if (ref.timer) clearInterval(ref.timer);
    });
    await new Promise((r) => setTimeout(r, 400));
    if (ref.timer) clearInterval(ref.timer);
    expect(suspended).toBe(1);
    h.stop();
  }, 5_000);

  test("the isActive gate prevents suspend (server.ts's stopped-gate semantics)", async () => {
    const h = host();
    await appendEvent(paths, {
      t: "annotation",
      id: "a",
      version: 1,
      target: { kind: "element", lucidId: "h", fingerprint: "f", domPath: "h1", snippet: "x" },
      note: "x",
    });
    let suspended = 0;
    const timer = h.startIdlePolicy(
      40,
      () => {
        suspended += 1;
      },
      () => false,
    );
    await new Promise((r) => setTimeout(r, 300));
    if (timer) clearInterval(timer);
    expect(suspended).toBe(0);
    h.stop();
  }, 5_000);
});

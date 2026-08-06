import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeAttendantSidecar, readAttendantSidecars } from "../src/core/attendant.ts";
import { foldLog } from "../src/core/fold.ts";
import { resetSessionCwdCache } from "../src/core/harness-store.ts";
import { sessionPaths, type SessionPaths } from "../src/core/paths.ts";
import { openSession } from "../src/core/session.ts";
import { resetPresenceCache } from "../src/core/presence.ts";
import {
  attendTarget,
  createVerdictCache,
  quarantineSession,
} from "../src/server/attend-candidates.ts";
import { applyUnitEnv } from "./unit-env.ts";

const DOC =
  '<!doctype html><html><head><title>t</title></head><body><h1 data-lucid-id="h">Hello</h1></body></html>';

describe("createVerdictCache", () => {
  test("an id ruled out is ruled out within the cooloff; an unruled id is not", () => {
    const t = 1000;
    const cache = createVerdictCache({ cooloffMs: 500, now: () => t });
    cache.advanceBatch(1);
    cache.ruleOut("s1");
    expect(cache.isRuledOut("s1")).toBe(true);
    expect(cache.isRuledOut("s2")).toBe(false);
  });

  test("a rule-out expires once the cooloff elapses (injectable clock)", () => {
    let t = 1000;
    const cache = createVerdictCache({ cooloffMs: 500, now: () => t });
    cache.advanceBatch(1);
    cache.ruleOut("s1");
    expect(cache.isRuledOut("s1")).toBe(true);
    t += 499;
    expect(cache.isRuledOut("s1")).toBe(true); // still inside the window
    t += 1; // cooloff elapsed exactly
    expect(cache.isRuledOut("s1")).toBe(false);
    // The expired entry is dropped on read, so a same-tick re-check stays false.
    expect(cache.isRuledOut("s1")).toBe(false);
  });

  test("advanceBatch resets verdicts when the batch boundary moves", () => {
    const t = 1000;
    const cache = createVerdictCache({ cooloffMs: 10_000, now: () => t });
    cache.advanceBatch(5);
    cache.ruleOut("s1");
    expect(cache.isRuledOut("s1")).toBe(true);
    cache.advanceBatch(10); // a delivery moved the boundary: new batch
    expect(cache.isRuledOut("s1")).toBe(false);
  });

  test("advanceBatch does NOT reset within the same batch boundary", () => {
    const t = 1000;
    const cache = createVerdictCache({ cooloffMs: 10_000, now: () => t });
    cache.advanceBatch(5);
    cache.ruleOut("s1");
    cache.advanceBatch(5); // same boundary: the batch is still in flight
    expect(cache.isRuledOut("s1")).toBe(true);
  });

  test("verdicts do not leak across batches and do not reset within one", () => {
    const t = 1000;
    const cache = createVerdictCache({ cooloffMs: 10_000, now: () => t });
    cache.advanceBatch(5);
    cache.ruleOut("s1");
    cache.advanceBatch(10); // new batch clears s1
    expect(cache.isRuledOut("s1")).toBe(false);
    cache.ruleOut("s2");
    expect(cache.isRuledOut("s1")).toBe(false); // s1 did not come back
    expect(cache.isRuledOut("s2")).toBe(true);
    cache.advanceBatch(10); // same batch retains s2
    expect(cache.isRuledOut("s2")).toBe(true);
  });

  test("advanceBatch from the initial boundary seeds the first batch without losing a rule-out", () => {
    const t = 1000;
    const cache = createVerdictCache({ cooloffMs: 10_000, now: () => t });
    // driveTurn always calls advanceBatch before reading; a rule-out made in
    // the just-opened batch must be visible, not wiped by a follow-up call.
    cache.advanceBatch(7);
    cache.ruleOut("s1");
    cache.advanceBatch(7);
    expect(cache.isRuledOut("s1")).toBe(true);
  });
});

describe("quarantineSession", () => {
  let dir: string;
  let paths: SessionPaths;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lucid-quarantine-"));
    process.env.LUCID_CLAUDE_SESSIONS = join(dir, "no-sessions");
    process.env.LUCID_CLAUDE_PROJECTS = join(dir, "no-projects");
    resetPresenceCache();
    resetSessionCwdCache();
    const artifact = join(dir, "plan.html");
    await writeFile(artifact, DOC);
    paths = sessionPaths(artifact);
    await openSession(paths);
  });

  afterEach(async () => {
    applyUnitEnv();
    resetPresenceCache();
    resetSessionCwdCache();
    await rm(dir, { recursive: true, force: true });
  });

  test("writes the durable invalidation AND retires the id in the cache", async () => {
    const cache = createVerdictCache({ cooloffMs: 10_000, now: () => 1000 });
    await quarantineSession(paths, "codex", "dead-1", cache);
    // Durable: the on-disk sidecar records the invalidation (survives restart).
    const sidecars = await readAttendantSidecars(paths);
    expect(sidecars.some((a) => (a.invalidatedSessionIds ?? []).includes("dead-1"))).toBe(true);
    // Local: the cache retires it for this batch.
    expect(cache.isRuledOut("dead-1")).toBe(true);
  });

  test("swallows a disk-write failure but still retires the id locally", async () => {
    // A quarantine that threw would strand feedback behind an unwritable
    // sidecar; the local rule-out must stand regardless of the disk result.
    const cache = createVerdictCache({ cooloffMs: 10_000, now: () => 1000 });
    await chmod(paths.runDir, 0o500); // read+execute only: writes fail with EACCES
    try {
      await expect(quarantineSession(paths, "codex", "dead-2", cache)).resolves.toBeUndefined();
    } finally {
      await chmod(paths.runDir, 0o700); // restore so afterEach can remove the tree
    }
    expect(cache.isRuledOut("dead-2")).toBe(true);
  });
});

describe("attendTarget", () => {
  let dir: string;
  let paths: SessionPaths;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lucid-target-"));
    process.env.LUCID_CLAUDE_SESSIONS = join(dir, "no-sessions");
    process.env.LUCID_CLAUDE_PROJECTS = join(dir, "no-projects");
    resetPresenceCache();
    resetSessionCwdCache();
    const artifact = join(dir, "plan.html");
    await writeFile(artifact, DOC);
    paths = sessionPaths(artifact);
    await openSession(paths);
  });

  afterEach(async () => {
    applyUnitEnv();
    resetPresenceCache();
    resetSessionCwdCache();
    await rm(dir, { recursive: true, force: true });
  });

  test("returns the best candidate and ONE distinct fallback of the same harness", async () => {
    // A sidecar is keyed by harness, so two ids of one harness reach the
    // ladder from DIFFERENT tiers: a tier-1 sidecar id (declared authority)
    // and a tier-3 id parsed from the sidecar's own `resume` command. The
    // stronger tier wins; the weaker is the single permitted fallback (D-004).
    const primary = "11111111-1111-4111-8111-111111111111";
    const fallback = "22222222-2222-4222-8222-222222222222";
    await mergeAttendantSidecar(paths, {
      harness: "codex",
      sessionId: primary,
      sessionIdAuthority: "declared",
      resume: `codex resume ${fallback}`,
      nextCursor: "evt_1",
      at: "2026-08-01T08:00:00.000Z",
    });
    const target = await attendTarget(paths, foldLog([]));
    expect(target?.harness).toBe("codex");
    expect(target?.sessionId).toBe(primary);
    expect(target?.fallback).toEqual({ harness: "codex", sessionId: fallback });
  });

  test("reports exhausted when every candidate is quarantined but a harness is recorded", async () => {
    // The one tier-1 candidate invalidates itself: nothing survives the trust
    // ladder, yet the sidecar still names the harness - the artifact is
    // attendable by a fresh handoff, but every recorded session is gone here.
    await mergeAttendantSidecar(paths, {
      harness: "codex",
      sessionId: "dead",
      sessionIdAuthority: "declared",
      nextCursor: "evt_1",
      at: "2026-08-01T08:00:00.000Z",
      invalidatedSessionIds: ["dead"],
    });
    const target = await attendTarget(paths, foldLog([]));
    expect(target?.harness).toBe("codex");
    expect(target?.sessionId).toBeUndefined();
    expect(target?.exhausted).toBe(true);
    expect(target?.fallback).toBeUndefined();
  });

  test("returns undefined when no harness is recorded at all", async () => {
    // A fresh artifact with no sidecar and no stamp: nothing to resume and no
    // harness to hand off to - the engine has no target.
    const target = await attendTarget(paths, foldLog([]));
    expect(target).toBeUndefined();
  });
});

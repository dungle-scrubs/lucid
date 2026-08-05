import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "../src/core/session.ts";
import { sessionPaths, type SessionPaths } from "../src/core/paths.ts";
import { createSessionHost } from "../src/server/session-host.ts";
import type { ErrorIdentity, RequestContext, RequestObservation } from "../src/server/observe.ts";

/**
 * handle's observation parameter (plan 05, M3.3 / DF-1c): the host attaches the
 * artifact and records typed guard refusals via observation.fail - never
 * observation.end, whose lifecycle stays with observeRequests. An unrecorded
 * refusal is the anonymity the feature removes (D-012).
 */

const DOC = "<!doctype html><html><head></head><body><p id='a'>a</p></body></html>";

/** A recording observation: every attach/fail/end is captured for assertion. */
const recording = (): RequestObservation & {
  readonly attached: RequestContext[];
  readonly failed: ErrorIdentity[];
  readonly ended: number[];
} => {
  const attached: RequestContext[] = [];
  const failed: ErrorIdentity[] = [];
  const ended: number[] = [];
  return {
    id: "test-id",
    trace: "test-trace",
    attach: (ctx) => {
      attached.push(ctx);
    },
    fail: (e) => {
      failed.push(e);
    },
    end: (s) => {
      ended.push(s);
    },
    attached,
    failed,
    ended,
  };
};

describe("handle(req, pathname, observation) (M3.3 / DF-1c)", () => {
  let dir: string;
  let paths: SessionPaths;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lucid-obs-"));
    const artifact = join(dir, "plan.html");
    await writeFile(artifact, DOC);
    paths = sessionPaths(artifact);
    await mkdir(paths.runDir, { recursive: true });
    await openSession(paths);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const host = (): ReturnType<typeof createSessionHost> =>
    createSessionHost(paths, { getPort: () => 0, onEnded: () => {} });

  test("attaches the artifact on a normal request, never calls end", async () => {
    const h = host();
    const obs = recording();
    try {
      await h.handle(
        new Request("http://127.0.0.1/__lucid/identity", { headers: { host: "127.0.0.1" } }),
        undefined,
        obs,
      );
      // The artifact identity is attached so the record carries it.
      expect(obs.attached.some((c) => c.artifact === paths.artifactPath)).toBe(true);
      // handle never owns the exit record.
      expect(obs.ended).toEqual([]);
    } finally {
      h.stop();
    }
  });

  test("a header-guard refusal is recorded via fail, never end", async () => {
    const h = host();
    const obs = recording();
    try {
      const res = await h.handle(
        new Request("http://evil.example/__lucid/identity", {
          headers: { host: "evil.example" },
        }),
        undefined,
        obs,
      );
      expect(res.status).toBe(403);
      expect(obs.failed).toHaveLength(1);
      expect(obs.failed[0]?.code).toBe("FORBIDDEN");
      expect(obs.ended).toEqual([]);
    } finally {
      h.stop();
    }
  });

  test("a decode refusal is recorded via fail, never end", async () => {
    const h = host();
    const obs = recording();
    try {
      const res = await h.handle(
        new Request("http://127.0.0.1/__lucid/annotation", {
          method: "POST",
          headers: { host: "127.0.0.1", "content-type": "application/json" },
          body: "not-a-valid-annotation",
        }),
        undefined,
        obs,
      );
      expect(res.status).toBe(400);
      expect(obs.failed).toHaveLength(1);
      expect(obs.failed[0]).toEqual({ _tag: "ValidationError", code: "VALIDATION_ERROR" });
      expect(obs.ended).toEqual([]);
    } finally {
      h.stop();
    }
  });

  test("without an observation, handle works exactly as before", async () => {
    const h = host();
    try {
      const res = await h.handle(
        new Request("http://127.0.0.1/__lucid/identity", { headers: { host: "127.0.0.1" } }),
      );
      expect(res.status).toBe(200);
    } finally {
      h.stop();
    }
  });
});

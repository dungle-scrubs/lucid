import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionPaths, type SessionPaths } from "../src/core/paths.ts";
import { ensureSessionDirs, openSession } from "../src/core/session.ts";
import { readServerDescriptor } from "../src/server/discovery.ts";
import { runServer } from "../src/server/server.ts";

/**
 * M3.1 refusal contract (D-007). Captured FIRST against the live dispatcher,
 * then frozen: the route->decoder table refactor must reproduce every
 * status/body byte-for-byte. Any divergence is a ledger amendment via a
 * recorded decision, never a silent change. This file is the observability
 * fence for refusal identity.
 *
 * The capture revealed: each body-parsing route refuses bad JSON and malformed
 * bodies with its OWN "invalid X" message; four action routes (resolve/clear/
 * reopen/end) ignore the body entirely and succeed; a wrong-method (GET) probe
 * falls to the security gate's 403, not a 404; and there is no separate
 * body-size cap - a large payload reaches the decoder and is refused on its
 * merits.
 */

let dir: string;
let paths: SessionPaths;
let serverDone: Promise<void> | undefined;
let port = 0;

const DOC =
  '<!doctype html><html><head><title>t</title></head><body><h1 data-lucid-id="h">Hello</h1></body></html>';

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "lucid-refusal-")));
  paths = sessionPaths(join(dir, "plan.html"));
  await writeFile(paths.artifactPath, DOC);
  ensureSessionDirs(paths);
  await openSession(paths);
  serverDone = runServer(paths, [0], { idleMs: 0 });
  for (let i = 0; i < 100; i++) {
    const d = await readServerDescriptor(paths);
    if (d) {
      port = d.port;
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("server did not start");
});

afterEach(async () => {
  await fetch(`http://127.0.0.1:${port}/__lucid/end`, {
    method: "POST",
    headers: { host: `127.0.0.1:${port}` },
  }).catch(() => {});
  await serverDone?.catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

const HOST = (): Record<string, string> => ({ host: `127.0.0.1:${port}` });

const postJson = async (
  route: string,
  body: unknown,
): Promise<{ status: number; text: string }> => {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: { ...HOST(), "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
};

const get = async (route: string): Promise<number> => {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, { headers: HOST() });
  return res.status;
};

// Body-parsing routes: bad JSON yields a per-route 400 with the captured message.
const BAD_JSON: Record<string, string> = {
  "/__lucid/annotation": "invalid annotation",
  "/__lucid/fork": "invalid fork",
  "/__lucid/message": "invalid message",
  "/__lucid/revert": "invalid revert",
  "/__lucid/rename": "invalid title",
  "/__lucid/question": "invalid question",
  "/__lucid/answer": "invalid answer",
  "/__lucid/reply": "invalid reply",
  "/__lucid/ack": "invalid ack",
  "/__lucid/turn-ended": "invalid turnId",
  "/__lucid/bind": "invalid binding",
  "/__lucid/context": "invalid context",
};
// A malformed-but-valid {} body: fork and bind have a field-specific message.
const MALFORMED: Record<string, string> = {
  ...BAD_JSON,
  "/__lucid/fork": "invalid fork id",
  "/__lucid/bind": "invalid launchId",
};
const ACTION_ROUTES = ["/__lucid/resolve", "/__lucid/clear", "/__lucid/reopen"];

describe("M3.1 refusal contract (frozen capture)", () => {
  test("bad JSON is refused per-route with the captured message", async () => {
    for (const [route, message] of Object.entries(BAD_JSON)) {
      const res = await postJson(route, "{ not json");
      expect({ route, status: res.status, text: res.text }).toEqual({
        route,
        status: 400,
        text: JSON.stringify({ error: message }),
      });
    }
  });

  test("action routes ignore the body (bad JSON still succeeds)", async () => {
    for (const route of ACTION_ROUTES) {
      const res = await postJson(route, "{ not json");
      expect({ route, status: res.status, text: res.text }).toEqual({
        route,
        status: 200,
        text: JSON.stringify({ ok: true }),
      });
    }
  });

  test("a wrong-method GET probe falls to the security gate (403)", async () => {
    for (const route of [...Object.keys(BAD_JSON), ...ACTION_ROUTES]) {
      expect(await get(route)).toBe(403);
    }
  });

  test("no separate size cap: a large invalid body reaches the decoder", async () => {
    // The capture found no body-size cap. A huge INVALID JSON (a parse error)
    // is refused identically to a small one - same per-route message.
    const hugeInvalid = `{ ${": ".repeat(500_000)}`;
    for (const [route, message] of Object.entries(BAD_JSON)) {
      const res = await postJson(route, hugeInvalid);
      expect(res.status).toBe(400);
      expect(res.text).toBe(JSON.stringify({ error: message }));
    }
  });

  test("a malformed {} body is refused with the captured per-route message", async () => {
    for (const [route, message] of Object.entries(MALFORMED)) {
      const res = await postJson(route, {});
      expect({ route, status: res.status, text: res.text }).toEqual({
        route,
        status: 400,
        text: JSON.stringify({ error: message }),
      });
    }
  });
});

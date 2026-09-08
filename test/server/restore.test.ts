/**
 * Going back to how a document was.
 *
 * Every version is in the record and none of them could be made current
 * again. Restoring appends a copy of an older version at the end of the list.
 *
 * The property that makes it safe is the one worth holding shut: nothing is
 * removed, rewritten, or hidden. The version a restore replaced is still
 * there and still readable afterwards, which is why undoing a restore is the
 * same act again rather than a window that closes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServe } from "../../src/cli/serve.js";
import { createConversationHost } from "../../src/store/conversation-host.js";
import { createConversationRecord } from "../../src/store/store.js";

const CONV = "restore-1";
const ART = "checklist";

let root: string;
let server: Awaited<ReturnType<typeof startServe>>;

const api = (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${server.url}${path}`, {
    ...init,
    headers: { "x-lucid-token": server.token, ...(init.headers ?? {}) },
  });

const restore = (version: number, artifact = ART) =>
  api(`/api/conversations/${CONV}/artifacts/${encodeURIComponent(artifact)}/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version }),
  });

const read = (version: number) => api(`/api/conversations/${CONV}/artifacts/${ART}/${version}`);

/** Three versions, the middle one carrying control values. */
const seed = (): void => {
  const host = createConversationHost(join(root, CONV), {
    now: () => Date.now(),
    presence: () => undefined,
    executorLease: () => false,
    onEffect: () => {},
    onRecord: () => {},
  });
  try {
    for (const v of [1, 2, 3]) {
      host.writeArtifact({
        artifactId: ART,
        version: v,
        author: v === 2 ? "human" : "agent",
        contentType: "text/html",
        bytes: `<!doctype html><html><body><p>version ${v}</p></body></html>`,
        ...(v > 1 ? { basedOn: v - 1 } : {}),
        ...(v === 2 ? { values: { e5: "on", e9: "Kevin" } } : {}),
      });
    }
  } finally {
    host.close();
  }
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "lucid-restore-"));
  createConversationRecord(root, CONV);
  server = await startServe({ rootDir: root, port: 0 });
  seed();
});

afterEach(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

describe("restoring an older version", () => {
  test("appends a copy at the end, authored by the person", async () => {
    const res = await restore(1);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.verdict).toBe("accepted");
    expect(body.version).toBe(4);
    expect(body.restoredFrom).toBe(1);
    expect(body.replaced).toBe(3);

    const four = (await (await read(4)).json()) as { bytes: string; author: string };
    const one = (await (await read(1)).json()) as { bytes: string };
    expect(four.bytes).toBe(one.bytes);
    expect(four.author).toBe("human");
  });

  test("nothing is removed, rewritten, or hidden", async () => {
    await restore(1);
    // The whole reason undo is "restore the other one". If v3 stopped being
    // readable, that would stop being true.
    for (const v of [1, 2, 3, 4]) {
      expect((await read(v)).status).toBe(200);
    }
    const three = (await (await read(3)).json()) as { bytes: string };
    expect(three.bytes).toContain("version 3");
  });

  test("undoing a restore is the same act again", async () => {
    await restore(1); // v4 == v1
    const back = await restore(3); // v5 == v3
    expect(back.status).toBe(200);
    const five = (await (await read(5)).json()) as { bytes: string };
    const three = (await (await read(3)).json()) as { bytes: string };
    expect(five.bytes).toBe(three.bytes);
  });

  test("the controls a version carried come back with it", async () => {
    // A save carries the document and the values of the controls in it,
    // because neither expresses the other. Restoring one without the other
    // would restore half a state.
    await restore(2);
    const four = (await (await read(4)).json()) as { values?: Record<string, string> };
    expect(four.values).toEqual({ e5: "on", e9: "Kevin" });
  });

  test("it records the version it came from", async () => {
    await restore(1);
    const four = (await (await read(4)).json()) as { basedOn?: number };
    expect(four.basedOn).toBe(1);
  });
});

describe("what restore refuses", () => {
  test("restoring the version that is already current", async () => {
    // It would append a copy that records nothing.
    const res = await restore(3);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("restore-of-current");
    expect((await read(4)).status).toBe(404);
  });

  test("a version the artifact does not have", async () => {
    const res = await restore(99);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("version-unreadable");
  });

  test("an artifact the record does not hold", async () => {
    const res = await restore(1, "no-such-thing");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("unknown-artifact");
  });

  test("a body with no version", async () => {
    const res = await api(`/api/conversations/${CONV}/artifacts/${ART}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("version-required");
  });

  test("a version that is not a positive integer", async () => {
    for (const version of [0, -1, 1.5]) {
      const res = await restore(version);
      expect(res.status).toBe(400);
    }
  });

  test("without the token", async () => {
    const res = await fetch(`${server.url}/api/conversations/${CONV}/artifacts/${ART}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1 }),
    });
    expect(res.status).toBe(401);
    expect((await read(4)).status).toBe(404);
  });
});

/**
 * Attaching a file over the endpoint (RFC-11).
 *
 * The endpoint is the rule and the browser is a convenience, so the bound is
 * checked here as well as in the store. Attaching and sending are separate:
 * this stores bytes and records that they exist, and sends nothing.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServe } from "../../src/cli/serve.js";
import { ATTACHMENT_BYTES_MAX } from "../../src/protocol/attachment.js";
import { hasBlob } from "../../src/store/blobs.js";
import { createConversationRecord } from "../../src/store/store.js";

const rig = async (): Promise<{
  post: (body: BodyInit, name: string, type?: string) => Promise<Response>;
  get: (hash: string) => Promise<Response>;
  dir: string;
  stop: () => Promise<void>;
}> => {
  const root = mkdtempSync(join(tmpdir(), "lucid-attach-api-"));
  createConversationRecord(root, "c");
  const server = await startServe({ rootDir: root, port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    dir: join(root, "c"),
    stop: () => server.close(),
    post: (body, name, type = "text/plain") =>
      fetch(`${base}/api/conversations/c/attachments`, {
        method: "POST",
        headers: {
          "x-lucid-token": server.token,
          "x-lucid-filename": name,
          "content-type": type,
        },
        body,
      }),
    get: (hash) =>
      fetch(`${base}/api/conversations/c/attachments/${hash}`, {
        headers: { "x-lucid-token": server.token },
      }),
  };
};

describe("attaching a file", () => {
  test("stores the bytes and answers with the hash", async () => {
    const r = await rig();
    const res = await r.post("a log line", "run.log");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hash: string; text: boolean; bytes: number };
    expect(body.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.text).toBe(true);
    expect(body.bytes).toBe(10);
    expect(hasBlob(r.dir, body.hash)).toBe(true);
    await r.stop();
  });

  test("records that it exists, without the bytes", async () => {
    const r = await rig();
    await r.post("secret contents here", "notes.txt");
    const log = readFileSync(join(r.dir, "log.ndjson"), "utf8");
    expect(log).toContain('"src":"attach"');
    expect(log).not.toContain("secret contents here");
    await r.stop();
  });

  test("decides text on the bytes, not the media type", async () => {
    const r = await rig();
    // Claims to be text and is not.
    const res = await r.post(new Uint8Array([0x61, 0x00, 0x62]), "claims.txt", "text/plain");
    expect(((await res.json()) as { text: boolean }).text).toBe(false);
    await r.stop();
  });

  test("an image is stored and marked not-text", async () => {
    const r = await rig();
    const res = await r.post(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "a.png", "image/png");
    expect(((await res.json()) as { text: boolean }).text).toBe(false);
    await r.stop();
  });

  test("nothing is sent to the agent", async () => {
    // Attaching and sending are separate acts.
    const r = await rig();
    await r.post("some text", "a.txt");
    const log = readFileSync(join(r.dir, "log.ndjson"), "utf8");
    expect(log).not.toContain('"src":"input"');
    await r.stop();
  });
});

describe("what the endpoint refuses", () => {
  test("a file over the bound, before the store sees it", async () => {
    const r = await rig();
    const res = await r.post(new Uint8Array(ATTACHMENT_BYTES_MAX + 1), "huge.bin");
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe("attachment-too-large");
    await r.stop();
  });

  test("no filename", async () => {
    const r = await rig();
    expect((await r.post("x", "")).status).toBe(400);
    await r.stop();
  });

  test("an unreasonable filename", async () => {
    const r = await rig();
    expect((await r.post("x", "n".repeat(129))).status).toBe(400);
    await r.stop();
  });

  test("a request without the token", async () => {
    const root = mkdtempSync(join(tmpdir(), "lucid-attach-auth-"));
    createConversationRecord(root, "c");
    const server = await startServe({ rootDir: root, port: 0 });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/conversations/c/attachments`, {
      method: "POST",
      headers: { "x-lucid-filename": "a.txt" },
      body: "x",
    });
    expect(res.status).toBe(401);
    await server.close();
  });
});

describe("the same file twice", () => {
  test("is one blob and two entries", async () => {
    const r = await rig();
    const a = (await (await r.post("same bytes", "one.txt")).json()) as { hash: string };
    const b = (await (await r.post("same bytes", "two.txt")).json()) as { hash: string };
    expect(a.hash).toBe(b.hash);
    const entries = readFileSync(join(r.dir, "log.ndjson"), "utf8")
      .split("\n")
      .filter((l) => l.includes('"src":"attach"'));
    expect(entries.length).toBe(2);
    await r.stop();
  });
});

describe("reading an attachment back for a thumbnail", () => {
  test("the bytes come back", async () => {
    const r = await rig();
    const { hash } = (await (await r.post("thumbnail me", "a.txt")).json()) as { hash: string };
    const res = await r.get(hash);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("thumbnail me");
    await r.stop();
  });

  test("never with the media type the sender claimed", async () => {
    // Letting a claim decide how the browser renders bytes is how a file
    // becomes a script.
    const r = await rig();
    const { hash } = (await (
      await r.post("<script>alert(1)</script>", "x.html", "text/html")
    ).json()) as { hash: string };
    const res = await r.get(hash);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    await r.stop();
  });

  test("a name that is not a hash is refused on its shape", async () => {
    const r = await rig();
    for (const bad of ["..%2Fsecret", "secret", "abc"]) {
      expect((await r.get(bad)).status).toBe(400);
    }
    await r.stop();
  });

  test("an unknown hash is not found, not an error", async () => {
    const r = await rig();
    expect((await r.get("f".repeat(64))).status).toBe(404);
    await r.stop();
  });
});

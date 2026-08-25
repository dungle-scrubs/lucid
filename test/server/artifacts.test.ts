/**
 * The document channel.
 *
 * Documents do not travel with the conversation. A transcript changes
 * constantly and costs a few lines; a document changes rarely and costs its
 * whole size, so the two are asked for separately and on different
 * cadences. These tests hold that separation to the endpoint boundary: the
 * conversation endpoint carries no document bytes, whatever the record
 * holds.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendInput } from "../../src/cli/send.js";
import { startServe } from "../../src/cli/serve.js";
import { encodeAnnotationBatch } from "../../src/protocol/annotations.js";
import { createConversationHost } from "../../src/store/conversation-host.js";
import { createConversationRecord } from "../../src/store/store.js";

const CONV = "art-1";
const DOC = "<h1>a document</h1>";

let root: string;
let server: Awaited<ReturnType<typeof startServe>>;

const api = (path: string): Promise<Response> =>
  fetch(`${server.url}${path}`, { headers: { "x-lucid-token": server.token } });

/** Write a version the way the emission path does, then close — the server
 * is a separate reader and must find it on disk, not in anyone's memory. */
const writeVersion = (version: number, bytes: string): void => {
  const host = createConversationHost(join(root, CONV), {
    now: () => Date.now(),
    presence: () => undefined,
    executorLease: () => false,
    onEffect: () => {},
    onRecord: () => {},
  });
  try {
    const r = host.writeArtifact({
      artifactId: "doc-1",
      version,
      author: "agent",
      contentType: "text/html",
      bytes,
    });
    expect(r.verdict).toBe("accepted");
  } finally {
    host.close();
  }
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "lucid-art-"));
  createConversationRecord(root, CONV);
  server = await startServe({ rootDir: root, port: 0 });
});

afterEach(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

describe("documents travel on their own channel", () => {
  test("a record with no documents has an empty catalog, not an error", async () => {
    const res = await api(`/api/conversations/${CONV}/artifacts`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { artifacts: unknown[] }).artifacts).toEqual([]);
  });

  test("the catalog names versions and carries no document bytes", async () => {
    writeVersion(1, DOC);
    writeVersion(2, "<h1>revised</h1>");
    const body = await (await api(`/api/conversations/${CONV}/artifacts`)).text();
    expect(body).not.toContain("a document");
    expect(body).not.toContain("revised");
    const { artifacts } = JSON.parse(body) as {
      artifacts: { artifactId: string; versions: number[]; latest: number }[];
    };
    expect(artifacts.length).toBe(1);
    expect(artifacts[0]?.artifactId).toBe("doc-1");
    expect(artifacts[0]?.versions).toEqual([1, 2]);
    expect(artifacts[0]?.latest).toBe(2);
  });

  test("the conversation endpoint never carries a document, however many exist", async () => {
    writeVersion(1, DOC);
    writeVersion(2, "<h1>revised</h1>");
    const body = await (await api(`/api/conversations/${CONV}`)).text();
    expect(body).not.toContain("a document");
    expect(body).not.toContain("revised");
  });
});

describe("one version per request, read by seeking", () => {
  test("a version comes back with its bytes and its content type", async () => {
    writeVersion(1, DOC);
    const res = await api(`/api/conversations/${CONV}/artifacts/doc-1/1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      artifactId: string;
      version: number;
      contentType: string;
      bytes: string;
      hash: string;
    };
    expect(body.artifactId).toBe("doc-1");
    expect(body.version).toBe(1);
    expect(body.contentType).toBe("text/html");
    expect(body.bytes).toBe(DOC);
    expect(body.hash.length).toBeGreaterThan(0);
  });

  test("one request brings back one version, never the set", async () => {
    writeVersion(1, DOC);
    writeVersion(2, "<h1>revised</h1>");
    const body = await (await api(`/api/conversations/${CONV}/artifacts/doc-1/2`)).text();
    expect(body).toContain("revised");
    expect(body).not.toContain("a document");
  });

  test("an older version is still readable after a newer one lands", async () => {
    writeVersion(1, DOC);
    writeVersion(2, "<h1>revised</h1>");
    const first = (await (await api(`/api/conversations/${CONV}/artifacts/doc-1/1`)).json()) as {
      bytes: string;
    };
    expect(first.bytes).toBe(DOC);
  });

  test("a version that was never written is not found", async () => {
    writeVersion(1, DOC);
    expect((await api(`/api/conversations/${CONV}/artifacts/doc-1/9`)).status).toBe(404);
    expect((await api(`/api/conversations/${CONV}/artifacts/nope/1`)).status).toBe(404);
  });

  test("a version that is not a version is refused, not sought", async () => {
    expect((await api(`/api/conversations/${CONV}/artifacts/doc-1/0`)).status).toBe(400);
  });

  test("the document channel needs the token like everything else", async () => {
    writeVersion(1, DOC);
    const noToken = await fetch(`${server.url}/api/conversations/${CONV}/artifacts`);
    expect(noToken.status).toBe(401);
    const foreign = await fetch(`${server.url}/api/conversations/${CONV}/artifacts/doc-1/1`, {
      headers: { "x-lucid-token": server.token, origin: "https://evil.example" },
    });
    expect(foreign.status).toBe(403);
  });
});

describe("the page cannot reach into the document", () => {
  test("the frame is sandboxed without allow-same-origin, and is handed its bytes", async () => {
    const html = await (await fetch(`${server.url}/c/${CONV}`)).text();
    const src = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
    expect(src).toBeDefined();
    const bundle = await (await fetch(`${server.url}${src}`)).text();

    // `allow-same-origin` is what would let the parent read into the frame,
    // and the frame read back out into a page holding a token with read and
    // write on every record. The document is written by an agent.
    expect(bundle).toContain("allow-scripts");
    expect(bundle).not.toContain("allow-same-origin");

    // srcDoc hands the frame its bytes. A frame given a URL would fetch,
    // and a document is not something to let fetch.
    expect(bundle).toContain("srcDoc");
  });
});

describe("marks live on the version they were made against", () => {
  /** Send a batch the way the browser does: an input carrying the encoding. */
  const annotate = (version: number, ids: readonly string[]): void => {
    sendInput(CONV, {
      rootDir: root,
      text: encodeAnnotationBatch({
        artifactId: "doc-1",
        version,
        notes: [
          {
            note: "a note",
            spots: ids.map((id) => ({ id, snippet: "what was there", author: "agent" })),
          },
        ],
      }),
    });
  };

  test("a mark is reported against its own version and no other", async () => {
    writeVersion(1, DOC);
    writeVersion(2, "<h1>revised</h1>");
    annotate(1, ["e1", "e3"]);
    annotate(2, ["e7"]);
    const { marks } = (await (await api(`/api/conversations/${CONV}/artifacts`)).json()) as {
      marks: Record<string, string[]>;
    };
    expect(marks["doc-1@1"]).toEqual(["e1", "e3"]);
    expect(marks["doc-1@2"]).toEqual(["e7"]);
  });

  test("nothing is re-anchored: a version with no notes has no marks", async () => {
    writeVersion(1, DOC);
    writeVersion(2, "<h1>revised</h1>");
    annotate(1, ["e1"]);
    const { marks } = (await (await api(`/api/conversations/${CONV}/artifacts`)).json()) as {
      marks: Record<string, string[]>;
    };
    expect(marks["doc-1@1"]).toEqual(["e1"]);
    expect(marks["doc-1@2"]).toBeUndefined();
  });

  test("every spot of a multi-spot note is marked", async () => {
    writeVersion(1, DOC);
    annotate(1, ["e2", "e4", "e6"]);
    const { marks } = (await (await api(`/api/conversations/${CONV}/artifacts`)).json()) as {
      marks: Record<string, string[]>;
    };
    expect(marks["doc-1@1"]).toEqual(["e2", "e4", "e6"]);
  });

  test("an ordinary message is not mistaken for a batch", async () => {
    writeVersion(1, DOC);
    sendInput(CONV, { rootDir: root, text: "just something I typed" });
    const { marks } = (await (await api(`/api/conversations/${CONV}/artifacts`)).json()) as {
      marks: Record<string, string[]>;
    };
    expect(Object.keys(marks)).toEqual([]);
  });

  test("every version stays readable, which is what makes a mark honest", async () => {
    writeVersion(1, DOC);
    writeVersion(2, "<h1>revised</h1>");
    writeVersion(3, "<h1>revised again</h1>");
    annotate(1, ["e1"]);
    for (const [v, want] of [
      [1, DOC],
      [2, "<h1>revised</h1>"],
      [3, "<h1>revised again</h1>"],
    ] as const) {
      const body = (await (
        await api(`/api/conversations/${CONV}/artifacts/doc-1/${v}`)
      ).json()) as {
        bytes: string;
      };
      expect(body.bytes).toBe(want);
    }
  });
});

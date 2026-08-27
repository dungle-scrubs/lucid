/**
 * The loopback server, against a real record.
 *
 * Every test starts a server on port 0 (the kernel picks a free one), so
 * the suite never collides with a server a person is running.
 *
 * What is proven here is the ticket's own list: the token gates the API, a
 * foreign origin is refused, the record secret never leaves the machine's
 * own process, an append lands with nothing driving, and a restart makes
 * every old token useless.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendInput } from "../../src/cli/send.js";
import { startServe } from "../../src/cli/serve.js";
import { ARTIFACT_TITLE_MAX } from "../../src/protocol/artifact-title.js";
import { createConversationHost } from "../../src/store/conversation-host.js";
import { acquirePresence } from "../../src/store/presence.js";
import { createConversationRecord } from "../../src/store/store.js";

const CONV = "srv-1";

let root: string;
let server: Awaited<ReturnType<typeof startServe>>;

const url = (path: string): string => `${server.url}${path}`;

/** Every API call needs the token; the tests that check refusal pass their
 * own headers instead of using this. */
const api = (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(url(path), {
    ...init,
    headers: { "x-lucid-token": server.token, ...(init.headers ?? {}) },
  });

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "lucid-server-"));
  createConversationRecord(root, CONV);
  server = await startServe({ rootDir: root, port: 0 });
});

afterEach(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

describe("the way in", () => {
  test("binds loopback, and the port is the one the kernel gave back", () => {
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
  });

  test("serves one page for every record; the conversation comes from the URL", async () => {
    const a = await fetch(url("/c/srv-1"));
    const b = await fetch(url("/c/another"));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((a.headers.get("content-type") ?? "").includes("text/html")).toBe(true);
  });

  test("the page is served from this origin, never from a CDN", async () => {
    const html = await (await fetch(url("/c/srv-1"))).text();
    expect(html).not.toContain("esm.sh");
    expect(html).not.toContain("unpkg");
    expect(html).not.toContain("cdn.");
    // Its script is a same-origin path, so the bundle cannot be swapped by
    // anyone but this server.
    const src = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
    expect(src).toBeDefined();
    expect(src?.startsWith("/")).toBe(true);
  });
});

describe("a page that has not proved itself cannot read or write", () => {
  test("no token is refused", async () => {
    expect((await fetch(url(`/api/conversations/${CONV}`))).status).toBe(401);
  });

  test("a wrong token is refused", async () => {
    const res = await fetch(url(`/api/conversations/${CONV}`), {
      headers: { "x-lucid-token": "not-the-token" },
    });
    expect(res.status).toBe(401);
  });

  test("writing without the token is refused, and nothing is appended", async () => {
    const before = readFileSync(join(root, CONV, "log.ndjson"), "utf8");
    const res = await fetch(url(`/api/conversations/${CONV}/input`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "should not land" }),
    });
    expect(res.status).toBe(401);
    expect(readFileSync(join(root, CONV, "log.ndjson"), "utf8")).toBe(before);
  });

  test("the token is minted per start, so a restart invalidates every page", async () => {
    const old = server.token;
    await server.close();
    server = await startServe({ rootDir: root, port: 0 });
    expect(server.token).not.toBe(old);
    const res = await fetch(url(`/api/conversations/${CONV}`), {
      headers: { "x-lucid-token": old },
    });
    expect(res.status).toBe(401);
  });
});

describe("a request from anywhere else is refused before it arrives", () => {
  test("a foreign origin is refused even holding the token", async () => {
    const res = await api(`/api/conversations/${CONV}`, {
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  test("a drive-by post from a site you visited is refused, and appends nothing", async () => {
    const before = readFileSync(join(root, CONV, "log.ndjson"), "utf8");
    const res = await fetch(url(`/api/conversations/${CONV}/input`), {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "text/plain" },
      body: JSON.stringify({ text: "drive-by" }),
    });
    expect(res.status).toBe(403);
    expect(readFileSync(join(root, CONV, "log.ndjson"), "utf8")).toBe(before);
  });

  test("this server's own origin is allowed", async () => {
    const res = await api(`/api/conversations/${CONV}`, { headers: { origin: server.url } });
    expect(res.status).toBe(200);
  });
});

describe("the record secret never reaches the browser", () => {
  test("neither the page nor the API carries it", async () => {
    const secret = readFileSync(join(root, CONV, "secret"), "utf8").trim();
    expect(secret.length).toBeGreaterThan(8);
    sendInput(CONV, { rootDir: root, text: "hello" });
    const page = await (await fetch(url(`/c/${CONV}`))).text();
    const body = await (await api(`/api/conversations/${CONV}`)).text();
    expect(page).not.toContain(secret);
    expect(body).not.toContain(secret);
  });
});

describe("reading a conversation", () => {
  test("shows what was said, through the same projection the terminal uses", async () => {
    sendInput(CONV, { rootDir: root, text: "a question from the terminal" });
    const res = await api(`/api/conversations/${CONV}`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { lines: { kind: string; text: string }[] };
    expect(data.lines.some((l) => l.text.includes("a question from the terminal"))).toBe(true);
  });

  test("a record that does not exist is empty, not an error", async () => {
    const res = await api("/api/conversations/never-made");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { lines: unknown[]; damaged: boolean };
    expect(data.lines).toEqual([]);
    expect(data.damaged).toBe(false);
  });

  test("a damaged record says so rather than rendering as silence", async () => {
    sendInput(CONV, { rootDir: root, text: "before the damage" });
    const log = join(root, CONV, "log.ndjson");
    writeFileSync(log, `${readFileSync(log, "utf8")}{ this is not json\n`);
    const data = (await (await api(`/api/conversations/${CONV}`)).json()) as {
      lines: { text: string }[];
      damaged: boolean;
      status: string;
    };
    expect(data.damaged).toBe(true);
    // The fold refuses a log it cannot read rather than folding part of it,
    // so there is nothing to show. What matters is that the page is told,
    // instead of being handed an empty conversation that looks the same as
    // one nobody has spoken in.
    expect(data.lines).toEqual([]);
    expect(data.status).toBe("damaged");
  });

  test("an invalid conversation id is refused", async () => {
    const res = await api("/api/conversations/..%2Fescape");
    expect(res.status).toBe(400);
  });
});

describe("writing reaches the record with nothing driving", () => {
  test("an append lands and waits, exactly as sending from a terminal does", async () => {
    const res = await api(`/api/conversations/${CONV}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "from the browser" }),
    });
    expect(res.status).toBe(200);
    const { inputId, verdict } = (await res.json()) as { inputId: string; verdict: string };
    expect(verdict).toBe("accepted");
    expect(inputId.startsWith("browser-")).toBe(true);

    const raw = readFileSync(join(root, CONV, "log.ndjson"), "utf8");
    expect(raw).toContain("from the browser");
    expect(raw).toContain(inputId);
  });

  test("the server never drives: it takes no presence lock and emits no effect", async () => {
    await api(`/api/conversations/${CONV}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "no driving" }),
    });
    // The delivery cursor is written by whoever acts on the log. A server
    // that never drives never writes one, so its absence is the evidence
    // that this append waited for a driver instead of being dispatched.
    const raw = readFileSync(join(root, CONV, "log.ndjson"), "utf8");
    expect(raw).not.toContain('"src":"cursor"');
  });

  test("empty text is refused", async () => {
    const res = await api(`/api/conversations/${CONV}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    });
    expect(res.status).toBe(400);
  });

  test("text past the protocol's own bound is refused, not truncated", async () => {
    const res = await api(`/api/conversations/${CONV}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(1_000_001) }),
    });
    expect(res.status).toBe(413);
    expect(readFileSync(join(root, CONV, "log.ndjson"), "utf8")).not.toContain("xxxxxxxxxx");
  });

  test("a body that is not JSON is refused", async () => {
    const res = await api(`/api/conversations/${CONV}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json at all",
    });
    expect(res.status).toBe(400);
  });
});

describe("the page says whether anything is driving", () => {
  test("with no driver the status is not a live one", async () => {
    sendInput(CONV, { rootDir: root, text: "nobody is driving" });
    const data = (await (await api(`/api/conversations/${CONV}`)).json()) as { status: string };
    expect(data.status).toBe("agent-gone");
  });

  test("a held presence lock is reported as a live channel, however stale the lease", async () => {
    // The lease is what goes stale while a driver sits idle; the lock is
    // what stays true. Holding the lock without writing anything is exactly
    // the state that used to read as "agent-gone" while an agent answered.
    const handle = acquirePresence(join(root, CONV), CONV);
    try {
      const data = (await (await api(`/api/conversations/${CONV}`)).json()) as { status: string };
      expect(data.status).not.toBe("agent-gone");
    } finally {
      handle.release();
    }
  });
});

describe("whether the agent is working", () => {
  /** Append an event the way a driver does, so the transcript is real. */
  const emit = (turnId: string, event: Record<string, unknown>, n: number): void => {
    const host = createConversationHost(join(root, CONV), {
      now: () => Date.now(),
      presence: () => undefined,
      executorLease: () => true,
      onEffect: () => {},
      onRecord: () => {},
    });
    try {
      const secret = readFileSync(join(root, CONV, "secret"), "utf8").trim();
      host.handleFrame(
        JSON.stringify({
          kind: "attach",
          conversationId: CONV,
          profile: "headless-session",
          secret,
          version: 1,
          harness: "claude",
        }),
      );
      host.handleFrame(JSON.stringify({ kind: "event", epoch: 1, n, turnId, event }));
    } finally {
      host.close();
    }
  };

  test("a turn with no terminal event is running", async () => {
    emit("turn-1", { kind: "message", role: "assistant", text: "thinking out loud" }, 1);
    const body = (await (await api(`/api/conversations/${CONV}`)).json()) as {
      activity: { turn: boolean };
    };
    expect(body.activity.turn).toBe(true);
  });

  test("a turn that produced done is not running", async () => {
    emit("turn-1", { kind: "message", role: "assistant", text: "here you go" }, 1);
    emit("turn-1", { kind: "done", exitCode: 0, cause: "clean" }, 2);
    const body = (await (await api(`/api/conversations/${CONV}`)).json()) as {
      activity: { turn: boolean };
    };
    // `state.turn` still names turn-1 after this — it is what an abort would
    // target — so reading that instead said the agent was working forever.
    expect(body.activity.turn).toBe(false);
  });

  test("an older unfinished turn is history, not activity", async () => {
    // A driver killed mid-turn leaves a turn with no done. That is not the
    // agent working now.
    emit("turn-1", { kind: "message", role: "assistant", text: "interrupted" }, 1);
    emit("turn-2", { kind: "message", role: "assistant", text: "finished" }, 2);
    emit("turn-2", { kind: "done", exitCode: 0, cause: "clean" }, 3);
    const body = (await (await api(`/api/conversations/${CONV}`)).json()) as {
      activity: { turn: boolean };
    };
    expect(body.activity.turn).toBe(false);
  });

  test("a record with no events at all is not working", async () => {
    const body = (await (await api(`/api/conversations/${CONV}`)).json()) as {
      activity: { turn: boolean };
    };
    expect(body.activity.turn).toBe(false);
  });
});

/** RFC-07 R11 at the endpoint. The endpoint is where a caller can be told
 * why, which is why the bound and the unknown-artifact check live here even
 * though the fold tolerates both. */
describe("naming an artifact", () => {
  /** A record holding one artifact, so a rename has something to name. */
  const withArtifact = (): void => {
    const host = createConversationHost(join(root, CONV), {
      now: () => Date.now(),
      presence: () => undefined,
      executorLease: () => false,
      onEffect: () => {},
      onRecord: () => {},
    });
    try {
      host.writeArtifact({
        artifactId: "doc-1",
        version: 1,
        author: "agent",
        contentType: "text/html",
        bytes: "<p>one</p>",
      });
    } finally {
      host.close();
    }
  };

  const rename = (artifactId: string, title: unknown): Promise<Response> =>
    api(`/api/conversations/${CONV}/artifacts/${artifactId}/meta`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });

  test("a rename lands, and the catalog shows the new name", async () => {
    withArtifact();
    expect((await rename("doc-1", "First day checklist")).status).toBe(200);
    const cat = (await (await api(`/api/conversations/${CONV}/artifacts`)).json()) as {
      artifacts: { artifactId: string; title?: string }[];
    };
    expect(cat.artifacts[0]?.title).toBe("First day checklist");
    expect(cat.artifacts[0]?.artifactId).toBe("doc-1");
  });

  test("an artifact nobody renamed carries no title at all", async () => {
    // Absent, not empty. A reader that does not know about titles is
    // unaffected, and one that does falls back to the id.
    withArtifact();
    const cat = (await (await api(`/api/conversations/${CONV}/artifacts`)).json()) as {
      artifacts: Record<string, unknown>[];
    };
    expect(cat.artifacts[0]).not.toHaveProperty("title");
  });

  test("renaming creates no version", async () => {
    withArtifact();
    await rename("doc-1", "Named");
    const cat = (await (await api(`/api/conversations/${CONV}/artifacts`)).json()) as {
      artifacts: { versions: number[] }[];
    };
    expect(cat.artifacts[0]?.versions).toEqual([1]);
  });

  test("naming an artifact the record does not hold is refused", async () => {
    withArtifact();
    expect((await rename("no-such-doc", "Ghost")).status).toBe(404);
  });

  test("a title outside the bound is refused and nothing is appended", async () => {
    withArtifact();
    const long = await rename("doc-1", "x".repeat(ARTIFACT_TITLE_MAX + 1));
    expect(long.status).toBe(400);
    expect((await long.json()).error).toBe("invalid-title");
    expect((await rename("doc-1", "")).status).toBe(400);
    expect((await rename("doc-1", 42)).status).toBe(400);
    expect((await rename("doc-1", "two\nlines")).status).toBe(400);
    const cat = (await (await api(`/api/conversations/${CONV}/artifacts`)).json()) as {
      artifacts: Record<string, unknown>[];
    };
    expect(cat.artifacts[0]).not.toHaveProperty("title");
  });

  test("a title at exactly the bound is accepted", async () => {
    withArtifact();
    expect((await rename("doc-1", "x".repeat(ARTIFACT_TITLE_MAX))).status).toBe(200);
  });

  test("renaming twice keeps the second name", async () => {
    withArtifact();
    await rename("doc-1", "First");
    await rename("doc-1", "Second");
    const cat = (await (await api(`/api/conversations/${CONV}/artifacts`)).json()) as {
      artifacts: { title?: string }[];
    };
    expect(cat.artifacts[0]?.title).toBe("Second");
  });

  test("a rename needs the token like everything else", async () => {
    withArtifact();
    const res = await fetch(url(`/api/conversations/${CONV}/artifacts/doc-1/meta`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "No token" }),
    });
    expect(res.status).toBe(401);
  });
});

/** RFC-07 R12 at the endpoint and in the catalog. */
describe("retiring an artifact", () => {
  const withArtifact = (): void => {
    const host = createConversationHost(join(root, CONV), {
      now: () => Date.now(),
      presence: () => undefined,
      executorLease: () => false,
      onEffect: () => {},
      onRecord: () => {},
    });
    try {
      host.writeArtifact({
        artifactId: "doc-1",
        version: 1,
        author: "agent",
        contentType: "text/html",
        bytes: "<p>one</p>",
      });
    } finally {
      host.close();
    }
  };

  const meta = (artifactId: string, body: unknown): Promise<Response> =>
    api(`/api/conversations/${CONV}/artifacts/${artifactId}/meta`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const catalog = async (): Promise<{ artifactId: string; retired?: boolean }[]> =>
    (
      (await (await api(`/api/conversations/${CONV}/artifacts`)).json()) as {
        artifacts: { artifactId: string; retired?: boolean }[];
      }
    ).artifacts;

  test("a retire lands, and the catalog says so", async () => {
    withArtifact();
    expect((await meta("doc-1", { retired: true })).status).toBe(200);
    expect((await catalog())[0]?.retired).toBe(true);
  });

  test("bringing it back clears the flag", async () => {
    withArtifact();
    await meta("doc-1", { retired: true });
    expect((await meta("doc-1", { retired: false })).status).toBe(200);
    // Absent, not false: the wire carries retired only when it is true.
    expect((await catalog())[0]).not.toHaveProperty("retired");
  });

  test("an artifact nobody retired carries no flag", async () => {
    withArtifact();
    expect((await catalog())[0]).not.toHaveProperty("retired");
  });

  test("retiring creates no version, and every version stays", async () => {
    withArtifact();
    await meta("doc-1", { retired: true });
    const one = await api(`/api/conversations/${CONV}/artifacts/doc-1/1`);
    expect(one.status).toBe(200);
    const cat = (await (await api(`/api/conversations/${CONV}/artifacts`)).json()) as {
      artifacts: { versions: number[] }[];
    };
    expect(cat.artifacts[0]?.versions).toEqual([1]);
  });

  test("a retired artifact is still readable by its URL", async () => {
    // It says it was retired rather than behaving as though it never
    // existed, which is what makes its page the way back.
    withArtifact();
    await meta("doc-1", { retired: true });
    const res = await api(`/api/conversations/${CONV}/artifacts/doc-1/1`);
    expect(res.status).toBe(200);
  });

  test("a non-boolean retired is refused", async () => {
    withArtifact();
    expect((await meta("doc-1", { retired: "yes" })).status).toBe(400);
    expect((await meta("doc-1", { retired: 1 })).status).toBe(400);
  });

  test("a request saying nothing is refused", async () => {
    withArtifact();
    const res = await meta("doc-1", {});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("nothing-to-write");
  });

  test("retiring an artifact the record does not hold is refused", async () => {
    withArtifact();
    expect((await meta("no-such-doc", { retired: true })).status).toBe(404);
  });

  test("a title and a retire can travel together", async () => {
    withArtifact();
    expect((await meta("doc-1", { title: "Done with", retired: true })).status).toBe(200);
    const c = (await catalog())[0] as { title?: string; retired?: boolean };
    expect(c.title).toBe("Done with");
    expect(c.retired).toBe(true);
  });
});

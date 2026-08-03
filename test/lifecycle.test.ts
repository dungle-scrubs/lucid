import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "../client/chrome/session.ts";
import { appendEvent } from "../src/core/log.ts";
import { sessionPaths, type SessionPaths } from "../src/core/paths.ts";
import { openSession } from "../src/core/session.ts";
import { DEFAULT_FRAME } from "../src/protocol/frames.ts";
import { lifecycleStatusOf, type StateResponse } from "../src/protocol/wire.ts";
import { createSessionHost } from "../src/server/session-host.ts";

/**
 * A HEALED session is active again, everywhere that reads it.
 *
 * Idle-suspend evicts a mount; the tab's stream reconnects, and the host
 * appends `session_resumed` to heal the log. The viewer never heard: it kept
 * its own two-case list of lifecycle events, `session_resumed` was not in it,
 * and the tab stayed "suspended" until a reload - with the composer, the
 * working line and the revise notice switched off behind that status.
 *
 * All three halves are pinned here: the SERVER states the healed lifecycle (in
 * the frame it broadcasts and in `/__lucid/state`), the shared table answers
 * "active" for it, and the TAB - driven through the session handle's own frame
 * seam, not through the table it consults - ends up active without a reload.
 */

const DOC =
  '<!doctype html><html><head><title>t</title></head><body><h1 data-lucid-id="h">Hello</h1></body></html>';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("the lifecycle table: one owner, both sides", () => {
  test("a resume is a session becoming active again", () => {
    expect(lifecycleStatusOf("session_resumed")).toBe("active");
    expect(lifecycleStatusOf("session_opened")).toBe("active");
  });

  test("suspending and ending are the other two", () => {
    expect(lifecycleStatusOf("session_suspended")).toBe("suspended");
    expect(lifecycleStatusOf("session_ended")).toBe("ended");
  });

  test("a content event is not a lifecycle event, so it moves no status", () => {
    expect(lifecycleStatusOf("annotation")).toBeNull();
    expect(lifecycleStatusOf("agent_ack")).toBeNull();
  });
});

describe("a subscriber healing a suspended session", () => {
  let dir: string;
  let paths: SessionPaths;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lucid-lifecycle-"));
    const artifact = join(dir, "plan.html");
    await writeFile(artifact, DOC);
    paths = sessionPaths(artifact);
    await openSession(paths);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("the resume reaches the watching tab as a frame, and state reports it as active", async () => {
    await appendEvent(paths, { t: "session_suspended" });
    const host = createSessionHost(paths, { getPort: () => 0, onEnded: () => {} });
    try {
      // Suspended is what the tab would be showing at this point.
      const before = (await (
        await host.handle(
          new Request("http://127.0.0.1/__lucid/state", { headers: { host: "127.0.0.1" } }),
        )
      ).json()) as StateResponse;
      expect(before.lifecycle).toBe("suspended");

      // The tab's stream reconnecting - the same act that heals the log.
      const stream = await host.handle(
        new Request("http://127.0.0.1/__lucid/events", { headers: { host: "127.0.0.1" } }),
      );
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !buffered.includes("session_resumed")) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
      }
      // The frame the chrome decodes: a log event on the default frame, so no
      // reload is needed for the tab to learn of it.
      expect(buffered).toContain('"t":"session_resumed"');
      const framed = buffered
        .split("\n")
        .filter((line) => line.startsWith("data: ") && line.includes("session_resumed"))
        .map((line) => JSON.parse(line.slice(6)) as { t: string });
      expect(framed[0]?.t).toBe("session_resumed");
      // ...and that frame's own meaning, read by the one gate the chrome uses.
      expect(lifecycleStatusOf(framed[0]!.t)).toBe("active");

      // A tab that DID reload reads the same answer from the state route.
      const after = (await (
        await host.handle(
          new Request("http://127.0.0.1/__lucid/state", { headers: { host: "127.0.0.1" } }),
        )
      ).json()) as StateResponse;
      expect(after.lifecycle).toBe("active");

      await reader.cancel().catch(() => {});
      await sleep(10);
    } finally {
      host.stop();
    }
  });
});

/** A session handle with no server behind it: enough to drive frames into,
 *  which is all these need. `base` is absolute so the chrome's one fetch seam
 *  addresses the stub below rather than a page origin that does not exist. */
const handleOn = (base: string) =>
  createSession({ session: "/proj/.lucid/plan.html", name: "plan.html", version: 1, base });

/** One log event as the default frame carries it, verbatim. */
const logFrame = (t: string, seq: number): [string, string] => [
  DEFAULT_FRAME,
  JSON.stringify({ t, seq, at: new Date(1700000000000 + seq).toISOString() }),
];

describe("the tab's own status, off the live channel", () => {
  test("a resume frame puts the tab back to active, with no reload", () => {
    const handle = handleOn("http://127.0.0.1:1");
    try {
      handle.onFrame(...logFrame("session_suspended", 1));
      expect(handle.store.getState().status).toBe("suspended");

      // The frame the reconnect produced. Nothing else happens - no bootstrap,
      // no page load - and the tab is active again.
      handle.onFrame(...logFrame("session_resumed", 2));
      expect(handle.store.getState().status).toBe("active");
    } finally {
      handle.surface.dispose();
    }
  });

  test("an in-flight bootstrap cannot revive a session that ended while it flew", async () => {
    // The snapshot is computed BEFORE the end lands, so it truthfully reports
    // "active" - and applying it would put a dead session back on screen as a
    // live one, with reopen withheld and a send offered against nothing.
    let arrived!: () => void;
    const requested = new Promise<void>((r) => {
      arrived = r;
    });
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const payload = {
      session: "/proj/.lucid/plan.html",
      version: 7,
      status: "waiting",
      nextCursor: "",
      reviewResolved: false,
      annotations: [],
      messages: [],
      lifecycle: "active",
      agentsListening: 0,
    } satisfies StateResponse;
    const stub = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        if (!new URL(req.url).pathname.endsWith("/__lucid/state")) {
          return new Response("no", { status: 404 });
        }
        arrived();
        await held;
        return Response.json(payload);
      },
    });
    const handle = handleOn(`http://127.0.0.1:${stub.port}`);
    try {
      // A content event is what fires a bootstrap.
      handle.onFrame(...logFrame("agent_reply", 1));
      await requested;

      // ...and the end lands while that request is still out.
      handle.onFrame(...logFrame("session_ended", 2));
      expect(handle.store.getState().status).toBe("ended");

      release();
      // The snapshot still applies - everything except the lifecycle it no
      // longer has the newest word on.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && handle.store.getState().version !== 7) await sleep(5);
      expect(handle.store.getState().version).toBe(7);
      expect(handle.store.getState().status).toBe("ended");
    } finally {
      handle.surface.dispose();
      await stub.stop(true);
    }
  });
});

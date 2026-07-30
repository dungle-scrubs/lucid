import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The chrome's one fetch seam (plan 07, M1.3). Every browser request carries
 * `x-lucid-request`, and the only way to guarantee "every" is structurally:
 * one helper owns fetch, and no other chrome module may call it. A new fetch
 * call site would reintroduce the gap silently - so this is asserted on the
 * SOURCE, not on behavior.
 */

const CLIENT = join(import.meta.dir, "..", "client");
const OWNER = "request.ts";

/** A bare fetch call - not hubFetch(, not loopbackFetch(, and not the
 *  window./globalThis. spellings either: those would bypass the seam while
 *  a dotted lookbehind waved them through. */
const BARE_FETCH = /(?<![A-Za-z])(?:window\.|globalThis\.|self\.)?fetch\(/;

const clientSources = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p);
    }
  };
  // The whole client tree, not just chrome/: the bundle entries and shared/
  // modules ship in the same bundles, so a fetch added there bypasses the
  // seam just as silently.
  walk(CLIENT);
  return out;
};

describe("no client module calls fetch except the request helper", () => {
  test("every fetch call site lives in request.ts", () => {
    const offenders = clientSources()
      .filter((p) => !p.endsWith(`/${OWNER}`))
      .filter((p) => BARE_FETCH.test(readFileSync(p, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("hubFetch stamps the trace - behaviourally, not by grep", () => {
  const stubFetch = async (fn: () => Promise<void>): Promise<Request[]> => {
    const seen: Request[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input as string, init));
      return new Response("ok");
    }) as typeof fetch;
    try {
      await fn();
    } finally {
      globalThis.fetch = real;
    }
    return seen;
  };

  test("a well-formed id lands on the wire for every HeadersInit shape, and nothing is lost", async () => {
    const { hubFetch } = await import("../client/chrome/request.ts");
    const seen = await stubFetch(async () => {
      await hubFetch("http://127.0.0.1:9/hub/sessions");
      await hubFetch("http://127.0.0.1:9/hub/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      await hubFetch("http://127.0.0.1:9/x", { headers: new Headers({ "x-lucid-filename": "a" }) });
      await hubFetch("http://127.0.0.1:9/y", { headers: [["accept", "text/html"]] });
    });

    for (const req of seen) {
      expect(req.headers.get("x-lucid-request")).toMatch(/^[a-f0-9]{16}$/);
    }
    expect(seen[1]?.method).toBe("POST");
    expect(seen[1]?.headers.get("content-type")).toBe("application/json");
    expect(seen[2]?.headers.get("x-lucid-filename")).toBe("a");
    expect(seen[3]?.headers.get("accept")).toBe("text/html");
  });
});

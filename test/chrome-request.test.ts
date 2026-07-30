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

describe("no client module hand-rolls a deadline", () => {
  test("AbortSignal.timeout appears only in request.ts - the seam decides what a deadline means", () => {
    const offenders = clientSources()
      .filter((p) => !p.endsWith(`/${OWNER}`))
      .filter((p) => /AbortSignal\.timeout\(/.test(readFileSync(p, "utf8")));
    expect(offenders).toEqual([]);
  });

  test("every hubFetch call site is bounded or explicitly exempt", () => {
    // A call site is fine if it passes no timeoutMs (inherits the default),
    // passes a number, or passes null WITH the exemption named in place. What
    // must not exist is an exemption with no reason beside it.
    const exemptions: string[] = [];
    for (const path of clientSources()) {
      const source = readFileSync(path, "utf8");
      for (const [index, line] of source.split("\n").entries()) {
        if (!/timeoutMs\s*:\s*null/.test(line)) continue;
        const context = source
          .split("\n")
          .slice(Math.max(0, index - 6), index)
          .join(" ");
        if (!/chooser|human/i.test(context)) exemptions.push(`${path}:${index + 1}`);
      }
    }
    expect(exemptions).toEqual([]);
  });
});

describe("hubFetch carries the deadline (plan 07, M2.2)", () => {
  /** A fetch that never settles - the hang this milestone exists to bound. */
  const hangingFetch = (): (() => void) => {
    const real = globalThis.fetch;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason ?? new Error("aborted")),
        );
      })) as typeof fetch;
    return () => {
      globalThis.fetch = real;
    };
  };

  test("a fetch that never answers rejects by the deadline, naming the likely cause", async () => {
    const { hubFetch } = await import("../client/chrome/request.ts");
    const restore = hangingFetch();
    try {
      // Raced against a sentinel, NOT awaited bare: without a deadline the
      // call never settles, and a bare await would hang the whole runner
      // instead of reporting a failure. The race turns "never settles" into
      // the assertable value it is.
      const outcome = await Promise.race([
        hubFetch("/hub/sessions", { timeoutMs: 150 }).then(
          () => "resolved",
          (err: unknown) => (err as Error).message,
        ),
        new Promise<string>((r) => setTimeout(() => r("NEVER SETTLED"), 1500)),
      ]);
      expect(outcome).toMatch(/hub did not answer/i);
    } finally {
      restore();
    }
  }, 5000);

  test("the default deadline applies with no init at all - undefended is not a choice a call site can make", async () => {
    const { hubFetch, DEFAULT_TIMEOUT_MS } = await import("../client/chrome/request.ts");
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    // And it is really applied: a call with NO init still reaches fetch
    // carrying a live signal. Asserting the constant alone left the
    // `timeoutMs === undefined ? DEFAULT` line deletable with the test green.
    let seen: AbortSignal | null | undefined;
    const real = globalThis.fetch;
    globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.signal;
      return new Response("ok");
    }) as typeof fetch;
    try {
      await hubFetch("/hub/sessions");
    } finally {
      globalThis.fetch = real;
    }
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);
  });

  test("timeoutMs: null is the documented exemption - a human browsing folders is slow on purpose", async () => {
    const { hubFetch } = await import("../client/chrome/request.ts");
    const restore = hangingFetch();
    // The caller's own controller ends it: this test must not leave a promise
    // pending forever, which would hold the whole runner open.
    const ac = new AbortController();
    try {
      let settled = false;
      const p = hubFetch("/hub/project", { timeoutMs: null, signal: ac.signal }).then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await new Promise((r) => setTimeout(r, 400));
      expect(settled).toBe(false);
      ac.abort(new Error("test teardown"));
      await p;
      expect(settled).toBe(true);
    } finally {
      restore();
    }
  }, 3000);

  test("a caller's own signal still aborts - the deadline composes, it does not replace", async () => {
    const { hubFetch } = await import("../client/chrome/request.ts");
    const restore = hangingFetch();
    try {
      const ac = new AbortController();
      const p = hubFetch("/hub/sessions", { signal: ac.signal, timeoutMs: 10_000 }).then(
        () => "resolved",
        (err: unknown) => (err as Error).message,
      );
      ac.abort(new Error("caller changed its mind"));
      const outcome = await Promise.race([
        p,
        new Promise<string>((r) => setTimeout(() => r("NEVER SETTLED"), 1500)),
      ]);
      // The caller's own reason survives - it is not relabelled as unreachable.
      expect(outcome).toBe("caller changed its mind");
    } finally {
      restore();
    }
  }, 3000);
});

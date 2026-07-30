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

const CHROME = join(import.meta.dir, "..", "client", "chrome");
const OWNER = "request.ts";

/** A bare fetch call - not hubFetch(, not loopbackFetch(. */
const BARE_FETCH = /(?<![A-Za-z.])fetch\(/;

const chromeSources = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p);
    }
  };
  walk(CHROME);
  return out;
};

describe("no chrome module calls fetch except the request helper", () => {
  test("every fetch call site lives in request.ts", () => {
    const offenders = chromeSources()
      .filter((p) => !p.endsWith(`/${OWNER}`))
      .filter((p) => BARE_FETCH.test(readFileSync(p, "utf8")));
    expect(offenders).toEqual([]);
  });

  test("the helper exists and stamps the id header", () => {
    const source = readFileSync(join(CHROME, OWNER), "utf8");
    expect(source).toContain("x-lucid-request");
    expect(BARE_FETCH.test(source)).toBe(true);
  });
});

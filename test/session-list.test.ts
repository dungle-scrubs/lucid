import { describe, expect, test } from "bun:test";
import { fuzzyValue, openSplit, recencyBand } from "../client/chrome/list.ts";
import type { HubSession } from "../client/chrome/hub.ts";

/**
 * The unified session list's data rules (plan 03, M4.1): the recency band is
 * ordered by the hub's own lastSeen (D-024), the open/openable split decides
 * what a click DOES, and the fuzzy value folds the project name in so typing
 * "lucid" narrows to that project.
 */

const row = (over: Partial<HubSession> & Pick<HubSession, "artifact" | "project">): HubSession => ({
  name: over.artifact.split("/").pop() ?? over.artifact,
  lastSeen: "2026-01-01T00:00:00.000Z",
  id: over.artifact,
  hosted: false,
  ...over,
});

const a = row({ artifact: "/p/a.html", project: "/p", lastSeen: "2026-01-03T00:00:00.000Z" });
const b = row({ artifact: "/p/b.html", project: "/p", lastSeen: "2026-01-01T00:00:00.000Z" });
const c = row({ artifact: "/q/c.html", project: "/q", lastSeen: "2026-01-02T00:00:00.000Z" });

describe("recencyBand: ordered by hub lastSeen (D-024)", () => {
  test("most recent first, across projects", () => {
    expect(recencyBand([b, a, c]).map((s) => s.artifact)).toEqual([
      "/p/a.html",
      "/q/c.html",
      "/p/b.html",
    ]);
  });

  test("capped at the band size", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      row({ artifact: `/p/${i}.html`, project: "/p", lastSeen: `2026-01-0${i + 1}T00:00:00.000Z` }),
    );
    expect(recencyBand(many, 5)).toHaveLength(5);
  });
});

describe("openSplit: what a click does", () => {
  test("open rows activate; the rest open", () => {
    const { open, openable } = openSplit([a, b, c], ["/q/c.html"]);
    expect(open.map((s) => s.artifact)).toEqual(["/q/c.html"]);
    expect(openable.map((s) => s.artifact)).toEqual(["/p/a.html", "/p/b.html"]);
  });
});

describe("fuzzyValue: the project name is searchable", () => {
  test("folds title, file, project and path in", () => {
    const titled = row({
      artifact: "/dev/lucid/plan.html",
      project: "/dev/lucid",
      title: "Roadmap",
    });
    const v = fuzzyValue(titled);
    expect(v).toContain("Roadmap");
    expect(v).toContain("plan.html");
    expect(v).toContain("lucid"); // typing the project narrows to it
    expect(v).toContain("/dev/lucid/plan.html");
  });
});

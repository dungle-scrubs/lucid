/**
 * What the address bar names, and what it must never narrow.
 *
 * The defect this is for: a record holds several artifacts, the page shows
 * whichever has the most recent version, and nothing about an artifact is in
 * the address, so the rest are unreachable.
 *
 * The trap it guards: an `artifactId` is not a `conversationId`. A
 * conversation id names a directory and is a path-safe alphabet. An artifact
 * id is an index key and is far wider. Validating one with the other would
 * hide artifacts the record already holds - which is the defect, not the fix.
 */
import { describe, expect, test } from "bun:test";
import { formatRoute, parseRoute, type Route, sameRoute } from "../../src/server/client/route.js";
import { validConversationId } from "../../src/store/errors.js";
import { validArtifactId } from "../../src/store/log.js";

describe("reading a path", () => {
  test("a conversation on its own", () => {
    expect(parseRoute("/c/demo")).toEqual({ conversationId: "demo" });
  });

  test("a conversation and an artifact", () => {
    expect(parseRoute("/c/demo/checklist")).toEqual({
      conversationId: "demo",
      artifactId: "checklist",
    });
  });

  test("a conversation, an artifact and a version", () => {
    expect(parseRoute("/c/demo/checklist/7")).toEqual({
      conversationId: "demo",
      artifactId: "checklist",
      version: 7,
    });
  });

  test("a trailing slash changes nothing", () => {
    expect(parseRoute("/c/demo/")).toEqual({ conversationId: "demo" });
    expect(parseRoute("/c/demo/checklist/")).toEqual({
      conversationId: "demo",
      artifactId: "checklist",
    });
  });

  test("a path that is not a conversation is not a route", () => {
    expect(parseRoute("/")).toBe(null);
    expect(parseRoute("/api/conversations/demo")).toBe(null);
    expect(parseRoute("/c")).toBe(null);
  });
});

describe("what a bad version does", () => {
  test("a version that is not a number leaves the artifact reachable", () => {
    // Falling back to the artifact is the point: a mistyped version should
    // not cost you the document.
    expect(parseRoute("/c/demo/checklist/latest")).toEqual({
      conversationId: "demo",
      artifactId: "checklist",
    });
  });

  test("zero and negative are not versions", () => {
    expect(parseRoute("/c/demo/checklist/0")?.version).toBeUndefined();
    expect(parseRoute("/c/demo/checklist/-3")?.version).toBeUndefined();
  });

  test("trailing junk is not a version", () => {
    // parseInt alone would read "7abc" as 7 and silently show version seven.
    expect(parseRoute("/c/demo/checklist/7abc")?.version).toBeUndefined();
  });
});

describe("the artifact id is not narrowed", () => {
  const wide = "plan/日本語";

  test("an id the store accepts survives a round trip", () => {
    // The exact case that proves the rule: the fold indexes this and
    // validConversationId rejects it.
    expect(validArtifactId(wide)).toBe(true);
    expect(validConversationId(wide)).toBe(false);

    const path = formatRoute({ conversationId: "demo", artifactId: wide });
    expect(parseRoute(path)).toEqual({ conversationId: "demo", artifactId: wide });
  });

  test("a slash in an id does not become a path segment", () => {
    // Encoded, so the id stays one segment however many slashes it holds.
    const path = formatRoute({ conversationId: "demo", artifactId: wide });
    expect(path.split("/").length).toBe(4);
  });

  test("an id that would traverse is carried as an id, not a path", () => {
    const path = formatRoute({ conversationId: "demo", artifactId: "../../etc/passwd" });
    expect(path).not.toContain("../");
    expect(parseRoute(path)?.artifactId).toBe("../../etc/passwd");
    // It round-trips because it is a lookup key. Nothing joins it to a path,
    // and the store's own rule is what decides whether it names anything.
  });

  test("a malformed escape is not an artifact", () => {
    expect(parseRoute("/c/demo/%E0%A4%A")).toEqual({ conversationId: "demo" });
  });
});

describe("writing a path", () => {
  const cases: Route[] = [
    { conversationId: "demo" },
    { conversationId: "demo", artifactId: "checklist" },
    { conversationId: "demo", artifactId: "checklist", version: 12 },
    { conversationId: "a b", artifactId: "plan/日本語", version: 1 },
  ];

  test("every route it writes, it reads back", () => {
    for (const route of cases) {
      expect(parseRoute(formatRoute(route))).toEqual(route);
    }
  });

  test("a version without an artifact cannot be written", () => {
    // There is nothing for the version to be a version of.
    expect(formatRoute({ conversationId: "demo", version: 4 } as Route)).toBe("/c/demo");
  });
});

describe("knowing when not to touch the address bar", () => {
  test("the same route is the same route", () => {
    expect(
      sameRoute({ conversationId: "d", artifactId: "a" }, { conversationId: "d", artifactId: "a" }),
    ).toBe(true);
  });

  test("a different version is a different route", () => {
    expect(
      sameRoute(
        { conversationId: "d", artifactId: "a", version: 1 },
        { conversationId: "d", artifactId: "a", version: 2 },
      ),
    ).toBe(false);
  });

  test("naming a version is not the same as following the newest", () => {
    // Pinning v9 when v9 is current still differs from following: one keeps
    // showing v9 as the agent writes v10, the other moves.
    expect(
      sameRoute(
        { conversationId: "d", artifactId: "a" },
        { conversationId: "d", artifactId: "a", version: 9 },
      ),
    ).toBe(false);
  });
});

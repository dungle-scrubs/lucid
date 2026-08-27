/**
 * The rule that decides whether the version on screen is read-only.
 *
 * Its own test because the page had one boolean for two situations, and the
 * cost was a live edit whose save button went dead when the agent wrote a
 * version. The server's superseded-save path (`basedOn`, `supersededSince`)
 * was already built and already covered by `artifacts.test.ts`; what was
 * missing was any way to reach it.
 */
import { describe, expect, test } from "bun:test";
import { isReadOnly, versionState } from "../../src/server/client/version-state.js";

describe("which version is on screen", () => {
  test("the newest version is current, pinned to it or following it", () => {
    expect(versionState({ shown: 7, latest: 7, pinned: null })).toBe("current");
    // Pinning the newest is still the newest. Choosing the current version
    // is choosing to follow it, not to freeze there.
    expect(versionState({ shown: 7, latest: 7, pinned: 7 })).toBe("current");
  });

  test("a version chosen from the picker is pinned-old", () => {
    expect(versionState({ shown: 3, latest: 7, pinned: 3 })).toBe("pinned-old");
  });

  test("standing still while the newest moves is overtaken, not pinned-old", () => {
    // Nothing was chosen: `pinned` is null because the page was following
    // the newest. It stayed on 7 because there was work in progress.
    expect(versionState({ shown: 7, latest: 8, pinned: null })).toBe("overtaken");
  });

  test("with nothing to compare against, it is current", () => {
    // A document whose catalog has not arrived is not an old version, and
    // locking it as one takes the affordances away for the first paint.
    expect(versionState({ shown: 4, latest: null, pinned: null })).toBe("current");
    expect(versionState({ shown: null, latest: 9, pinned: null })).toBe("current");
    expect(versionState({ shown: null, latest: null, pinned: null })).toBe("current");
  });
});

describe("what is read-only", () => {
  test("only a deliberately chosen older version", () => {
    expect(isReadOnly("pinned-old")).toBe(true);
  });

  test("being overtaken is not read-only — this is the defect", () => {
    // The whole point. An edit in progress stays saveable when the agent
    // writes a version underneath it; the save lands on top and records
    // what it was based on.
    expect(isReadOnly("overtaken")).toBe(false);
  });

  test("the newest version is not read-only", () => {
    expect(isReadOnly("current")).toBe(false);
  });

  test("read-only is not the same as not-newest", () => {
    // Spelling it `state !== "current"` is the original bug written again,
    // so it is asserted against directly.
    const notNewest: readonly ("pinned-old" | "overtaken")[] = ["pinned-old", "overtaken"];
    expect(notNewest.filter(isReadOnly)).toEqual(["pinned-old"]);
  });
});

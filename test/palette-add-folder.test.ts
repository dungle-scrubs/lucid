import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addFolderStatus } from "../client/chrome/Palette.tsx";

/**
 * What the palette's "Add a project folder…" row SAYS about each outcome.
 *
 * The row used to answer a chooser-less platform by blanking the active tab
 * and landing on the pick screen, "whose AddFolder carries the typed-path
 * fallback" - a component PR #88 stopped mounting anywhere. So the one failure
 * the row handled threw the human's session view away and put nothing in its
 * place, and every other failure was dropped in silence. The palette is where
 * the control lives now, so it is where the outcome has to be said.
 */

describe("addFolderStatus: the row states its outcome", () => {
  test("a platform with no chooser says so, instead of navigating nowhere", () => {
    expect(addFolderStatus({ needsPath: true })).toBe(
      "This build has no folder chooser on this platform.",
    );
  });

  test("a hub refusal is repeated in the hub's own words", () => {
    expect(addFolderStatus({ error: "no such directory" })).toBe("no such directory");
  });

  test("a folder holding nothing says why it holds nothing", () => {
    const said = addFolderStatus({ added: { root: "/dev/quiet", roots: [], found: 0 } });
    expect(said).toContain("quiet");
    expect(said).toContain("scratchpad");
  });

  test("a folder holding reviews reports how many, counted in its own number", () => {
    expect(addFolderStatus({ added: { root: "/dev/lucid", roots: [], found: 1 } })).toBe(
      "Found 1 review in lucid.",
    );
    expect(addFolderStatus({ added: { root: "/dev/lucid", roots: [], found: 4 } })).toBe(
      "Found 4 reviews in lucid.",
    );
  });

  test("backing out of the chooser is not an outcome to report", () => {
    expect(addFolderStatus({ cancelled: true })).toBeNull();
  });
});

/**
 * A component nothing mounts still typechecks, still lints, and still carries
 * `data-test` hooks - so the locator drift check saw a live surface and the
 * three factories aiming at it looked used. Deleting the file is what makes
 * both truths visible again.
 */
describe("the unmounted AddFolder component is deleted", () => {
  const chrome = join(import.meta.dir, "..", "client", "chrome");

  test("no client module renders or imports it", () => {
    expect(existsSync(join(chrome, "AddFolder.tsx"))).toBe(false);
    const mentions = readdirSync(chrome)
      .filter((f) => /\.tsx?$/.test(f))
      .filter((f) => readFileSync(join(chrome, f), "utf8").includes("AddFolder"));
    expect(mentions).toEqual([]);
  });
});

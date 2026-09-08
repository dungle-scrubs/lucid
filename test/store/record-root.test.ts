/**
 * Where records live when nobody says.
 *
 * `~/.lucid` is v1's live state directory — its hub log, its registry, its
 * roots — and v1 is still in use. v2 defaulting there put a `records/`
 * subdirectory inside a running program's own directory.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join, sep } from "node:path";
import { conversations } from "../../src/cli/record-addressing.js";

const KEY = "LUCID_ROOT";
let previous: string | undefined;

beforeEach(() => {
  previous = process.env[KEY];
});

afterEach(() => {
  if (previous === undefined) delete process.env[KEY];
  else process.env[KEY] = previous;
});

describe("the default record root", () => {
  test("is under ~/.lucid2, not inside v1's directory", () => {
    delete process.env[KEY];
    const home = process.env.HOME ?? "";
    const root = conversations().rootDir;
    expect(root).toBe(join(home, ".lucid2", "records"));
    // Compared as a path segment, not a string prefix: `.lucid2` starts
    // with `.lucid`, so a prefix test passes while pointing at the wrong
    // directory — or fails while pointing at the right one.
    expect(root.split(sep)).toContain(".lucid2");
    expect(root.split(sep)).not.toContain(".lucid");
  });

  test("LUCID_ROOT still wins", () => {
    process.env[KEY] = "/tmp/somewhere-else";
    expect(conversations().rootDir).toBe("/tmp/somewhere-else");
  });

  test("an explicit rootDir wins over both", () => {
    process.env[KEY] = "/tmp/somewhere-else";
    expect(conversations("/tmp/explicit").rootDir).toBe("/tmp/explicit");
  });
});

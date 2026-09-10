/** Where records live when nobody specifies a root. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
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
  test("is under ~/.lucid/records", () => {
    delete process.env[KEY];
    const home = process.env.HOME ?? "";
    const root = conversations().rootDir;
    expect(root).toBe(join(home, ".lucid", "records"));
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

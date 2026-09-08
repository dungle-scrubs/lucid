import { expect, test } from "bun:test";
import { mapSubcommand } from "../../src/cli/mapping.js";

test("asking for server help or passing an unsupported argument never starts a server", () => {
  for (const argument of ["--help", "-h", "--port", "some-record"])
    expect(mapSubcommand(["serve", argument])).toMatchObject({
      kind: "help",
      message: expect.stringContaining("lucid2 serve"),
    });
  expect(mapSubcommand(["serve"])).toEqual({ kind: "serve" });
});

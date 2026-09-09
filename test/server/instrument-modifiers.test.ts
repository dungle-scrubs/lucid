import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { instrumentArtifact } from "../../src/server/client/instrument.js";

test("held annotation preserves spots, supports additive selection, and respects read-only", () => {
  const result = spawnSync(
    "node",
    [new URL("../helpers/instrument-modifiers.mjs", import.meta.url).pathname],
    {
      encoding: "utf8",
      input: instrumentArtifact(
        '<body><p id="first">First passage</p><p id="second">Second passage</p></body>',
        "d",
        1,
      ),
    },
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

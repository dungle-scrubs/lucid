import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { instrumentArtifact } from "../../src/server/client/instrument.js";

const document = instrumentArtifact(
  '<body><p id="prose">Read <a id="link" href="#destination"><span id="label">the details</span></a>.</p><a id="placeholder">No destination</a><button id="control">Run</button><h2 id="destination">Details</h2></body>',
  "links",
  1,
);

describe("links remain links while annotating", () => {
  test.each(["link", "label", "hover", "selection", "controls"])("%s", (scenario) => {
    // jsdom's script VM requires Node. Bun rejects the Window proxy as a
    // global prototype, so run this DOM oracle in its supported runtime.
    const result = spawnSync(
      "node",
      [new URL("../helpers/instrument-links.mjs", import.meta.url).pathname, scenario],
      { encoding: "utf8", input: document },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});

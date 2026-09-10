import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHcnRunner } from "../../src/harness/hcn-runner.js";
import { nodeHarnessDeps, prepareNodeHarness } from "../../src/harness/node-deps.js";
import { FakeHcnProcess, fakeSpawner } from "./fakes.js";

test.each(["0.0.1", "999.0.0", "unparseable"])(
  "startup never invokes HCN to inspect its version: %s",
  async (version) => {
    const root = mkdtempSync(join(tmpdir(), "lucid-version-authority-"));
    const bin = join(root, "hcn");
    const marker = join(root, "called");
    writeFileSync(bin, `#!/bin/sh\ntouch '${marker}'\nprintf '${version}\\n'\n`, {
      mode: 0o700,
    });
    try {
      expect(nodeHarnessDeps(undefined, { env: bin }).bin).toBe(bin);
      const startup = await prepareNodeHarness({ env: bin });
      expect(startup.deps?.bin).toBe(bin);
      expect(startup.diagnostics).toEqual([]);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("HCN can supply available accounting without matching version metadata", async () => {
  const child = new FakeHcnProcess();
  const runner = createHcnRunner({ bin: "/hcn", spawn: fakeSpawner([child]).spawn });
  const pending = runner.countContext({
    harness: "claude",
    model: "selected",
    profile: "headless-turn",
    prompt: "request",
  });
  child.emit({
    v: 1,
    harness: "claude",
    mode: "headless-turn",
    executable: { path: "/selected/claude", version: "newer" },
    verifiedAgainst: "older",
    accounting: {
      status: "available",
      method: "native-context-estimate",
      model: "selected",
      inputLimitTokens: 900,
      contextWindowTokens: 1000,
      totalTokens: 100,
    },
  });
  child.exit(0);
  expect(await pending).toMatchObject({ status: "available", totalTokens: 100 });
});

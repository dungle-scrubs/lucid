import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { DURABLE_ROOT } from "./e2e/durable-path.ts";
import { defaultRoots } from "../src/core/registry.ts";
import { isVolatilePath } from "../src/core/scratchpad.ts";

describe("the durable e2e root", () => {
  test("is outside defaultRoots(), so fixtures never enter the human's listing", () => {
    // A fixture inside ~/dev or an agent scratchpad bucket would show up in
    // the developer's own hub, and a suite that plants sessions in someone's
    // real workspace is a suite that gets turned off.
    for (const root of defaultRoots()) {
      expect(
        DURABLE_ROOT === root || DURABLE_ROOT.startsWith(`${root}/`),
        `${DURABLE_ROOT} is inside the scanned root ${root}`,
      ).toBe(false);
    }
  });

  test("is not volatile, so `open` will not refuse it", () => {
    // The whole point of the fixture: these scenarios measure the refusal,
    // so the fixture itself must be on the accepted side of it - and without
    // LUCID_ALLOW_TEMP, which would mask the behaviour under test.
    const before = process.env.LUCID_ALLOW_TEMP;
    process.env.LUCID_ALLOW_TEMP = undefined as unknown as string;
    delete process.env.LUCID_ALLOW_TEMP;
    try {
      expect(isVolatilePath(`${DURABLE_ROOT}/run-abc/plan.html`)).toBe(false);
    } finally {
      if (before !== undefined) process.env.LUCID_ALLOW_TEMP = before;
    }
  });

  test("lives under the home directory, where globalTeardown sweeps it", () => {
    expect(DURABLE_ROOT.startsWith(`${homedir()}/`)).toBe(true);
  });
});

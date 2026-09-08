import { expect, test } from "bun:test";
import { hcnDiagnostic, unknownInstallation } from "../../src/harness/compatibility.js";
import { executionViews } from "../../src/protocol/execution-view.js";
import type { ChannelState } from "../../src/protocol/reducer.js";

test("historical compatibility holds do not project raw process text and new holds retain safe facts", () => {
  const diagnostic = hcnDiagnostic(
    { ...unknownInstallation, detected: "0.6.4", path: "/selected/hcn" },
    "execution-check",
  );
  const state = {
    executions: {
      old: {
        kind: "held",
        attempt: 0,
        actions: {},
        authorization: "requested",
        hold: {
          code: "E-HUB-03",
          actions: ["retry"],
          prerequisite: "settings",
          reason: "synthetic-private-stderr\u001b[31m",
        },
      },
      current: {
        kind: "held",
        attempt: 0,
        actions: {},
        authorization: "requested",
        hold: {
          code: "E-HUB-03",
          actions: ["retry"],
          prerequisite: "settings",
          reason: "unused raw reason",
          compatibility: diagnostic,
        },
      },
    },
  } as unknown as ChannelState;
  const before = JSON.stringify(state);
  const views = executionViews(state, false);
  expect(views[0]?.reason).not.toContain("synthetic-private-stderr");
  expect(views[0]?.code).toBe("E-HUB-03");
  expect(views[0]?.actions).toEqual(["retry"]);
  expect(views[1]?.reason).toContain("0.6.4");
  expect(views[1]?.reason).toContain("/selected/hcn");
  expect(JSON.stringify(state)).toBe(before);
});

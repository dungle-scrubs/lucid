import { expect, test } from "bun:test";
import { installationProblem, unknownInstallation } from "../../src/harness/compatibility.js";
import { parseCompatibilityDiagnostic } from "../../src/protocol/compatibility.js";
import { executionViews } from "../../src/protocol/execution-view.js";
import type { ChannelState } from "../../src/protocol/reducer.js";

test("historical compatibility holds do not project raw process text and new holds retain safe facts", () => {
  const diagnostic = installationProblem(
    { ...unknownInstallation, path: "/selected/hcn" },
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
  expect(views[1]?.reason).toContain("HCN is unavailable");
  expect(views[1]?.reason).not.toMatch(/pins|minimum|update/i);
  expect(JSON.stringify(state)).toBe(before);
});

test.each(["hcn-version-too-old", "hcn-version-drift", "harness-version-unverified"])(
  "historical %s diagnostics cannot restore version policy during replay",
  (code) => {
    // Synthetic legacy diagnostic, composed inline rather than changing a recording.
    const legacy = {
      ...installationProblem(),
      code,
      v: undefined,
      message: "Installed version is below the minimum",
      remedy: "Update HCN and Lucid",
    };
    expect(parseCompatibilityDiagnostic(legacy)).toBeUndefined();
    const state = {
      executions: {
        held: {
          kind: "held",
          attempt: 0,
          actions: {},
          authorization: "requested",
          hold: {
            code: "E-HUB-03",
            actions: ["retry"],
            prerequisite: "settings",
            reason: legacy.message,
            compatibility: legacy,
          },
        },
        failed: {
          kind: "attempt-ended",
          attempt: 1,
          actions: {},
          outcome: {
            kind: "pre-start-failed",
            failure: { code: "E-HUB-05", reason: legacy.message, evidence: "pre-start" },
          },
        },
      },
    } as unknown as ChannelState;
    const before = JSON.stringify(state);
    const views = executionViews(state, false);
    expect(views).toHaveLength(2);
    for (const view of views) expect(view.reason).not.toMatch(/version|minimum|update/i);
    expect(views[0]?.actions).toEqual(["retry"]);
    expect(JSON.stringify(state)).toBe(before);
  },
);

import { expect, test } from "bun:test";
import { installationProblem, selectionProblem } from "../../src/harness/compatibility.js";
import { parseCompatibilityDiagnostic } from "../../src/protocol/compatibility.js";

test("operation diagnostics retain safe resolution details without package advice", () => {
  const diagnostic = installationProblem({
    lookupRoot: null,
    path: "/selected/hcn",
    source: "env",
  });
  expect(parseCompatibilityDiagnostic(diagnostic)).toEqual(diagnostic);
  expect(diagnostic.hcn).toEqual({ lookupRoot: null, path: "/selected/hcn", source: "env" });
  expect(JSON.stringify(diagnostic)).not.toMatch(/version|pins|minimum|upgrade|update/i);
});

test("an HCN refusal retains its issue while bounding and cleaning text", () => {
  const diagnostic = selectionProblem(
    { harness: "claude", model: "selected" },
    undefined,
    "selection-unsupported",
    "\u001b[31mHCN refused this selection (unsupported-option)",
  );
  expect(diagnostic.message).toContain("unsupported-option");
  expect(diagnostic.message).not.toContain("\u001b");
  expect(diagnostic.remedy).not.toMatch(/update|upgrade|downgrade|version/);
  expect(parseCompatibilityDiagnostic({ ...diagnostic, v: undefined })).toBeUndefined();
});

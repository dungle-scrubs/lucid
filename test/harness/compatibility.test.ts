import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HCN_PIN, hcnDiagnostic } from "../../src/harness/compatibility.js";
import { nodeHarnessDeps } from "../../src/harness/node-deps.js";
import { HarnessVersionError } from "../../src/harness/runner.js";

test("an admitted HCN drift warns about the selected installation without refusing the driver", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-compatibility-"));
  const bin = join(root, "hcn");
  writeFileSync(bin, "#!/bin/sh\nprintf '0.6.6\\n'\n", { mode: 0o700 });
  const messages: string[] = [];
  try {
    const deps = nodeHarnessDeps(undefined, { env: bin }, (message) => messages.push(message));
    expect(deps.bin).toBe(bin);
    expect(deps.installation).toMatchObject({
      detected: "0.6.6",
      pin: "0.6.5",
      source: "env",
      path: bin,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("0.6.6");
    expect(messages[0]).toContain("pins 0.6.5");
    expect(messages[0]).toContain("LUCID_HCN");
    expect(messages[0]).toContain(bin);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("initialization refusals retain the selected installation and safe repair details", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-old-hcn-"));
  const bin = join(root, "hcn");
  writeFileSync(bin, "#!/bin/sh\nprintf '0.6.3\\n'\n", { mode: 0o700 });
  try {
    let failure: unknown;
    try {
      nodeHarnessDeps(undefined, { env: bin });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(HarnessVersionError);
    expect(failure).toMatchObject({
      diagnostic: {
        code: "hcn-version-too-old",
        hcn: { source: "env", path: bin, detected: "0.6.3" },
      },
    });
    expect((failure as Error).message).toContain("Restart");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pin identity preserves prerelease and build distinctions without changing the floor", () => {
  const installation = {
    detected: "v0.6.5",
    lookupRoot: null,
    minimum: "0.6.5",
    path: "/selected/hcn",
    pin: HCN_PIN,
    source: "env",
  };
  expect(hcnDiagnostic(installation)).toBeNull();
  expect(hcnDiagnostic({ ...installation, detected: " 0.6.5 \n" })).toBeNull();
  for (const version of ["0.6.5-rc.1", "0.6.5+build.12"]) {
    expect(hcnDiagnostic({ ...installation, detected: version })).toMatchObject({
      code: "hcn-version-drift",
      severity: "warning",
    });
  }
  expect(hcnDiagnostic({ ...installation, detected: "0.6.5 (build 12)" })).toMatchObject({
    code: "inspection-unavailable",
    severity: "warning",
    hcn: { detected: null },
  });
  expect(hcnDiagnostic({ ...installation, detected: "0.6.3" })).toMatchObject({
    code: "hcn-version-too-old",
    severity: "error",
  });
});

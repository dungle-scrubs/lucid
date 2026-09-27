import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyPiResume,
  isAgentEventKind,
  isNativeExit3,
  piNativeTurn,
  preparePiVerification,
} from "../../src/harness/pi-verification.js";

const LAUNCH = "5f0c7a3e-1b2d-4c8e-9f10-2a3b4c5d6e7f";
const SESSION = "01a0e08c-06b0-71d0-8bfd-8304dfbd84b3";

const prepare = () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-pi-ver-"));
  const recordDir = join(root, "record");
  return preparePiVerification({
    root,
    recordDir,
    launchId: LAUNCH,
    sessionId: SESSION,
    workingDirectory: "/work",
  });
};
const attest = (v: ReturnType<typeof prepare>, fields: Record<string, unknown>) =>
  writeFileSync(
    v.attestationPath,
    JSON.stringify({
      v: 1,
      attempt: v.attempt,
      nonce: v.nonce,
      expected: v.expectedSession,
      opened: v.expectedSession,
      ...fields,
    }),
  );
const run = { completed: true, agentEvents: true, nativeExit3: false };
const refusedRun = { completed: false, agentEvents: false, nativeExit3: true };

test("preparation writes the extension and a private per-attempt attestation path", () => {
  const v = prepare();
  expect(readFileSync(v.extensionPath, "utf8")).toContain("export default");
  expect(v.attestationPath.endsWith(`.pi-attestation/${LAUNCH}.json`)).toBe(true);
  expect(statSync(join(v.attestationPath, "..")).mode & 0o777).toBe(0o700);
  expect(v.nonce).toMatch(/^[0-9a-f]{64}$/);
  expect(prepare().nonce).not.toBe(v.nonce);
});

test("a launch ID that is not a UUID refuses preparation", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-pi-ver-"));
  expect(() =>
    preparePiVerification({
      root,
      recordDir: root,
      launchId: "../escape",
      sessionId: SESSION,
      workingDirectory: "/work",
    }),
  ).toThrow("not a UUID");
});

test("the native turn carries the attempt in env and the extension after --", () => {
  const v = prepare();
  expect(piNativeTurn(v)).toEqual({
    env: {
      LUCID_PI_ATTEMPT: `${LAUNCH}.${v.nonce}`,
      LUCID_PI_EXPECTED_SESSION: SESSION,
      LUCID_PI_EXPECTED_CWD: "/work",
      LUCID_PI_ATTESTATION: v.attestationPath,
    },
    args: ["-e", v.extensionPath],
  });
});

test("row 1: a verified attestation, a completed turn, and agent events are a continuation", () => {
  const v = prepare();
  attest(v, { outcome: "verified" });
  expect(classifyPiResume(v, run)).toEqual({ kind: "verified" });
});

test("a verified attestation without agent events is uncertain", () => {
  const v = prepare();
  attest(v, { outcome: "verified" });
  expect(classifyPiResume(v, { ...run, agentEvents: false }).kind).toBe("uncertain");
});

test("row 2: a refused attestation, exit 3, and no agent events are a proven refusal", () => {
  const v = prepare();
  attest(v, { outcome: "refused", reason: "session-empty" });
  expect(classifyPiResume(v, refusedRun)).toEqual({ kind: "refused", reason: "session-empty" });
});

test("a refusal with agent events is uncertain: the model may have run", () => {
  const v = prepare();
  attest(v, { outcome: "refused", reason: "session-empty" });
  expect(classifyPiResume(v, { ...refusedRun, agentEvents: true }).kind).toBe("uncertain");
});

test("a refusal without exit 3 is uncertain", () => {
  const v = prepare();
  attest(v, { outcome: "refused", reason: "folder-mismatch" });
  expect(classifyPiResume(v, { ...refusedRun, nativeExit3: false }).kind).toBe("uncertain");
});

test.each([
  ["a missing file", null],
  ["another nonce", { outcome: "verified", nonce: "b".repeat(64) }],
  ["another attempt", { outcome: "verified", attempt: "00000000-0000-4000-8000-000000000000" }],
  ["another session", { outcome: "verified", expected: "other" }],
  ["an unknown reason", { outcome: "refused", reason: "made-up" }],
  ["a verified record with a reason", { outcome: "verified", reason: "session-empty" }],
  ["another version", { outcome: "verified", v: 2 }],
])("%s never proves an outcome", (_label, fields) => {
  const v = prepare();
  if (fields !== null) attest(v, fields);
  expect(classifyPiResume(v, run).kind).toBe("uncertain");
  expect(classifyPiResume(v, refusedRun).kind).toBe("uncertain");
});

test("control kinds are not agent events; every other kind is, including unknown ones", () => {
  for (const kind of ["identity", "progress", "error", "failure", "done"])
    expect(isAgentEventKind(kind)).toBe(false);
  for (const kind of ["token", "message", "tool", "context", "limit", "future-kind"])
    expect(isAgentEventKind(kind)).toBe(true);
});

test("only a native failure with exit code 3 counts as the extension's exit", () => {
  expect(isNativeExit3({ kind: "failure", class: "native", nativeExitCode: 3 })).toBe(true);
  expect(isNativeExit3({ kind: "failure", class: "native", nativeExitCode: 1 })).toBe(false);
  expect(isNativeExit3({ kind: "failure", class: "transport", nativeExitCode: 3 })).toBe(false);
  expect(isNativeExit3({ kind: "done", class: "native", nativeExitCode: 3 })).toBe(false);
});

import { afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  materializePiExtension,
  type PiExtensionApi,
  piExtensionSource,
} from "../../src/harness/pi-extension.js";

// The extension runs from the file Lucid writes, not from the module: these
// tests import that file, so they prove the serialized text is self-contained.
let extension: (pi: PiExtensionApi) => void;
const root = mkdtempSync(join(tmpdir(), "lucid-pi-ext-"));
beforeAll(async () => {
  const path = materializePiExtension(root);
  extension = (await import(pathToFileURL(path).href)).default;
});
afterEach(() => {
  process.exitCode = 0;
});

const SESSION = "01a0e08c-06b0-71d0-8bfd-8304dfbd84b3";
const ATTEMPT = "5f0c7a3e-1b2d-4c8e-9f10-2a3b4c5d6e7f";
const NONCE = "a".repeat(64);

type Handler = (event: unknown, ctx: unknown) => unknown;
const load = (env: Record<string, string>) => {
  Object.assign(process.env, env);
  const handlers = new Map<string, Handler>();
  extension({ on: (event: string, handler: Handler) => handlers.set(event, handler) } as never);
  return handlers;
};
const context = (opts: {
  mode?: string;
  id?: string;
  headerId?: string;
  cwd: string;
  headerCwd?: string;
  entries?: readonly { type: string }[];
}) => ({
  cwd: opts.cwd,
  mode: opts.mode ?? "json",
  sessionManager: {
    getSessionId: () => opts.id ?? SESSION,
    getHeader: () => ({ id: opts.headerId ?? opts.id ?? SESSION, cwd: opts.headerCwd ?? opts.cwd }),
    getEntries: () => opts.entries ?? [{ type: "model_change" }, { type: "message" }],
  },
});
const headless = (folder: string) => {
  const attestation = join(mkdtempSync(join(tmpdir(), "lucid-pi-att-")), `${ATTEMPT}.json`);
  const handlers = load({
    LUCID_PI_ATTEMPT: `${ATTEMPT}.${NONCE}`,
    LUCID_PI_EXPECTED_SESSION: SESSION,
    LUCID_PI_EXPECTED_CWD: folder,
    LUCID_PI_ATTESTATION: attestation,
  });
  const read = () => JSON.parse(readFileSync(attestation, "utf8"));
  return { handlers, attestation, read };
};

test("the written file is reused when its text is unchanged and replaced when it differs", () => {
  const first = materializePiExtension(root);
  expect(materializePiExtension(root)).toBe(first);
  writeFileSync(first, "tampered");
  expect(materializePiExtension(root)).toBe(first);
  expect(readFileSync(first, "utf8")).toBe(piExtensionSource());
});

test("the extension removes its variables before any tool can read them", () => {
  const folder = mkdtempSync(join(tmpdir(), "lucid-pi-cwd-"));
  headless(folder);
  for (const name of [
    "LUCID_PI_ATTEMPT",
    "LUCID_PI_EXPECTED_SESSION",
    "LUCID_PI_EXPECTED_CWD",
    "LUCID_PI_ATTESTATION",
  ])
    expect(process.env[name]).toBeUndefined();
});

test("the expected session and folder with messages is verified and the prompt continues", () => {
  const folder = mkdtempSync(join(tmpdir(), "lucid-pi-cwd-"));
  const { handlers, read } = headless(folder);
  handlers.get("session_start")?.({}, context({ cwd: folder }));
  expect(read()).toEqual({
    v: 1,
    attempt: ATTEMPT,
    nonce: NONCE,
    outcome: "verified",
    expected: SESSION,
    opened: SESSION,
  });
  expect(handlers.get("input")?.({}, {})).toEqual({ action: "continue" });
  expect(process.exitCode).toBe(0);
});

test.each([
  ["session-id-mismatch", { id: "01a0e08c-0000-7000-8000-000000000000" }],
  ["session-id-mismatch", { headerId: "01a0e08c-0000-7000-8000-000000000000" }],
  ["folder-mismatch", { cwd: "/elsewhere" }],
  ["folder-mismatch", { headerCwd: "/elsewhere" }],
  ["session-empty", { entries: [{ type: "model_change" }, { type: "thinking_level_change" }] }],
])("a %s refuses, writes the reason, exits 3, and drops the prompt", (reason, opts) => {
  const folder = mkdtempSync(join(tmpdir(), "lucid-pi-cwd-"));
  const { handlers, read } = headless(folder);
  handlers.get("session_start")?.({}, context({ cwd: folder, ...opts }));
  expect(read()).toMatchObject({ outcome: "refused", reason, attempt: ATTEMPT, nonce: NONCE });
  expect(handlers.get("input")?.({}, {})).toEqual({ action: "handled" });
  expect(process.exitCode).toBe(3);
});

test("a folder reached through a symlink matches by real path", () => {
  const real = realpathSync(mkdtempSync(join(tmpdir(), "lucid-pi-real-")));
  const link = join(mkdtempSync(join(tmpdir(), "lucid-pi-link-")), "work");
  symlinkSync(real, link);
  const { handlers, read } = headless(link);
  handlers.get("session_start")?.({}, context({ cwd: real }));
  expect(read().outcome).toBe("verified");
});

test("a throwing session manager refuses as verification-failed", () => {
  const folder = mkdtempSync(join(tmpdir(), "lucid-pi-cwd-"));
  const { handlers, read } = headless(folder);
  const broken = {
    ...context({ cwd: folder }),
    sessionManager: {
      getSessionId: () => {
        throw new Error("boom");
      },
    },
  };
  handlers.get("session_start")?.({}, broken);
  expect(read()).toMatchObject({ outcome: "refused", reason: "verification-failed" });
  expect(handlers.get("input")?.({}, {})).toEqual({ action: "handled" });
});

test("the prompt is dropped when session_start never ran", () => {
  const folder = mkdtempSync(join(tmpdir(), "lucid-pi-cwd-"));
  const { handlers } = headless(folder);
  expect(handlers.get("input")?.({}, {})).toEqual({ action: "handled" });
});

test("an existing attestation file is never overwritten, and the prompt is dropped", () => {
  const folder = mkdtempSync(join(tmpdir(), "lucid-pi-cwd-"));
  const { handlers, attestation } = headless(folder);
  writeFileSync(attestation, "earlier");
  handlers.get("session_start")?.({}, context({ cwd: folder }));
  expect(readFileSync(attestation, "utf8")).toBe("earlier");
  expect(handlers.get("input")?.({}, {})).toEqual({ action: "handled" });
  expect(process.exitCode).toBe(3);
});

test("an unparsable attempt writes no file and drops the prompt", () => {
  const folder = mkdtempSync(join(tmpdir(), "lucid-pi-cwd-"));
  const dir = mkdtempSync(join(tmpdir(), "lucid-pi-att-"));
  const handlers = load({
    LUCID_PI_ATTEMPT: "not-an-attempt",
    LUCID_PI_EXPECTED_SESSION: SESSION,
    LUCID_PI_EXPECTED_CWD: folder,
    LUCID_PI_ATTESTATION: join(dir, "x.json"),
  });
  handlers.get("session_start")?.({}, context({ cwd: folder }));
  expect(() => readFileSync(join(dir, "x.json"))).toThrow();
  expect(handlers.get("input")?.({}, {})).toEqual({ action: "handled" });
  expect(process.exitCode).toBe(3);
});

test("rpc and tui runs take no headless role, even with the variables set", () => {
  const folder = mkdtempSync(join(tmpdir(), "lucid-pi-cwd-"));
  for (const mode of ["rpc", "tui"]) {
    const { handlers, attestation } = headless(folder);
    handlers.get("session_start")?.({}, context({ cwd: folder, mode }));
    expect(() => readFileSync(attestation)).toThrow();
    expect(handlers.get("input")?.({}, {})).toBeUndefined();
    expect(process.exitCode).toBe(0);
  }
});

test("without LUCID_PI_ATTEMPT the extension registers nothing", () => {
  expect(load({}).size).toBe(0);
});

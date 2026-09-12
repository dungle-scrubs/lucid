import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeCommandAuthority } from "../../src/cli/native-context.js";
import { readProcessOwner } from "../../src/process-owner.js";
import {
  registerNativeSession,
  withNativeRegistration,
} from "../../src/store/native-registration.js";

test("a Codex parent tool command resolves only its verified native session", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-command-context-"));
  try {
    const owner = readProcessOwner(process.pid);
    if (!owner) throw new Error("Test process identity unavailable");
    const registered = registerNativeSession(
      root,
      {
        harness: "codex",
        interface: "codex-cli",
        nativeSessionId: "native-parent",
        owner,
        workingDirectory: root,
      },
      { callerOwns: () => true, ownerPresence: () => true },
    );
    expect(registered.ok).toBe(true);
    const authority = nativeCommandAuthority({
      codexSessionId: "native-parent",
      codexThreadId: "native-parent",
      role: undefined,
    });
    expect(
      withNativeRegistration(root, undefined, (binding) => binding.nativeSessionId, authority),
    ).toEqual({ ok: true, value: "native-parent" });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a Lucid headless child cannot register itself as an interactive author", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-command-managed-"));
  try {
    const owner = readProcessOwner(process.pid);
    if (!owner) throw new Error("Test process identity unavailable");
    const registered = registerNativeSession(
      root,
      {
        harness: "codex",
        interface: "codex-cli",
        nativeSessionId: "native-parent",
        owner,
        workingDirectory: root,
      },
      nativeCommandAuthority({
        codexSessionId: "native-parent",
        codexThreadId: "native-parent",
        role: "headless",
      }),
    );
    expect(registered).toMatchObject({ ok: false, reason: "owner-unknown" });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test.each([
  { session: "native-parent", thread: "child-thread", role: undefined, expected: false },
  { session: "other-parent", thread: "other-parent", role: undefined, expected: false },
  { session: undefined, thread: "native-parent", role: undefined, expected: undefined },
  { session: "native-parent", thread: undefined, role: undefined, expected: undefined },
  { session: "native-parent", thread: "native-parent", role: "unknown", expected: undefined },
])(
  "native command rejects unverified or different context %j",
  ({ session, thread, role, expected }) => {
    const owner = readProcessOwner(process.pid);
    if (!owner) throw new Error("Test process identity unavailable");
    const authority = nativeCommandAuthority({
      codexSessionId: session,
      codexThreadId: thread,
      role,
    });
    expect(
      authority.callerOwns({
        harness: "codex",
        interface: "codex-cli",
        nativeSessionId: "native-parent",
        owner,
        workingDirectory: process.cwd(),
      }),
    ).toBe(expected);
  },
);

test("Codex command context cannot establish desktop or another harness identity", () => {
  const owner = readProcessOwner(process.pid);
  if (!owner) throw new Error("Test process identity unavailable");
  const authority = nativeCommandAuthority({
    codexSessionId: "native-parent",
    codexThreadId: "native-parent",
    role: undefined,
  });
  expect(
    authority.callerOwns({
      harness: "codex",
      interface: "codex-desktop",
      nativeSessionId: "native-parent",
      owner,
      workingDirectory: process.cwd(),
    }),
  ).toBeUndefined();
  expect(
    authority.callerOwns({
      harness: "muse",
      interface: "muse-cli",
      nativeSessionId: "native-parent",
      owner,
      workingDirectory: process.cwd(),
    }),
  ).toBeUndefined();
});

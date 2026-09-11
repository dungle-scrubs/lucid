import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoreError } from "../../src/store/errors.js";
import { acquireAppendLock } from "../../src/store/flock.js";
import {
  registerNativeSession,
  withNativeRegistration,
} from "../../src/store/native-registration.js";

test("connection distinguishes registration contention from a failed record operation", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-registration-errors-"));
  const authority = { callerOwns: () => true, ownerPresence: () => true };
  try {
    const registered = registerNativeSession(
      root,
      {
        harness: "codex",
        interface: "codex-cli",
        nativeSessionId: "native-one",
        owner: { executable: "/native/codex", pid: 123, startedAt: "123:456" },
        workingDirectory: root,
      },
      authority,
    );
    expect(registered.ok).toBe(true);
    const lock = acquireAppendLock(join(root, ".registrations", "registry"));
    try {
      const result = withNativeRegistration(root, undefined, () => "unexpected", authority);
      expect(result).toMatchObject({ ok: false, reason: "registration-busy" });
    } finally {
      lock.release();
    }
    const result = withNativeRegistration(
      root,
      undefined,
      () => {
        throw new StoreError("corrupt-log", "Synthetic unreadable record");
      },
      authority,
    );
    expect(result).toMatchObject({ ok: false, reason: "record-unreadable" });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("registration cleanup removes only corroborated departed owners and retains unknown owners", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-registration-cleanup-"));
  try {
    for (const pid of [123, 456]) {
      const registered = registerNativeSession(
        root,
        {
          harness: "codex",
          interface: "codex-cli",
          nativeSessionId: `native-${pid}`,
          owner: { executable: "/native/codex", pid, startedAt: `${pid}:1` },
          workingDirectory: root,
        },
        { callerOwns: () => true, ownerPresence: () => true },
      );
      expect(registered.ok).toBe(true);
    }
    const result = withNativeRegistration(root, undefined, (binding) => binding.nativeSessionId, {
      callerOwns: (owner) => owner.pid === 456,
      ownerPresence: (owner) => owner.pid === 456,
    });
    expect(result).toEqual({ ok: true, value: "native-456" });
    const files = (): string[] =>
      readdirSync(join(root, ".registrations")).filter((name) => name.endsWith(".json"));
    expect(files()).toHaveLength(1);
    const unknown = withNativeRegistration(root, undefined, () => "unexpected", {
      callerOwns: () => undefined,
      ownerPresence: () => undefined,
    });
    expect(unknown).toMatchObject({ ok: false, reason: "owner-unknown" });
    expect(files()).toHaveLength(1);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

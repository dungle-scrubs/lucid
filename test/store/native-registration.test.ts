import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProcessOwner } from "../../src/process-owner.js";
import { StoreError } from "../../src/store/errors.js";
import { acquireAppendLock } from "../../src/store/flock.js";
import {
  callerAncestryOwns,
  nativeRegistrationAuthority,
  registerNativeSession,
  removeNativeRegistration,
  withNativeRegistration,
} from "../../src/store/native-registration.js";

test("a native listening request survives lookup but cannot cross a lifecycle refresh", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-registration-request-"));
  const authority = { callerOwns: () => true, ownerPresence: () => true };
  const capture = {
    harness: "codex" as const,
    interface: "codex-cli" as const,
    nativeSessionId: "native-request",
    owner: { executable: "/native/codex", pid: 123, startedAt: "123:456" },
    workingDirectory: root,
  };
  try {
    const first = registerNativeSession(root, capture, authority);
    if (!first.ok) throw new Error(first.message);
    const request = { actionId: crypto.randomUUID(), conversationId: "selected-record" };
    expect(
      withNativeRegistration(
        root,
        first.registration.registrationId,
        (_binding, access) => access.writeListenRequest(request),
        authority,
      ),
    ).toEqual({ ok: true, value: { ok: true, value: undefined } });
    expect(
      withNativeRegistration(
        root,
        undefined,
        (_binding, access) => access.readListenRequest(),
        authority,
      ),
    ).toEqual({
      ok: true,
      value: { ok: true, value: request },
    });
    const refreshed = registerNativeSession(root, capture, authority);
    expect(refreshed.ok).toBe(true);
    expect(
      withNativeRegistration(
        root,
        first.registration.registrationId,
        (_binding, access) => access.writeListenRequest(request),
        authority,
      ),
    ).toMatchObject({
      ok: false,
      reason: "stale-registration",
    });
    expect(
      withNativeRegistration(
        root,
        undefined,
        (_binding, access) => access.readListenRequest(),
        authority,
      ),
    ).toEqual({
      ok: true,
      value: { ok: true, value: null },
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("an invalid selection cannot grant listening or corrupt verified receipt authority", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-registration-hint-"));
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
    if (!registered.ok) throw new Error(registered.message);
    const name = readdirSync(join(root, ".registrations")).find((value) =>
      /^[0-9a-f]{64}\.json$/.test(value),
    );
    if (!name) throw new Error("Missing registration fixture");
    writeFileSync(
      join(root, ".registrations", name),
      JSON.stringify({
        ...registered.registration,
        listenRequest: { conversationId: "../wrong-record", actionId: "invalid" },
      }),
    );
    expect(withNativeRegistration(root, undefined, (binding) => binding, authority)).toEqual({
      ok: true,
      value: registered.registration,
    });
    expect(
      withNativeRegistration(
        root,
        undefined,
        (_binding, access) => access.readListenRequest(),
        authority,
      ),
    ).toMatchObject({ ok: true, value: { ok: false, reason: "registration-store-unavailable" } });
    const request = { actionId: crypto.randomUUID(), conversationId: "repaired" };
    expect(
      withNativeRegistration(
        root,
        undefined,
        (_binding, access) => access.writeListenRequest(request),
        authority,
      ),
    ).toMatchObject({ ok: true, value: { ok: true } });
    expect(
      withNativeRegistration(
        root,
        undefined,
        (_binding, access) => access.readListenRequest(),
        authority,
      ),
    ).toEqual({ ok: true, value: { ok: true, value: request } });
    const escaped = withNativeRegistration(
      root,
      undefined,
      (_binding, access) => access,
      authority,
    );
    if (!escaped.ok) throw new Error(escaped.message);
    expect(escaped.value.writeListenRequest(null)).toMatchObject({
      ok: false,
      reason: "stale-registration",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a shared native process cannot authorize a different native thread", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-registration-thread-"));
  try {
    const owner = readProcessOwner(process.pid);
    if (!owner) throw new Error("Test process identity unavailable");
    const registered = registerNativeSession(
      root,
      {
        harness: "codex",
        interface: "codex-cli",
        nativeSessionId: "parent-session",
        owner,
        workingDirectory: root,
      },
      { callerOwns: () => true, ownerPresence: () => true },
    );
    expect(registered.ok).toBe(true);
    let writes = 0;
    const result = withNativeRegistration(
      root,
      undefined,
      () => {
        writes++;
      },
      nativeRegistrationAuthority(() => false),
    );
    expect(result).toMatchObject({ ok: false, reason: "registration-missing" });
    expect(writes).toBe(0);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("native registration requires positive session proof and returns the exact verified binding", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-registration-proof-"));
  try {
    const owner = readProcessOwner(process.pid);
    if (!owner) throw new Error("Test process identity unavailable");
    const capture = {
      harness: "codex" as const,
      interface: "codex-cli" as const,
      nativeSessionId: "parent-session",
      owner,
      workingDirectory: root,
    };
    const unverified = registerNativeSession(root, capture);
    expect(unverified).toMatchObject({ ok: false, reason: "owner-unknown" });
    const authority = nativeRegistrationAuthority(
      (candidate) =>
        candidate.nativeSessionId === capture.nativeSessionId &&
        candidate.interface === capture.interface &&
        candidate.workingDirectory === root,
    );
    const registered = registerNativeSession(root, capture, authority);
    expect(registered.ok).toBe(true);
    if (!registered.ok) throw new Error(registered.message);
    expect(withNativeRegistration(root, undefined, (binding) => binding, authority)).toEqual({
      ok: true,
      value: registered.registration,
    });
    expect(withNativeRegistration(root, undefined, () => "unexpected")).toMatchObject({
      ok: false,
      reason: "owner-unknown",
    });
    expect(
      withNativeRegistration(
        root,
        undefined,
        () => "unexpected",
        nativeRegistrationAuthority(() => {
          throw new Error("Native context unavailable");
        }),
      ),
    ).toMatchObject({ ok: false, reason: "owner-unknown" });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a verified match binds when an unrelated registration cannot be verified", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-registration-unknown-unrelated-"));
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
      callerOwns: (capture) => (capture.owner.pid === 456 ? true : undefined),
      ownerPresence: () => true,
    });
    expect(result).toEqual({ ok: true, value: "native-456" });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

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
      callerOwns: (capture) => capture.owner.pid === 456,
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

describe("ancestry through a process whose identity is unreadable", () => {
  // The observed chain: pi -> zsh -> herdr -> zsh -> login (root-owned) -> ghostty -> launchd.
  const identities: Record<number, { parentPid: number; executable: string }> = {
    500: { parentPid: 400, executable: "/bin/pi" },
    400: { parentPid: 300, executable: "/bin/zsh" },
    200: { parentPid: 1, executable: "/Applications/Ghostty.app/ghostty" },
  };
  const probe = (pid: number) => {
    const known = identities[pid];
    return known ? { ...known, pid, startedAt: `${pid}:0` } : undefined;
  };
  const owner = (pid: number) => ({
    executable: identities[pid]?.executable ?? "/x",
    pid,
    startedAt: `${pid}:0`,
  });

  test("an unregistered caller below login is not owned, not unknown", () => {
    const parent = (pid: number) => (pid === 300 ? 200 : undefined);
    expect(callerAncestryOwns(owner(999), probe, parent, 500)).toBe(false);
  });

  test("an owner above the unreadable process still matches", () => {
    const parent = (pid: number) => (pid === 300 ? 200 : undefined);
    expect(callerAncestryOwns(owner(200), probe, parent, 500)).toBe(true);
  });

  test("an unreadable process never matches, even at the owner's PID", () => {
    const parent = (pid: number) => (pid === 300 ? 200 : undefined);
    expect(
      callerAncestryOwns(
        { executable: "/usr/bin/login", pid: 300, startedAt: "300:0" },
        probe,
        parent,
        500,
      ),
    ).toBe(false);
  });

  test("an ancestor with no readable parent leaves ownership unknown", () => {
    expect(callerAncestryOwns(owner(999), probe, () => undefined, 500)).toBeUndefined();
  });

  test("an ancestor that is gone ends the walk as not owned", () => {
    expect(callerAncestryOwns(owner(999), probe, () => null, 500)).toBe(false);
  });
});

test("shutdown removal deletes only this owner's registration for this session", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-registration-removal-"));
  const authority = { callerOwns: () => true, ownerPresence: () => true };
  const capture = {
    harness: "pi" as const,
    interface: "pi-cli" as const,
    nativeSessionId: "pi-session-one",
    owner: { executable: "/usr/local/bin/pi", pid: 777, startedAt: "777:1" },
    workingDirectory: root,
  };
  try {
    expect(removeNativeRegistration(root, "pi-cli", capture.owner, "pi-session-one")).toEqual({
      removed: false,
    });
    const registered = registerNativeSession(root, capture, authority);
    expect(registered.ok).toBe(true);
    const files = (): number =>
      readdirSync(join(root, ".registrations")).filter((name) => name.endsWith(".json")).length;
    expect(files()).toBe(1);
    // Another session ID or another owner leaves the registration in place.
    expect(removeNativeRegistration(root, "pi-cli", capture.owner, "pi-session-two")).toEqual({
      removed: false,
    });
    expect(
      removeNativeRegistration(root, "pi-cli", { ...capture.owner, pid: 778 }, "pi-session-one"),
    ).toEqual({ removed: false });
    expect(files()).toBe(1);
    // The owner may be named with any field order; the key is canonical.
    const reordered = {
      pid: capture.owner.pid,
      executable: capture.owner.executable,
      startedAt: capture.owner.startedAt,
    };
    expect(removeNativeRegistration(root, "pi-cli", reordered, "pi-session-one")).toMatchObject({
      removed: true,
    });
    expect(files()).toBe(0);
    expect(removeNativeRegistration(root, "pi-cli", capture.owner, "pi-session-one")).toEqual({
      removed: false,
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("shutdown removal reports a busy registry instead of waiting", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-registration-removal-busy-"));
  const authority = { callerOwns: () => true, ownerPresence: () => true };
  try {
    const registered = registerNativeSession(
      root,
      {
        harness: "pi",
        interface: "pi-cli",
        nativeSessionId: "pi-session-one",
        owner: { executable: "/usr/local/bin/pi", pid: 777, startedAt: "777:1" },
        workingDirectory: root,
      },
      authority,
    );
    expect(registered.ok).toBe(true);
    const owner = registered.ok ? registered.registration.owner : undefined;
    if (!owner) throw new Error("Missing registration fixture");
    const lock = acquireAppendLock(join(root, ".registrations", "registry"));
    try {
      expect(removeNativeRegistration(root, "pi-cli", owner, "pi-session-one")).toMatchObject({
        ok: false,
        reason: "registration-busy",
      });
    } finally {
      lock.release();
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

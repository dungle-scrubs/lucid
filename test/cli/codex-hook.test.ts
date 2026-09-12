import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../../src/cli/dispatch.js";
import { captureCodexAuthor, runCodexHook } from "../../src/cli/hooks/codex.js";
import { nativeCommandAuthority } from "../../src/cli/native-context.js";
import { readProcessOwner } from "../../src/process-owner.js";
import { withNativeRegistration } from "../../src/store/native-registration.js";

test("the native hook CLI parses stdin and returns registration failures without a continuation", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-codex-hook-cli-"));
  try {
    const output: string[] = [];
    const errors: string[] = [];
    expect(
      await dispatch(["_codex-hook"], {
        codexHookFn: (records, payload, options) =>
          runCodexHook(records, payload, {
            ...options,
            native: { owner: async () => undefined, role: undefined },
          }),
        onOutput: (line) => output.push(line),
        onStderr: (line) => errors.push(line),
        readStdinFn: async () =>
          JSON.stringify({
            cwd: root,
            hook_event_name: "SessionStart",
            session_id: "native-author",
            source: "startup",
          }),
        rootDir: root,
      }),
    ).toEqual({ kind: "codex-hook" });
    expect(output).toEqual([]);
    expect(errors).toEqual(["owner-unknown: The Codex native process could not be verified.\n"]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("unknown SessionStart sources explain the unsupported callback while compact stays non-registering", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-codex-source-"));
  try {
    const deps = { owner: async () => undefined, role: undefined };
    const payload = { cwd: root, hook_event_name: "SessionStart", session_id: "native-author" };
    expect(
      await captureCodexAuthor(root, { ...payload, source: "unknown-source" }, deps),
    ).toMatchObject({ ok: false, reason: "invalid-registration" });
    expect(await captureCodexAuthor(root, { ...payload, source: "compact" }, deps)).toEqual({
      ok: true,
      skipped: true,
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Stop resolves the existing native registration without creating a lifecycle generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-codex-stop-"));
  try {
    const owner = readProcessOwner(process.pid);
    if (!owner) throw new Error("Test process identity unavailable");
    const deps = { owner: async () => owner, role: undefined };
    const identity = { cwd: root, session_id: "native-author" };
    const start = await captureCodexAuthor(
      root,
      { ...identity, hook_event_name: "SessionStart", source: "startup" },
      deps,
    );
    const stop = await captureCodexAuthor(root, { ...identity, hook_event_name: "Stop" }, deps);
    expect(stop).toEqual(start);
    expect(stop).toHaveProperty("registration");
    expect(
      await captureCodexAuthor(
        root,
        { ...identity, session_id: "unknown-author", hook_event_name: "Stop" },
        deps,
      ),
    ).toMatchObject({ ok: false, reason: "registration-missing" });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("failed native inspection returns an owner-unknown result without registration", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-codex-inspection-"));
  try {
    await expect(
      captureCodexAuthor(
        root,
        {
          cwd: root,
          hook_event_name: "SessionStart",
          session_id: "codex-author",
          source: "startup",
        },
        {
          owner: async () => {
            throw new Error("inspection unavailable");
          },
          role: undefined,
        },
      ),
    ).resolves.toMatchObject({ ok: false, reason: "owner-unknown" });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Codex SessionStart registers the exact callback session for its parent tool commands", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-codex-start-"));
  try {
    const owner = readProcessOwner(process.pid);
    if (!owner) throw new Error("Test process identity unavailable");
    const result = await captureCodexAuthor(
      root,
      {
        cwd: root,
        hook_event_name: "SessionStart",
        session_id: "codex-author",
        source: "startup",
      },
      { owner: async () => owner, role: undefined },
    );
    expect(result).toMatchObject({
      ok: true,
      registration: {
        nativeSessionId: "codex-author",
        owner: {
          executable: owner.executable,
          pid: owner.pid,
          startedAt: owner.startedAt,
        },
        workingDirectory: root,
      },
    });
    const authority = nativeCommandAuthority({
      codexSessionId: "codex-author",
      codexThreadId: "codex-author",
      role: undefined,
    });
    expect(
      withNativeRegistration(root, undefined, (binding) => binding.nativeSessionId, authority),
    ).toEqual({ ok: true, value: "codex-author" });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a subagent callback carrying the parent session cannot replace its registration", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-codex-subagent-"));
  try {
    const owner = readProcessOwner(process.pid);
    if (!owner) throw new Error("Test process identity unavailable");
    const payload = {
      cwd: root,
      hook_event_name: "SessionStart",
      session_id: "codex-author",
      source: "startup",
    };
    const deps = { owner: async () => owner, role: undefined };
    const first = await captureCodexAuthor(root, payload, deps);
    expect(first.ok && "registration" in first).toBe(true);
    if (!first.ok || !("registration" in first)) throw new Error("Missing parent registration");
    const child = await captureCodexAuthor(root, { ...payload, agent_id: "child-thread" }, deps);
    expect(child).toEqual({ ok: true, skipped: true });
    for (const event of ["SubagentStart", "SubagentStop"]) {
      expect(await captureCodexAuthor(root, { ...payload, hook_event_name: event }, deps)).toEqual({
        ok: true,
        skipped: true,
      });
    }
    const authority = nativeCommandAuthority({
      codexSessionId: "codex-author",
      codexThreadId: "codex-author",
      role: undefined,
    });
    expect(withNativeRegistration(root, undefined, (binding) => binding, authority)).toEqual({
      ok: true,
      value: first.registration,
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a new native lifecycle invalidates prior command identity without carrying its registration", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-codex-lifecycle-"));
  try {
    const owner = readProcessOwner(process.pid);
    if (!owner) throw new Error("Test process identity unavailable");
    const deps = { owner: async () => owner, role: undefined };
    const first = await captureCodexAuthor(
      root,
      { cwd: root, hook_event_name: "SessionStart", session_id: "old-session", source: "startup" },
      deps,
    );
    expect(first.ok && "registration" in first).toBe(true);
    const next = await captureCodexAuthor(
      root,
      { cwd: root, hook_event_name: "SessionStart", session_id: "new-session", source: "clear" },
      deps,
    );
    expect(next).toMatchObject({ ok: true, registration: { nativeSessionId: "new-session" } });
    const authority = nativeCommandAuthority({
      codexSessionId: "old-session",
      codexThreadId: "old-session",
      role: undefined,
    });
    expect(withNativeRegistration(root, undefined, () => "unexpected", authority)).toMatchObject({
      ok: false,
      reason: "registration-missing",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

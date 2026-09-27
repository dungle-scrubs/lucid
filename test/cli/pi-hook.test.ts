import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DispatchDeps } from "../../src/cli/dispatch.js";
import { dispatch } from "../../src/cli/dispatch.js";
import { commitOperation } from "../../src/cli/hooks/native-commit.js";
import type { PiHookDeps } from "../../src/cli/hooks/pi.js";
import { runPiHook } from "../../src/cli/hooks/pi.js";
import { mapSubcommand } from "../../src/cli/mapping.js";
import { listenStopFeedback, requestNativeListening } from "../../src/cli/native-listening.js";
import { piSessionAuthority } from "../../src/cli/pi-commands.js";
import { conversations } from "../../src/cli/record-addressing.js";
import { readProcessOwner } from "../../src/process-owner.js";
import { readConnection } from "../../src/store/connection-view.js";
import { openWriter, viewConversation } from "../../src/store/conversation-host.js";
import { acquireAppendLock } from "../../src/store/flock.js";
import { saveNativeProposal } from "../../src/store/native-proposals.js";
import type { NativeListenRequest } from "../../src/store/native-registration.js";
import {
  registerNativeSession,
  withNativeRegistration,
} from "../../src/store/native-registration.js";

const SESSION = "pi-session-01";
const OTHER_SESSION = "pi-session-02";
const PI_PID = 4242;
const OTHER_PI_PID = 4343;
const SHELL_PID = 4000;
const PI_EXE = "/opt/pi-runtime/bin/node";

/** The first line of a real file, as the hook's own bounded reader reports it. */
const firstLine = (path: string): string | null | undefined => {
  try {
    const text = readFileSync(path, "utf8");
    const newline = text.indexOf("\n");
    return newline === -1 ? text : text.slice(0, newline);
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null;
  }
};

/** The synthetic process chain: this test process, its parent the Pi runtime,
 * and above that a readable shell whose own parent is pid 1. */
const deps = (overrides: Partial<PiHookDeps> = {}): PiHookDeps => ({
  now: () => Date.now(),
  parentPid: () => PI_PID,
  probe: (pid: number) =>
    pid === process.pid
      ? { executable: "/bin/agent-shell", parentPid: PI_PID, pid, startedAt: `${pid}:0` }
      : pid === PI_PID
        ? { executable: PI_EXE, parentPid: SHELL_PID, pid: PI_PID, startedAt: "4242:1" }
        : pid === SHELL_PID
          ? { executable: "/bin/zsh", parentPid: 1, pid: SHELL_PID, startedAt: "4000:1" }
          : undefined,
  readFirstLine: firstLine,
  readParentPid: () => undefined,
  realpath: (value: string) => value,
  ...overrides,
});

const capture = (event: string, over: Record<string, unknown> = {}) => ({
  event,
  execPath: PI_EXE,
  mode: "tui",
  nativeSessionId: SESSION,
  pid: PI_PID,
  sessionFile: null,
  v: 1,
  workingDirectory: "/work",
  ...over,
});

const run = async (
  root: string,
  event: "session-start" | "session-shutdown" | "settled" | "tool-result",
  body: unknown,
  hookDeps: Partial<PiHookDeps> = {},
) => runPiHook(conversations(root), event, JSON.stringify(body), deps(hookDeps));

const registered = (root: string) =>
  withNativeRegistration(root, undefined, (binding) => binding, {
    callerOwns: () => true,
    ownerPresence: () => true,
  });

/** The registration one named Pi owner holds, regardless of other owners. */
const registeredTo = (root: string, pid: number) =>
  withNativeRegistration(root, undefined, (binding) => binding, {
    callerOwns: (candidate) => candidate.owner.pid === pid,
    ownerPresence: () => true,
  });

/** One published record: created and marked native-published directly, because the
 * plain publish path saves a terminal headless fallback beside the document. */
function publicationRecord(root: string, conversationId: string): string {
  const { dir } = conversations(root).ensure(conversationId, { workingDirectory: root });
  const host = openWriter(dir, { connectionAuthority: () => undefined });
  try {
    expect(host.recordNativePublication().verdict).toBe("accepted");
  } finally {
    host.close();
  }
  return conversationId;
}

/** One pi-cli record whose registration owner is this live test process, with a
 * listen request and saved feedback: the record state a real settled helper
 * reaches, built without the hook's process capture so the context-copy liveness
 * checks (which read the real process table) corroborate the owner. */
async function piListeningFixture(
  root: string,
  conversationId: string,
  feedback: string,
  prepare?: (host: ReturnType<typeof openWriter>) => Promise<void> | void,
): Promise<{ dir: string; request: NativeListenRequest }> {
  const owner = readProcessOwner(process.pid);
  if (!owner) throw new Error("Test process identity unavailable");
  const authority = { callerOwns: () => true, ownerPresence: () => true } as const;
  const registered = registerNativeSession(
    root,
    {
      harness: "pi",
      interface: "pi-cli",
      nativeSessionId: SESSION,
      owner,
      workingDirectory: root,
    },
    authority,
  );
  if (!registered.ok) throw new Error(registered.message);
  const request = { actionId: crypto.randomUUID(), conversationId };
  const written = withNativeRegistration(
    root,
    undefined,
    (_binding, access) => access.writeListenRequest(request),
    authority,
  );
  if (!written.ok) throw new Error(written.message);
  publicationRecord(root, conversationId);
  const dir = conversations(root).dirFor(conversationId);
  const host = openWriter(dir, { connectionAuthority: () => registered.registration });
  try {
    expect(
      host.writeConnection({
        actionId: crypto.randomUUID(),
        binding: registered.registration,
        kind: "bound",
      }).verdict,
    ).toBe("accepted");
    await prepare?.(host);
    expect(
      host.acceptInput({ id: "feedback", mode: "queue", text: feedback }, { managed: true })
        .verdict,
    ).toBe("accepted");
  } finally {
    host.close();
  }
  return { dir, request };
}

/** One published record bound to the registered Pi session, with a committed
 * listen proposal: the state a real session reaches before `agent_settled`. */
async function boundListeningRecord(root: string, conversationId: string): Promise<void> {
  publicationRecord(root, conversationId);
  expect(
    await run(root, "session-start", { ...capture("session-start"), workingDirectory: root }),
  ).toMatchObject({ kind: "registered" });
  const binding = registered(root);
  if (!binding.ok) throw new Error(binding.message);
  const bind = saveNativeProposal(root, binding.value, { conversationId, kind: "bind" });
  expect(
    await run(root, "tool-result", {
      ...capture("tool-result"),
      markers: [`lucid-pi-proposal:${bind.nonce}`],
      toolCallId: "call-bind",
    }),
  ).toMatchObject({ kind: "committed", v: 1 });
  const listen = saveNativeProposal(root, binding.value, { conversationId, kind: "listen" });
  const committed = await run(root, "tool-result", {
    ...capture("tool-result"),
    markers: [`lucid-pi-proposal:${listen.nonce}`],
    toolCallId: "call-listen",
  });
  if (committed.kind !== "committed") throw new Error("Missing listen commit");
  expect(committed.text).toContain("Listening requested");
}

describe("_pi-hook mapping", () => {
  test("maps a known event with an optional root and refuses everything else to help", () => {
    expect(mapSubcommand(["_pi-hook", "session-start"])).toEqual({
      event: "session-start",
      kind: "pi-hook",
    });
    expect(mapSubcommand(["_pi-hook", "tool-result", "--root", "/records"])).toEqual({
      event: "tool-result",
      kind: "pi-hook",
      root: "/records",
    });
    expect(mapSubcommand(["_pi-hook", "settled"]).kind).toBe("pi-hook");
    expect(mapSubcommand(["_pi-hook", "session-start", "extra"]).kind).toBe("help");
    expect(mapSubcommand(["_pi-hook", "--root", "/records", "session-start"]).kind).toBe("help");
  });
});

describe("capture validation refuses before any mutation", () => {
  const invalid = async (
    body: unknown,
    event: "session-start" | "tool-result" = "session-start",
  ) => {
    const root = mkdtempSync(join(tmpdir(), "lucid-pi-hook-invalid-"));
    try {
      const result = await run(root, event, body);
      expect(result).toMatchObject({ kind: "refused", reason: "invalid-capture", v: 1 });
      expect(existsSync(join(root, ".registrations"))).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  };
  test("an unknown key refuses", () => invalid({ ...capture("session-start"), extra: 1 }));
  test("a wrong version refuses", () => invalid({ ...capture("session-start"), v: 2 }));
  test("a non-tui mode refuses", () => invalid({ ...capture("session-start"), mode: "json" }));
  test("an event that does not match argv refuses", () =>
    invalid({ ...capture("session-shutdown") }));
  test("seventeen markers refuse", () =>
    invalid(
      {
        ...capture("tool-result"),
        markers: Array.from({ length: 17 }, () => "lucid-pi-proposal:x"),
        toolCallId: "call-1",
      },
      "tool-result",
    ));
  test("a marker without the pi prefix refuses", () =>
    invalid(
      {
        ...capture("tool-result"),
        markers: ["lucid-claude-proposal:x"],
        toolCallId: "call-1",
      },
      "tool-result",
    ));
  test("a missing required key refuses", () => {
    const body = capture("session-start");
    delete (body as Record<string, unknown>).execPath;
    return invalid(body);
  });
});

test("the parent must be the captured Pi runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-pi-hook-parent-"));
  try {
    const pidMismatch = await run(root, "session-start", capture("session-start"), {
      parentPid: () => 9999,
    });
    expect(pidMismatch).toEqual({
      kind: "refused",
      message: "The Pi process that started this helper could not be verified.",
      reason: "native-context-unverified",
      v: 1,
    });
    expect(
      await run(root, "session-start", capture("session-start", { execPath: "/other/runtime" })),
    ).toMatchObject({ kind: "refused", reason: "native-context-unverified" });
    // The parent's executable must be the node or bun runtime the capture names.
    expect(
      await run(root, "session-start", capture("session-start"), {
        probe: (pid: number) =>
          pid === PI_PID
            ? { executable: "/Applications/Pi.app/pi", parentPid: 1, pid, startedAt: "4242:1" }
            : undefined,
      }),
    ).toMatchObject({ kind: "refused", reason: "native-context-unverified" });
    expect(existsSync(join(root, ".registrations"))).toBe(false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("session-start registers the captured session and session-shutdown removes it", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-pi-hook-lifecycle-"));
  try {
    const started = await run(root, "session-start", {
      ...capture("session-start"),
      workingDirectory: root,
    });
    expect(started).toMatchObject({ kind: "registered", v: 1 });
    const registration = registered(root);
    expect(registration).toMatchObject({
      ok: true,
      value: {
        harness: "pi",
        interface: "pi-cli",
        nativeSessionId: SESSION,
        owner: { pid: PI_PID },
        workingDirectory: root,
      },
    });
    expect(
      await run(root, "session-shutdown", {
        ...capture("session-shutdown"),
        workingDirectory: root,
      }),
    ).toEqual({ kind: "removed", removed: true, v: 1 });
    expect(registered(root)).toMatchObject({ ok: false, reason: "registration-missing" });
    expect(
      await run(root, "session-shutdown", {
        ...capture("session-shutdown"),
        workingDirectory: root,
      }),
    ).toEqual({ kind: "removed", removed: false, v: 1 });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("an owner that runs under a JavaScript runtime or a Pi process is not registered", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-pi-hook-ancestry-"));
  try {
    for (const [mid, executable] of [
      [500, "/usr/local/bin/node"],
      [501, "/usr/local/bin/pi"],
    ] as const) {
      const result = await run(root, "session-start", capture("session-start"), {
        probe: (pid: number) =>
          pid === process.pid
            ? { executable: "/bin/agent-shell", parentPid: PI_PID, pid, startedAt: `${pid}:0` }
            : pid === PI_PID
              ? { executable: PI_EXE, parentPid: mid, pid: PI_PID, startedAt: "4242:1" }
              : pid === mid
                ? { executable, parentPid: 1, pid: mid, startedAt: `${mid}:1` }
                : undefined,
      });
      expect(result).toEqual({
        kind: "refused",
        message:
          "This Pi session runs inside another JavaScript runtime or Pi process, so Lucid does not register it. Start Pi directly from a terminal.",
        reason: "native-context-unverified",
        v: 1,
      });
    }
    expect(existsSync(join(root, ".registrations"))).toBe(false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("an owner whose parent is pid 1 has no parent shell and is not registered", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-pi-hook-orphan-"));
  try {
    const orphaned = {
      probe: (pid: number) =>
        pid === process.pid
          ? { executable: "/bin/agent-shell", parentPid: PI_PID, pid, startedAt: `${pid}:0` }
          : pid === PI_PID
            ? { executable: PI_EXE, parentPid: 1, pid: PI_PID, startedAt: "4242:1" }
            : undefined,
    };
    expect(await run(root, "session-start", capture("session-start"), orphaned)).toEqual({
      kind: "refused",
      message:
        "This Pi process has no parent shell, so Lucid does not register it. Start Pi directly from a terminal.",
      reason: "native-context-unverified",
      v: 1,
    });
    expect(existsSync(join(root, ".registrations"))).toBe(false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("an owner under a shell and then launchd registers, and the session file header must name the session and folder", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-pi-hook-shell-"));
  try {
    const shellChain = {
      probe: (pid: number) =>
        pid === process.pid
          ? { executable: "/bin/agent-shell", parentPid: PI_PID, pid, startedAt: `${pid}:0` }
          : pid === PI_PID
            ? { executable: PI_EXE, parentPid: 500, pid: PI_PID, startedAt: "4242:1" }
            : pid === 500
              ? { executable: "/bin/zsh", parentPid: 1, pid: 500, startedAt: "500:1" }
              : undefined,
    };
    expect(
      await run(
        root,
        "session-start",
        { ...capture("session-start"), workingDirectory: root },
        shellChain,
      ),
    ).toMatchObject({ kind: "registered", v: 1 });
    expect(registered(root)).toMatchObject({
      ok: true,
      value: { nativeSessionId: SESSION, owner: { pid: PI_PID } },
    });

    // A session file whose header names another session refuses registration.
    const sessionFile = join(root, "session.jsonl");
    const writeHeader = (header: unknown) =>
      writeFileSync(sessionFile, `${JSON.stringify(header)}\n{"type":"message"}\n`);
    writeHeader({ cwd: root, id: OTHER_SESSION, type: "session", version: 3 });
    expect(
      await run(root, "session-start", {
        ...capture("session-start"),
        sessionFile,
        workingDirectory: root,
      }),
    ).toMatchObject({ kind: "refused", reason: "native-context-unverified", v: 1 });
    // A matching header registers, and a session Pi has not written yet registers too.
    writeHeader({ cwd: root, id: SESSION, type: "session", version: 3 });
    expect(
      await run(root, "session-start", {
        ...capture("session-start"),
        sessionFile,
        workingDirectory: root,
      }),
    ).toMatchObject({ kind: "registered", v: 1 });
    expect(
      await run(root, "session-start", {
        ...capture("session-start"),
        sessionFile: null,
        workingDirectory: root,
      }),
    ).toMatchObject({ kind: "registered", v: 1 });
    // Pi 0.87.1 reports a new session's path before it writes the file (live TUI run).
    expect(
      await run(root, "session-start", {
        ...capture("session-start"),
        sessionFile: join(root, "not-written-yet.jsonl"),
        workingDirectory: root,
      }),
    ).toMatchObject({ kind: "registered", v: 1 });
    // A path that exists but cannot be read as a file still refuses.
    expect(
      await run(root, "session-start", {
        ...capture("session-start"),
        sessionFile: root,
        workingDirectory: root,
      }),
    ).toMatchObject({ kind: "refused", reason: "native-context-unverified", v: 1 });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("tool-result commits a saved listen proposal for the registered session", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-pi-hook-listen-"));
  try {
    const conversationId = publicationRecord(root, "pi listen record");
    expect(
      await run(root, "session-start", { ...capture("session-start"), workingDirectory: root }),
    ).toMatchObject({ kind: "registered" });
    const binding = registered(root);
    if (!binding.ok) throw new Error(binding.message);
    // Listening needs the record bound to this registration first, as a real session does.
    const bind = saveNativeProposal(root, binding.value, { conversationId, kind: "bind" });
    expect(
      await run(root, "tool-result", {
        ...capture("tool-result"),
        markers: [`lucid-pi-proposal:${bind.nonce}`],
        toolCallId: "call-bind",
      }),
    ).toMatchObject({ kind: "committed", v: 1 });
    const proposal = saveNativeProposal(root, binding.value, { conversationId, kind: "listen" });
    const result = await run(root, "tool-result", {
      ...capture("tool-result"),
      markers: [`lucid-pi-proposal:${proposal.nonce}`],
      toolCallId: "call-1",
    });
    expect(result).toMatchObject({ kind: "committed", v: 1 });
    if (result.kind !== "committed") throw new Error("Missing commit result");
    expect(result.text).toContain(`Listening for ${conversationId}`);
    // RFC 28 slice 4 gives pi-cli a verified feedback transport, so the commit
    // saves the listening request the settled helper later consumes.
    expect(result.text).toContain("Listening requested");
    expect(
      withNativeRegistration(root, undefined, (_binding, access) => access.readListenRequest(), {
        callerOwns: () => true,
        ownerPresence: () => true,
      }),
    ).toMatchObject({ ok: true, value: { ok: true, value: { conversationId } } });
    // The claimed proposal never commits twice.
    const replay = await run(root, "tool-result", {
      ...capture("tool-result"),
      markers: [`lucid-pi-proposal:${proposal.nonce}`],
      toolCallId: "call-2",
    });
    if (replay.kind !== "committed") throw new Error("Missing replay result");
    expect(replay.text).toContain(`${proposal.nonce}: not found or expired`);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a replaced registration and a foreign session each refuse their proposal", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-pi-hook-stale-"));
  try {
    const conversationId = publicationRecord(root, "pi stale record");
    expect(await run(root, "session-start", capture("session-start"))).toMatchObject({
      kind: "registered",
    });
    const first = registered(root);
    if (!first.ok) throw new Error(first.message);
    // A second session_start for the same owner replaces the registration.
    expect(await run(root, "session-start", capture("session-start"))).toMatchObject({
      kind: "registered",
    });
    const stale = saveNativeProposal(root, first.value, { conversationId, kind: "listen" });
    const replaced = await run(root, "tool-result", {
      ...capture("tool-result"),
      markers: [`lucid-pi-proposal:${stale.nonce}`],
      toolCallId: "call-1",
    });
    if (replaced.kind !== "committed") throw new Error("Missing replaced result");
    expect(replaced.text).toContain(`${stale.nonce}: refused (registration-replaced)`);

    // A bind proposal from a session other than the captured one refuses and
    // saves the refusal beside the publication, as the Claude hook does.
    const current = registered(root);
    if (!current.ok) throw new Error(current.message);
    const foreign = saveNativeProposal(root, current.value, { conversationId, kind: "bind" });
    const mismatched = await run(root, "tool-result", {
      ...capture("tool-result", { nativeSessionId: OTHER_SESSION }),
      markers: [`lucid-pi-proposal:${foreign.nonce}`],
      toolCallId: "call-2",
    });
    if (mismatched.kind !== "committed") throw new Error("Missing mismatch result");
    expect(mismatched.text).toContain(`${foreign.nonce}: refused (proposal-session-mismatch)`);
    expect(readConnection(conversations(root).dirFor(conversationId))).toMatchObject({
      reason: "proposal-session-mismatch",
      state: "setup-required",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a tool-result bind commit records the Pi registration as the record's binding", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-pi-hook-bind-"));
  try {
    const conversationId = publicationRecord(root, "pi bind record");
    expect(
      await run(root, "session-start", { ...capture("session-start"), workingDirectory: root }),
    ).toMatchObject({ kind: "registered" });
    const binding = registered(root);
    if (!binding.ok) throw new Error(binding.message);
    const proposal = saveNativeProposal(root, binding.value, { conversationId, kind: "bind" });
    const result = await run(root, "tool-result", {
      ...capture("tool-result"),
      markers: [`lucid-pi-proposal:${proposal.nonce}`],
      toolCallId: "call-1",
    });
    expect(result).toMatchObject({ kind: "committed", v: 1 });
    if (result.kind !== "committed") throw new Error("Missing bind result");
    expect(result.text).toContain(`Connection for ${conversationId}`);
    // The record's binding names the registration the bind committed under.
    expect(
      viewConversation(conversations(root).dirFor(conversationId)).state.connection?.binding,
    ).toMatchObject({
      interface: "pi-cli",
      nativeSessionId: SESSION,
      registrationId: binding.value.registrationId,
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a proposal saved under another owner's session refuses before any registration lookup", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-pi-hook-owners-"));
  try {
    const conversationId = publicationRecord(root, "pi two owners record");
    let parent = OTHER_PI_PID;
    const twoOwners = {
      parentPid: () => parent,
      probe: (pid: number) =>
        pid === process.pid
          ? { executable: "/bin/agent-shell", parentPid: parent, pid, startedAt: `${pid}:0` }
          : pid === PI_PID
            ? { executable: PI_EXE, parentPid: SHELL_PID, pid: PI_PID, startedAt: "4242:1" }
            : pid === OTHER_PI_PID
              ? { executable: PI_EXE, parentPid: SHELL_PID, pid: OTHER_PI_PID, startedAt: "4343:1" }
              : pid === SHELL_PID
                ? { executable: "/bin/zsh", parentPid: 1, pid: SHELL_PID, startedAt: "4000:1" }
                : undefined,
    };
    // Owner B registers and saves a bind proposal under its own session.
    parent = OTHER_PI_PID;
    expect(
      await run(
        root,
        "session-start",
        capture("session-start", { nativeSessionId: OTHER_SESSION, pid: OTHER_PI_PID }),
        twoOwners,
      ),
    ).toMatchObject({ kind: "registered", v: 1 });
    const ownerB = registeredTo(root, OTHER_PI_PID);
    if (!ownerB.ok) throw new Error(ownerB.message);
    const proposal = saveNativeProposal(root, ownerB.value, { conversationId, kind: "bind" });
    // Owner A's callback reports B's proposal: its session differs, so the commit refuses.
    parent = PI_PID;
    const result = await run(
      root,
      "tool-result",
      {
        ...capture("tool-result"),
        markers: [`lucid-pi-proposal:${proposal.nonce}`],
        toolCallId: "call-1",
      },
      twoOwners,
    );
    if (result.kind !== "committed") throw new Error("Missing mismatch result");
    expect(result.text).toContain(`${proposal.nonce}: refused (proposal-session-mismatch)`);
    expect(readConnection(conversations(root).dirFor(conversationId))).toMatchObject({
      reason: "proposal-session-mismatch",
      state: "setup-required",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a commit names its registration: a replaced generation refuses and changes nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-pi-hook-generation-"));
  try {
    const conversationId = publicationRecord(root, "pi replaced record");
    expect(await run(root, "session-start", capture("session-start"))).toMatchObject({
      kind: "registered",
    });
    const first = registered(root);
    if (!first.ok) throw new Error(first.message);
    const proposal = saveNativeProposal(root, first.value, {
      conversationId,
      kind: "receipt",
      offerId: crypto.randomUUID(),
    });
    // The same owner re-registers: generation 2 replaces generation 1 under the same key.
    expect(await run(root, "session-start", capture("session-start"))).toMatchObject({
      kind: "registered",
    });
    const dir = conversations(root).dirFor(conversationId);
    const before = viewConversation(dir).state.seq;
    const result = await run(root, "tool-result", {
      ...capture("tool-result"),
      markers: [`lucid-pi-proposal:${proposal.nonce}`],
      toolCallId: "call-1",
    });
    if (result.kind !== "committed") throw new Error("Missing replaced result");
    expect(result.text).toContain(`${proposal.nonce}: refused (registration-replaced)`);
    expect(viewConversation(dir).state.seq).toBe(before);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("commitOperation itself names its registration: a stale generation refuses and changes nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-pi-hook-direct-commit-"));
  try {
    const conversationId = publicationRecord(root, "pi direct commit record");
    expect(await run(root, "session-start", capture("session-start"))).toMatchObject({
      kind: "registered",
    });
    const first = registered(root);
    if (!first.ok) throw new Error(first.message);
    // Bind the record under generation 1 through the hook, as a real session does.
    const bind = saveNativeProposal(root, first.value, { conversationId, kind: "bind" });
    expect(
      await run(root, "tool-result", {
        ...capture("tool-result"),
        markers: [`lucid-pi-proposal:${bind.nonce}`],
        toolCallId: "call-1",
      }),
    ).toMatchObject({ kind: "committed", v: 1 });
    // The same owner re-registers: generation 2 replaces generation 1 under the same key.
    expect(await run(root, "session-start", capture("session-start"))).toMatchObject({
      kind: "registered",
    });
    const second = registered(root);
    if (!second.ok) throw new Error(second.message);
    expect(second.value.registrationId).not.toBe(first.value.registrationId);
    const records = conversations(root);
    const dir = records.dirFor(conversationId);
    const before = viewConversation(dir).state.seq;
    // Called directly, with no earlier proposal checks to catch the case first.
    const receipt = commitOperation(
      records,
      { kind: "receipt", conversationId, offerId: crypto.randomUUID() },
      first.value,
      piSessionAuthority(SESSION, deps().probe),
    );
    expect(receipt).toContain("stale-registration");
    expect(viewConversation(dir).state.seq).toBe(before);
    const listen = commitOperation(
      records,
      { kind: "listen", conversationId },
      first.value,
      piSessionAuthority(SESSION, deps().probe),
    );
    expect(listen).toContain("stale-registration");
    expect(viewConversation(dir).state.seq).toBe(before);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a commit whose registration was removed refuses as registration-missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-pi-hook-missing-"));
  try {
    const conversationId = publicationRecord(root, "pi missing record");
    expect(await run(root, "session-start", capture("session-start"))).toMatchObject({
      kind: "registered",
    });
    const binding = registered(root);
    if (!binding.ok) throw new Error(binding.message);
    const proposal = saveNativeProposal(root, binding.value, { conversationId, kind: "bind" });
    expect(await run(root, "session-shutdown", capture("session-shutdown"))).toEqual({
      kind: "removed",
      removed: true,
      v: 1,
    });
    const result = await run(root, "tool-result", {
      ...capture("tool-result"),
      markers: [`lucid-pi-proposal:${proposal.nonce}`],
      toolCallId: "call-1",
    });
    if (result.kind !== "committed") throw new Error("Missing refusal result");
    expect(result.text).toContain(`${proposal.nonce}: refused (registration-missing)`);
    // The bind refusal is saved beside the publication; with no registration at all
    // that is the terminal headless-fallback reason, as at publish time.
    expect(readConnection(conversations(root).dirFor(conversationId))).toMatchObject({
      reason: "registration-missing",
      state: "headless-fallback",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a busy registry saves nothing and tells the model to run the command again", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-pi-hook-busy-"));
  try {
    const conversationId = publicationRecord(root, "pi busy record");
    expect(await run(root, "session-start", capture("session-start"))).toMatchObject({
      kind: "registered",
    });
    const binding = registered(root);
    if (!binding.ok) throw new Error(binding.message);
    const proposal = saveNativeProposal(root, binding.value, { conversationId, kind: "bind" });
    const lock = acquireAppendLock(join(root, ".registrations", "registry"), {
      privateFile: true,
      timeoutMs: 0,
    });
    try {
      const result = await run(root, "tool-result", {
        ...capture("tool-result"),
        markers: [`lucid-pi-proposal:${proposal.nonce}`],
        toolCallId: "call-1",
      });
      if (result.kind !== "committed") throw new Error("Missing busy result");
      expect(result.text).toContain(
        `${proposal.nonce}: not recorded, Lucid was busy; run the command again`,
      );
    } finally {
      lock.release();
    }
    // Nothing was saved beside the publication: the proposal can simply run again.
    expect(readConnection(conversations(root).dirFor(conversationId))).toMatchObject({
      reason: "publication-connection-incomplete",
      state: "setup-required",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

/** Save one managed feedback input, as the person's saved feedback for the listener. */
async function savedFeedback(dir: string, inputId: string, text: string): Promise<void> {
  const host = openWriter(dir);
  try {
    expect(host.acceptInput({ id: inputId, mode: "queue", text }, { managed: true }).verdict).toBe(
      "accepted",
    );
  } finally {
    host.close();
  }
}

describe("the settled listener helper", () => {
  test("settled with no listen request returns a skipped listener", async () => {
    const root = mkdtempSync(join(tmpdir(), "lucid-pi-hook-settled-skip-"));
    try {
      expect(await run(root, "session-start", capture("session-start"))).toMatchObject({
        kind: "registered",
      });
      expect(await run(root, "settled", capture("settled"))).toEqual({
        kind: "listener",
        result: { kind: "skipped" },
        v: 1,
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("settled after a committed listen proposal and saved feedback returns offered and records the offer", async () => {
    const root = mkdtempSync(join(tmpdir(), "lucid-pi-hook-settled-offer-"));
    try {
      const conversationId = "pi settled record";
      await boundListeningRecord(root, conversationId);
      const dir = conversations(root).dirFor(conversationId);
      const feedback = "Complete browser feedback for the Pi session.";
      await savedFeedback(dir, "feedback", feedback);
      let now = Date.now();
      const result = await run(root, "settled", capture("settled"), {
        now: () => now,
        wait: async (ms: number) => {
          now += ms;
        },
      });
      if (result.kind !== "listener") throw new Error("Missing listener result");
      expect(result.result.kind).toBe("offered");
      if (result.result.kind !== "offered") throw new Error("Missing offer");
      // pi-cli's transport encodes the prompt as plain text for `sendUserMessage`.
      expect(result.result.payload).toContain(feedback);
      expect(result.result.payload).toContain("lucid connection receipt");
      // The record carries the offer-started fact as an in-flight sending offer,
      // as the Claude Stop delivery does.
      const offers = viewConversation(dir).state.connection?.offers ?? {};
      expect(offers[result.result.offerId]?.kind).toBe("sending");
      // The helper prints this result as one JSON line, and the extension kills a
      // helper whose stdout passes 49,152 bytes: a direct offer stays below it.
      expect(
        Buffer.byteLength(JSON.stringify({ kind: "listener", result: result.result, v: 1 })),
      ).toBeLessThanOrEqual(49_152);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("feedback whose JSON escaping passes the pi bound is held, never offered directly", async () => {
    const root = mkdtempSync(join(tmpdir(), "lucid-pi-hook-settled-escape-"));
    try {
      // About 30,000 raw bytes: under a raw 40,000 bound, but JSON.stringify
      // doubles it past 40,000, and the helper's own JSON line past 49,152.
      const { dir, request } = await piListeningFixture(
        root,
        "pi escaped feedback record",
        '"\n'.repeat(15_000),
      );
      let now = Date.now();
      const result = await listenStopFeedback(
        conversations(root),
        "pi escaped feedback record",
        { request, signal: new AbortController().signal, source: "explicit" },
        {
          authority: { callerOwns: () => true, ownerPresence: () => true },
          now: () => now,
          wait: async (ms: number) => {
            now += ms;
          },
        },
      );
      // Never a direct offer: a payload whose JSON form exceeds the transport bound.
      expect(result.kind).not.toBe("offered");
      expect(result).toMatchObject({ kind: "stopped", reason: "expired" });
      expect(viewConversation(dir).state.connection?.offers ?? {}).toEqual({});
      expect(viewConversation(dir).state.connection?.heldInputs.feedback?.reason).toBe(
        "context-too-large",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("oversized context moves to a pi reference copy whose read command bounds bytes and lines", async () => {
    const root = mkdtempSync(join(tmpdir(), "lucid-pi-hook-settled-reference-"));
    let copy = "";
    try {
      const conversationId = "pi reference record";
      const { dir, request } = await piListeningFixture(
        root,
        conversationId,
        "Review the document.",
        async (host) => {
          // A large current document pushes the rendered context past the byte bound
          // while the pending request stays small enough to carry inline.
          expect(
            (
              await host.writeArtifact({
                artifactId: "doc",
                author: "agent",
                bytes: `plain document text `.repeat(2_400),
                contentType: "text/html",
                version: 1,
              })
            ).verdict,
          ).toBe("accepted");
        },
      );
      let now = Date.now();
      const result = await listenStopFeedback(
        conversations(root),
        conversationId,
        { request, signal: new AbortController().signal, source: "explicit" },
        {
          authority: { callerOwns: () => true, ownerPresence: () => true },
          now: () => now,
          wait: async (ms: number) => {
            now += ms;
          },
        },
      );
      expect(result.kind).toBe("offered");
      if (result.kind !== "offered") throw new Error("Missing reference offer");
      // Pi's Bash tool truncates by lines as well as bytes, so the read command
      // carries both bounds.
      expect(result.payload).toContain("--offset 0 --bytes 40000 --lines 1900");
      copy = result.payload.match(/lucid context '([^']+)'/)?.[1] ?? "";
      if (!copy) throw new Error("Missing context copy path");
      const offers = viewConversation(dir).state.connection?.offers ?? {};
      expect(offers[result.offerId]?.kind).toBe("sending");
      expect(offers[result.offerId]?.offer.delivery).toMatchObject({ kind: "reference" });
    } finally {
      if (copy) rmSync(copy, { force: true, recursive: true });
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("settled whose registration owner is another Pi process refuses and starts no listener", async () => {
    const root = mkdtempSync(join(tmpdir(), "lucid-pi-hook-settled-owner-"));
    try {
      const conversationId = "pi settled owner record";
      await boundListeningRecord(root, conversationId);
      const dir = conversations(root).dirFor(conversationId);
      await savedFeedback(dir, "feedback", "Feedback for the wrong process.");
      // A second Pi process (4343) nested under the registered owner (4242) claims
      // the registered session: the registry corroborates the ancestry, but the
      // helper's owner is not the registration's owner.
      const nested = {
        parentPid: () => OTHER_PI_PID,
        probe: (pid: number) =>
          pid === process.pid
            ? {
                executable: "/bin/agent-shell",
                parentPid: OTHER_PI_PID,
                pid,
                startedAt: `${pid}:0`,
              }
            : pid === OTHER_PI_PID
              ? { executable: PI_EXE, parentPid: PI_PID, pid: OTHER_PI_PID, startedAt: "4343:1" }
              : pid === PI_PID
                ? { executable: PI_EXE, parentPid: SHELL_PID, pid: PI_PID, startedAt: "4242:1" }
                : pid === SHELL_PID
                  ? { executable: "/bin/zsh", parentPid: 1, pid: SHELL_PID, startedAt: "4000:1" }
                  : undefined,
      };
      const result = await run(root, "settled", capture("settled", { pid: OTHER_PI_PID }), nested);
      expect(result).toEqual({
        kind: "refused",
        message:
          "This Pi session's registration names a different Pi process, so Lucid does not listen in this session.",
        reason: "proposal-session-mismatch",
        v: 1,
      });
      const connection = viewConversation(dir).state.connection;
      expect(connection?.listenerId ?? null).toBeNull();
      expect(connection?.offers ?? {}).toEqual({});
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("settled from the same pid but a different process generation refuses", async () => {
    const root = mkdtempSync(join(tmpdir(), "lucid-pi-hook-settled-generation-"));
    try {
      const conversationId = "pi settled generation record";
      await boundListeningRecord(root, conversationId);
      const dir = conversations(root).dirFor(conversationId);
      await savedFeedback(dir, "feedback", "Feedback for a replaced process.");
      // The parent check reads a newer process generation on the registered pid;
      // the registry then corroborates the registered generation. A pid-only
      // comparison would pass here and listen under the replaced process.
      let ownerRead = 0;
      const restarted = {
        probe: (pid: number) => {
          if (pid === PI_PID) {
            ownerRead += 1;
            return {
              executable: PI_EXE,
              parentPid: SHELL_PID,
              pid: PI_PID,
              startedAt: ownerRead === 1 ? "4242:2" : "4242:1",
            };
          }
          return deps().probe(pid);
        },
      };
      const result = await run(root, "settled", capture("settled"), restarted);
      expect(result).toMatchObject({ kind: "refused", reason: "proposal-session-mismatch", v: 1 });
      const connection = viewConversation(dir).state.connection;
      expect(connection?.listenerId ?? null).toBeNull();
      expect(connection?.offers ?? {}).toEqual({});
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("settled with no registration returns a skipped listener, not a refusal", async () => {
    const root = mkdtempSync(join(tmpdir(), "lucid-pi-hook-settled-unregistered-"));
    try {
      // A capture whose parent chain no longer corroborates any registration.
      expect(
        await run(root, "settled", capture("settled", { nativeSessionId: OTHER_SESSION })),
      ).toEqual({ kind: "listener", result: { kind: "skipped" }, v: 1 });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("an aborted signal ends the settled wait without an offer", async () => {
    const root = mkdtempSync(join(tmpdir(), "lucid-pi-hook-settled-abort-"));
    try {
      const conversationId = "pi settled abort record";
      await boundListeningRecord(root, conversationId);
      // No feedback is saved, so the listener waits; the wait seam aborts it.
      const controller = new AbortController();
      let now = Date.now();
      const result = await run(root, "settled", capture("settled"), {
        now: () => now,
        signal: controller.signal,
        wait: async (ms: number) => {
          now += ms;
          controller.abort();
        },
      });
      if (result.kind !== "listener") throw new Error("Missing listener result");
      expect(result.result.kind).not.toBe("offered");
      expect(result.result).toEqual({ kind: "stopped", reason: "interrupted" });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("an aborted signal passed through dispatch ends the settled wait interrupted", async () => {
    const root = mkdtempSync(join(tmpdir(), "lucid-pi-hook-settled-dispatch-"));
    try {
      const conversationId = "pi settled dispatch record";
      await boundListeningRecord(root, conversationId);
      // No feedback is saved, so the listener waits; only the signal dispatch passes
      // can end the wait, and the injected hook adds nothing dispatch did not send.
      const controller = new AbortController();
      const fakeDeps = deps();
      let now = Date.now();
      let received: AbortSignal | undefined;
      const output: string[] = [];
      const result = await dispatch(["_pi-hook", "settled", "--root", root], {
        onOutput: (line: string) => output.push(line),
        piCaptureInput: (async function* () {
          yield JSON.stringify(capture("settled"));
        })(),
        piHookFn: (records, event, text, hookDeps) => {
          received = hookDeps?.signal;
          return runPiHook(records, event, text, {
            ...fakeDeps,
            now: () => now,
            signal: hookDeps?.signal,
            wait: async (ms: number) => {
              now += ms;
              controller.abort();
            },
          });
        },
        rootDir: root,
        signal: controller.signal,
      } satisfies DispatchDeps);
      expect(result).toEqual({ kind: "pi-hook" });
      expect(received).toBe(controller.signal);
      expect(JSON.parse(output[0] ?? "{}")).toEqual({
        kind: "listener",
        result: { kind: "stopped", reason: "interrupted" },
        v: 1,
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("requestNativeListening for a pi-cli registration is requested, not transport-unverified", async () => {
    const root = mkdtempSync(join(tmpdir(), "lucid-pi-hook-requested-"));
    try {
      const conversationId = "pi requested record";
      publicationRecord(root, conversationId);
      expect(
        await run(root, "session-start", { ...capture("session-start"), workingDirectory: root }),
      ).toMatchObject({ kind: "registered" });
      const binding = registered(root);
      if (!binding.ok) throw new Error(binding.message);
      const bind = saveNativeProposal(root, binding.value, { conversationId, kind: "bind" });
      expect(
        await run(root, "tool-result", {
          ...capture("tool-result"),
          markers: [`lucid-pi-proposal:${bind.nonce}`],
          toolCallId: "call-bind",
        }),
      ).toMatchObject({ kind: "committed", v: 1 });
      const result = requestNativeListening(
        conversations(root),
        conversationId,
        piSessionAuthority(SESSION, deps().probe),
        binding.value.registrationId,
      );
      expect(result).toMatchObject({ conversationId, kind: "requested" });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("the dispatch capture reader", () => {
  const input = (text: string, chunkBytes = 4096) => ({
    async *[Symbol.asyncIterator]() {
      for (let offset = 0; offset < text.length; offset += chunkBytes)
        yield text.slice(offset, offset + chunkBytes);
    },
  });
  const hook = async (text: string) => {
    const root = mkdtempSync(join(tmpdir(), "lucid-pi-hook-reader-"));
    try {
      const output: string[] = [];
      const result = await dispatch(["_pi-hook", "session-start", "--root", root], {
        onOutput: (line: string) => output.push(line),
        piCaptureInput: input(text),
        rootDir: root,
      } satisfies DispatchDeps);
      expect(result).toEqual({ kind: "pi-hook" });
      expect(output).toHaveLength(1);
      expect(existsSync(join(root, ".registrations"))).toBe(false);
      return JSON.parse(output[0] ?? "{}");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  };
  test("65536 bytes reach the parser and refuse as an invalid capture", async () => {
    expect(await hook("x".repeat(65536))).toMatchObject({
      kind: "refused",
      message: "The Pi hook capture is invalid.",
      reason: "invalid-capture",
      v: 1,
    });
  });
  test("65537 bytes are refused by the reader before parsing", async () => {
    expect(await hook("x".repeat(65537))).toMatchObject({
      kind: "refused",
      message: "The Pi hook capture is too large.",
      reason: "invalid-capture",
      v: 1,
    });
  });
});

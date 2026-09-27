import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DispatchDeps } from "../../src/cli/dispatch.js";
import { dispatch } from "../../src/cli/dispatch.js";
import type { PiHookDeps } from "../../src/cli/hooks/pi.js";
import { runPiHook } from "../../src/cli/hooks/pi.js";
import { mapSubcommand } from "../../src/cli/mapping.js";
import { conversations } from "../../src/cli/record-addressing.js";
import { readConnection } from "../../src/store/connection-view.js";
import { openWriter, viewConversation } from "../../src/store/conversation-host.js";
import { acquireAppendLock } from "../../src/store/flock.js";
import { saveNativeProposal } from "../../src/store/native-proposals.js";
import { withNativeRegistration } from "../../src/store/native-registration.js";

const SESSION = "pi-session-01";
const OTHER_SESSION = "pi-session-02";
const PI_PID = 4242;
const OTHER_PI_PID = 4343;
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

/** The synthetic process chain: this test process, its parent the Pi runtime. */
const deps = (overrides: Partial<PiHookDeps> = {}): PiHookDeps => ({
  now: () => Date.now(),
  parentPid: () => PI_PID,
  probe: (pid: number) =>
    pid === process.pid
      ? { executable: "/bin/agent-shell", parentPid: PI_PID, pid, startedAt: `${pid}:0` }
      : pid === PI_PID
        ? { executable: PI_EXE, parentPid: 1, pid: PI_PID, startedAt: "4242:1" }
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
  event: "session-start" | "session-shutdown" | "tool-result",
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
    expect(mapSubcommand(["_pi-hook", "settled"]).kind).toBe("help");
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
    expect(await run(root, "session-start", capture("session-start"))).toMatchObject({
      kind: "registered",
    });
    const binding = registered(root);
    if (!binding.ok) throw new Error(binding.message);
    const proposal = saveNativeProposal(root, binding.value, {
      conversationId,
      kind: "listen",
    });
    const result = await run(root, "tool-result", {
      ...capture("tool-result"),
      markers: [`lucid-pi-proposal:${proposal.nonce}`],
      toolCallId: "call-1",
    });
    expect(result).toMatchObject({ kind: "committed", v: 1 });
    if (result.kind !== "committed") throw new Error("Missing commit result");
    expect(result.text).toContain(`Listening for ${conversationId}`);
    // pi-cli has no verified Stop transport until RFC 28 slice 4: the commit
    // reports the held transport instead of saving a listening request.
    expect(result.text).toContain("no verified feedback transport");
    expect(
      withNativeRegistration(root, undefined, (_binding, access) => access.readListenRequest(), {
        callerOwns: () => true,
        ownerPresence: () => true,
      }),
    ).toMatchObject({ ok: true, value: { ok: true, value: null } });
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
    expect(
      readConnection(conversations(root).dirFor(conversationId), { ownerPresence: () => true }),
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
            ? { executable: PI_EXE, parentPid: 1, pid: PI_PID, startedAt: "4242:1" }
            : pid === OTHER_PI_PID
              ? { executable: PI_EXE, parentPid: 1, pid: OTHER_PI_PID, startedAt: "4343:1" }
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

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DispatchDeps } from "../../src/cli/dispatch.js";
import { dispatch } from "../../src/cli/dispatch.js";
import type { PiHookDeps } from "../../src/cli/hooks/pi.js";
import { runPiHook } from "../../src/cli/hooks/pi.js";
import { mapSubcommand } from "../../src/cli/mapping.js";
import { conversations } from "../../src/cli/record-addressing.js";
import { readConnection } from "../../src/store/connection-view.js";
import { openWriter } from "../../src/store/conversation-host.js";
import { saveNativeProposal } from "../../src/store/native-proposals.js";
import { withNativeRegistration } from "../../src/store/native-registration.js";

const SESSION = "pi-session-01";
const OTHER_SESSION = "pi-session-02";
const PI_PID = 4242;
const PI_EXE = "/opt/pi-runtime/bin/node";

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

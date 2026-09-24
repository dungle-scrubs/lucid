import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DispatchDeps } from "../../src/cli/dispatch.js";
import { dispatch } from "../../src/cli/dispatch.js";
import { captureCodexAuthor, runCodexHook } from "../../src/cli/hooks/codex.js";
import { nativeCommandAuthority } from "../../src/cli/native-context.js";
import { requestNativeListening } from "../../src/cli/native-listening.js";
import { conversations } from "../../src/cli/record-addressing.js";
import { readProcessOwner } from "../../src/process-owner.js";
import type { ProcessOwner } from "../../src/protocol/process-owner.js";
import { openWriter, viewConversation } from "../../src/store/conversation-host.js";
import { presenceHeld } from "../../src/store/presence.js";
import { createConversationRecord } from "../../src/store/store.js";

interface NativeFixture {
  readonly deps: DispatchDeps;
  readonly dir: string;
  readonly id: string;
  readonly output: string[];
  readonly owner: ProcessOwner;
  readonly root: string;
}

async function nativeFixture(): Promise<NativeFixture> {
  const root = mkdtempSync(join(tmpdir(), "lucid-codex-delivery-"));
  try {
    const owner = readProcessOwner(process.pid);
    if (!owner) throw new Error("Test process identity unavailable");
    const registration = await captureCodexAuthor(
      root,
      {
        cwd: root,
        hook_event_name: "SessionStart",
        session_id: "native-author",
        source: "startup",
      },
      { owner: async () => owner, role: undefined },
    );
    expect(registration.ok).toBe(true);
    const nativeAuthority = nativeCommandAuthority({
      codexSessionId: "native-author",
      codexThreadId: "native-author",
      role: undefined,
    });
    const output: string[] = [];
    const deps = { nativeAuthority, onOutput: (line: string) => output.push(line), rootDir: root };
    const request = join(root, "publication.json");
    writeFileSync(
      request,
      JSON.stringify({
        artifact: {
          artifactId: "flow",
          bytes:
            '<html><head><meta name="lucid-theme" content="adaptive"></head><body><h1>Exact artifact context</h1></body></html>',
          contentType: "text/html",
          version: 1,
        },
        creationId: "native-flow",
        serverUrl: "http://127.0.0.1:17454",
        settings: { effort: "high", harness: "codex", model: "test", profile: "headless-turn" },
        workingDirectory: root,
      }),
    );
    await dispatch(["artifact", "publish", "--request", request, "--json"], deps);
    const publication = JSON.parse(output.pop() ?? "null");
    expect(publication.connection).toMatchObject({
      state: "not-listening",
      nativeSessionId: "native-author",
    });
    const id = publication.conversationId;
    const dir = conversations(root).dirFor(id);
    return { deps, dir, id, output, owner, root };
  } catch (cause) {
    rmSync(root, { force: true, recursive: true });
    throw cause;
  }
}

test("selecting another record cannot escape an unresolved offer to the same native session", async () => {
  const { deps, dir, id, owner, root } = await nativeFixture();
  try {
    const binding = viewConversation(dir).state.connection?.binding;
    if (!binding) throw new Error("Missing native binding");
    const other = createConversationRecord(root, "second", { workingDirectory: root });
    const second = openWriter(other.paths.dir, { connectionAuthority: () => binding });
    try {
      expect(
        second.writeConnection({ actionId: crypto.randomUUID(), binding, kind: "bound" }).verdict,
      ).toBe("accepted");
      second.acceptInput({ id: "second-feedback", mode: "queue", text: "Second input" });
    } finally {
      second.close();
    }
    const first = openWriter(dir);
    try {
      first.acceptInput({ id: "first-feedback", mode: "queue", text: "First input" });
    } finally {
      first.close();
    }
    expect(await dispatch(["connection", "resume-listen", id, "--json"], deps)).toMatchObject({
      verdict: "requested",
    });
    const callback = { cwd: root, hook_event_name: "Stop", session_id: "native-author" };
    const options = {
      native: { owner: async () => owner, role: undefined },
      signal: new AbortController().signal,
    };
    expect(await runCodexHook(conversations(root), callback, options)).toMatchObject({
      kind: "offered",
    });
    const before = viewConversation(dir).state;
    expect(await dispatch(["connection", "resume-listen", "second", "--json"], deps)).toMatchObject(
      { verdict: "held" },
    );
    expect(await runCodexHook(conversations(root), callback, options)).toMatchObject({
      kind: "skipped",
    });
    expect(viewConversation(dir).state.seq).toBe(before.seq);
    expect(
      Object.keys(viewConversation(other.paths.dir).state.connection?.offers ?? {}),
    ).toHaveLength(0);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a listening request checks other owners of the same native session across records", async () => {
  const { deps, dir, id, root } = await nativeFixture();
  try {
    const original = viewConversation(dir).state.connection?.binding;
    if (!original || !deps.nativeAuthority) throw new Error("Missing fixture authority");
    const binding = { ...original, owner: { ...original.owner, pid: 43210 } };
    const other = createConversationRecord(root, "other-owner", { workingDirectory: root });
    const writer = openWriter(other.paths.dir, {
      connectionAuthority: () => binding,
      ownerPresence: () => true,
    });
    try {
      expect(
        writer.writeConnection({ actionId: crypto.randomUUID(), binding, kind: "bound" }).verdict,
      ).toBe("accepted");
    } finally {
      writer.close();
    }
    for (const present of [true, undefined]) {
      expect(
        requestNativeListening(conversations(root), id, {
          callerOwns: deps.nativeAuthority.callerOwns,
          ownerPresence: (owner) => (owner.pid === 43210 ? present : true),
        }),
      ).toMatchObject({
        kind: "held",
        reason: present ? "connection-conflict" : "connection-unverified",
      });
    }
    expect(
      requestNativeListening(conversations(root), id, {
        callerOwns: deps.nativeAuthority.callerOwns,
        ownerPresence: (owner) => owner.pid !== 43210,
      }),
    ).toMatchObject({ kind: "requested" });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("native command delivery preserves full feedback and only its parent can settle the offer", async () => {
  const { deps, dir, id, output, owner, root } = await nativeFixture();
  try {
    let now = Date.now();
    const hookOptions = {
      listener: {
        now: () => now,
        wait: async (ms: number) => {
          now += ms;
        },
      },
      native: { owner: async () => owner, role: undefined },
      signal: new AbortController().signal,
    };
    const callback = { cwd: root, hook_event_name: "Stop", session_id: "native-author" };
    const host = openWriter(dir);
    const feedback = "Complete feedback including Unicode: ก🙂 and its final sentence.";
    try {
      expect(
        host.acceptInput({ id: "feedback", mode: "queue", text: feedback }, { managed: true })
          .verdict,
      ).toBe("accepted");
    } finally {
      host.close();
    }
    expect(await dispatch(["connection", "resume-listen", id, "--json"], deps)).toEqual({
      kind: "connection-listen",
      verdict: "requested",
    });
    expect(JSON.parse(output.pop() ?? "null")).toMatchObject({
      kind: "requested",
      conversationId: id,
    });
    expect(Object.keys(viewConversation(dir).state.connection?.offers ?? {})).toHaveLength(0);
    const delivery = await runCodexHook(conversations(root), callback, hookOptions);
    expect(delivery.kind).toBe("offered");
    if (delivery.kind !== "offered") throw new Error("Missing native Stop delivery");
    const delivered = JSON.parse(delivery.payload);
    expect(delivered.decision).toBe("block");
    expect(delivered.reason).toContain(feedback);
    expect(delivered.reason).toContain("<h1>Exact artifact context</h1>");
    const offerId = Object.keys(viewConversation(dir).state.connection?.offers ?? {})[0];
    if (!offerId) throw new Error("Missing durable offer");
    const child = nativeCommandAuthority({
      codexSessionId: "native-author",
      codexThreadId: "child",
      role: undefined,
    });
    const receipt = ["connection", "receipt", id, "--offer", offerId, "--json"];
    expect(await dispatch(receipt, { ...deps, nativeAuthority: child })).toMatchObject({
      verdict: "refused",
    });
    expect(await dispatch(receipt, deps)).toMatchObject({ verdict: "accepted" });
    const response = join(root, "response.json");
    writeFileSync(
      response,
      JSON.stringify({ kind: "answer", text: "Response saved by the native author." }),
    );
    expect(
      await dispatch(
        ["connection", "respond", id, "--offer", offerId, "--request", response, "--json"],
        deps,
      ),
    ).toMatchObject({ verdict: "accepted" });
    expect(viewConversation(dir).state.connection?.offers[offerId]).toMatchObject({
      kind: "finished",
      outcome: { kind: "answer", text: "Response saved by the native author." },
    });
    // Explicit same-ID return creates a new lifecycle, while publication keeps its original binding.
    expect(
      await captureCodexAuthor(
        root,
        {
          cwd: root,
          hook_event_name: "SessionStart",
          session_id: "native-author",
          source: "resume",
        },
        { owner: async () => owner, role: undefined },
      ),
    ).toMatchObject({ ok: true });
    const returned = openWriter(dir);
    try {
      expect(
        returned.acceptInput(
          { id: "returned-feedback", mode: "queue", text: "Continue after explicit return." },
          { managed: true },
        ).verdict,
      ).toBe("accepted");
    } finally {
      returned.close();
    }
    expect(await dispatch(["connection", "resume-listen", id, "--json"], deps)).toMatchObject({
      verdict: "requested",
    });
    expect(await runCodexHook(conversations(root), callback, hookOptions)).toMatchObject({
      kind: "offered",
    });
    const returnedOfferId = Object.keys(viewConversation(dir).state.connection?.offers ?? {}).find(
      (key) => key !== offerId,
    );
    if (!returnedOfferId) throw new Error("Missing returned lifecycle offer");
    expect(
      await dispatch(["connection", "receipt", id, "--offer", returnedOfferId, "--json"], deps),
    ).toMatchObject({ verdict: "accepted" });
    expect(
      await dispatch(
        ["connection", "respond", id, "--offer", returnedOfferId, "--request", response, "--json"],
        deps,
      ),
    ).toMatchObject({ verdict: "accepted" });
    const started = now;
    expect(await runCodexHook(conversations(root), callback, hookOptions)).toEqual({
      kind: "stopped",
      reason: "expired",
    });
    expect(now - started).toBe(45_000);
    expect(viewConversation(dir).state.connection?.disabledReason).toBe("expired");
    expect(await runCodexHook(conversations(root), callback, hookOptions)).toEqual({
      kind: "skipped",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("the first empty wait starts at Stop, expires once, and a pending Interrupt prevents re-entry", async () => {
  const { deps, dir, id, owner, root } = await nativeFixture();
  try {
    const records = conversations(root);
    const callback = { cwd: root, hook_event_name: "Stop", session_id: "native-author" };
    let now = Date.now();
    const start = now;
    const options = {
      listener: {
        now: () => now,
        wait: async (ms: number) => {
          now += ms;
        },
      },
      native: { owner: async () => owner, role: undefined },
      signal: new AbortController().signal,
    };
    const before = viewConversation(dir).state;
    expect(await dispatch(["connection", "resume-listen", id, "--json"], deps)).toMatchObject({
      verdict: "requested",
    });
    expect(viewConversation(dir).state.seq).toBe(before.seq);
    expect(presenceHeld(dir)).toBe(false);
    expect(await runCodexHook(records, callback, options)).toEqual({
      kind: "stopped",
      reason: "expired",
    });
    expect(now - start).toBe(45_000);
    expect(await runCodexHook(records, callback, options)).toEqual({ kind: "skipped" });
    const expired = viewConversation(dir).state;
    expect(await dispatch(["connection", "resume-listen", id, "--json"], deps)).toMatchObject({
      verdict: "requested",
    });
    expect(
      await runCodexHook(records, { ...callback, hook_event_name: "Interrupt" }, options),
    ).toEqual({ kind: "skipped" });
    expect(await runCodexHook(records, callback, options)).toEqual({ kind: "skipped" });
    expect(viewConversation(dir).state.seq).toBe(expired.seq);
    expect(now - start).toBe(45_000);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Stop and Interrupt use the selected record even when an unrelated history is unreadable", async () => {
  const { deps, dir, id, owner, root } = await nativeFixture();
  try {
    expect(await dispatch(["connection", "resume-listen", id, "--json"], deps)).toMatchObject({
      verdict: "requested",
    });
    const other = createConversationRecord(root, "unrelated", { workingDirectory: root });
    writeFileSync(join(other.paths.dir, "log.ndjson"), "invalid synthetic log\n");
    const records = conversations(root);
    const callback = { cwd: root, hook_event_name: "Stop", session_id: "native-author" };
    let now = Date.now();
    const native = { owner: async () => owner, role: undefined };
    const signal = new AbortController().signal;
    const result = await runCodexHook(records, callback, {
      native,
      signal,
      listener: {
        now: () => now,
        wait: async (ms: number) => {
          now += ms;
          expect(
            await runCodexHook(
              records,
              { ...callback, hook_event_name: "Interrupt" },
              { native, signal },
            ),
          ).toEqual({ kind: "stopped", reason: "interrupted" });
        },
      },
    });
    expect(result).toEqual({ kind: "stopped", reason: "interrupted" });
    expect(viewConversation(dir).state.connection?.disabledReason).toBe("interrupted");
    expect(presenceHeld(dir)).toBe(false);
    expect(await runCodexHook(records, callback, { native, signal })).toEqual({ kind: "skipped" });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

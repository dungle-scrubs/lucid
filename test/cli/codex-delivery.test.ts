import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../../src/cli/dispatch.js";
import { captureCodexAuthor, runCodexHook } from "../../src/cli/hooks/codex.js";
import { nativeCommandAuthority } from "../../src/cli/native-context.js";
import { conversations } from "../../src/cli/record-addressing.js";
import { readProcessOwner } from "../../src/process-owner.js";
import { openWriter, viewConversation } from "../../src/store/conversation-host.js";

test("native command delivery preserves full feedback and only its parent can settle the offer", async () => {
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
          bytes: "<h1>Exact artifact context</h1>",
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
      verdict: "offered",
    });
    const delivered = JSON.parse(output.pop() ?? "null");
    expect(delivered.kind).toBe("offered");
    expect(delivered.text).toContain(feedback);
    expect(delivered.text).toContain("<h1>Exact artifact context</h1>");
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
      verdict: "offered",
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
    let now = Date.now();
    const started = now;
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

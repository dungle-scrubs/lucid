import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DispatchDeps } from "../../src/cli/dispatch.js";
import { dispatch } from "../../src/cli/dispatch.js";
import { captureClaudeAuthor, runClaudeHook } from "../../src/cli/hooks/claude.js";
import { claudeContextSlice } from "../../src/cli/native-listening.js";
import { conversations } from "../../src/cli/record-addressing.js";
import { prepareNativeFeedback } from "../../src/modes/native-preparation.js";
import { readProcessOwner } from "../../src/process-owner.js";
import type { ProcessOwner } from "../../src/protocol/process-owner.js";
import {
  CLAUDE_PROPOSAL_TTL_MS,
  claimClaudeProposal,
  saveClaudeProposal,
  writeStopBlocks,
} from "../../src/store/claude-proposals.js";
import { readConnection } from "../../src/store/connection-view.js";
import { readOfferedContext } from "../../src/store/context-offer.js";
import { openWriter, viewConversation } from "../../src/store/conversation-host.js";

const SESSION = "claude-parent";

interface ClaudeFixture {
  readonly deps: DispatchDeps;
  readonly dir: string;
  readonly id: string;
  readonly output: string[];
  readonly owner: ProcessOwner;
  readonly root: string;
}

const native = (owner: ProcessOwner, blockCap = 8) => ({
  blockCap,
  owner: async () => owner,
  role: undefined,
});

/** The parent PostToolUse callback for one Bash call whose output is `stdout`. */
const bashCallback = (root: string, stdout: string, extra: Record<string, unknown> = {}) => ({
  cwd: root,
  hook_event_name: "PostToolUse",
  session_id: SESSION,
  tool_name: "Bash",
  tool_response: { stderr: "", stdout },
  ...extra,
});

async function commit(root: string, owner: ProcessOwner, stdout: string, extra = {}) {
  return runClaudeHook(conversations(root), bashCallback(root, stdout, extra), {
    native: native(owner),
    signal: new AbortController().signal,
  });
}

async function claudeFixture(
  documentBytes = '<html><head><meta name="lucid-theme" content="adaptive"></head><body><h1>Exact artifact context</h1></body></html>',
): Promise<ClaudeFixture> {
  const root = mkdtempSync(join(tmpdir(), "lucid-claude-delivery-"));
  try {
    const owner = readProcessOwner(process.pid);
    if (!owner) throw new Error("Test process identity unavailable");
    expect(
      await captureClaudeAuthor(
        root,
        { cwd: root, hook_event_name: "SessionStart", session_id: SESSION, source: "startup" },
        native(owner),
      ),
    ).toMatchObject({ ok: true, registration: { interface: "claude-cli" } });
    const output: string[] = [];
    const deps = {
      claudeSession: SESSION,
      onOutput: (line: string) => output.push(line),
      rootDir: root,
    };
    const request = join(root, "publication.json");
    writeFileSync(
      request,
      JSON.stringify({
        artifact: {
          artifactId: "flow",
          bytes: documentBytes,
          contentType: "text/html",
          version: 1,
        },
        creationId: "claude-flow",
        serverUrl: "http://127.0.0.1:17454",
        settings: { effort: "high", harness: "claude", model: "test", profile: "headless-turn" },
        workingDirectory: root,
      }),
    );
    await dispatch(["artifact", "publish", "--request", request, "--json"], deps);
    const published = output.pop() ?? "null";
    const publication = JSON.parse(published);
    expect(publication.connection).toMatchObject({
      reason: "connection-pending",
      state: "setup-required",
    });
    const id = publication.conversationId;
    const dir = conversations(root).dirFor(id);
    // The document exists before the parent callback confirms the connection.
    expect(viewConversation(dir).state.connection).toBeNull();
    const bound = await commit(root, owner, published);
    expect(bound).toMatchObject({ kind: "committed" });
    expect(viewConversation(dir).state.connection?.binding).toMatchObject({
      interface: "claude-cli",
      nativeSessionId: SESSION,
    });
    return { deps, dir, id, output, owner, root };
  } catch (cause) {
    rmSync(root, { force: true, recursive: true });
    throw cause;
  }
}

test("SessionStart registers only the parent Claude Code lifecycle", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-claude-start-"));
  try {
    const owner = readProcessOwner(process.pid);
    if (!owner) throw new Error("Test process identity unavailable");
    const start = { cwd: root, hook_event_name: "SessionStart", session_id: SESSION };
    const deps = native(owner);
    for (const skipped of [
      { ...start, source: "startup", agent_id: "child", agent_type: "Explore" },
      { ...start, source: "compact" },
      { ...start, hook_event_name: "SubagentStart", source: "startup" },
    ])
      expect(await captureClaudeAuthor(root, skipped, deps)).toEqual({ ok: true, skipped: true });
    expect(
      await captureClaudeAuthor(
        root,
        { ...start, source: "startup" },
        { ...deps, role: "headless" },
      ),
    ).toEqual({ ok: true, skipped: true });
    expect(await captureClaudeAuthor(root, { ...start, source: "later" }, deps)).toMatchObject({
      ok: false,
      reason: "invalid-registration",
    });
    expect(
      await captureClaudeAuthor(
        root,
        { ...start, source: "startup" },
        { ...deps, owner: async () => undefined },
      ),
    ).toMatchObject({ ok: false, reason: "owner-unknown" });
    // A `--agent` main session carries agent_type without agent_id and is a parent lifecycle.
    const parent = await captureClaudeAuthor(
      root,
      { ...start, source: "startup", agent_type: "reviewer" },
      deps,
    );
    expect(parent).toMatchObject({ ok: true, registration: { nativeSessionId: SESSION } });
    expect(
      await captureClaudeAuthor(root, { ...start, hook_event_name: "Stop" }, deps),
    ).toMatchObject({ ok: true, registration: { nativeSessionId: SESSION } });
    expect(
      await captureClaudeAuthor(
        root,
        { ...start, hook_event_name: "Stop", session_id: "another" },
        deps,
      ),
    ).toMatchObject({ ok: false, reason: "registration-missing" });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a Claude tool command changes nothing until its parent Bash callback commits it", async () => {
  const { deps, dir, id, output, owner, root } = await claudeFixture();
  try {
    const before = viewConversation(dir).state.seq;
    expect(await dispatch(["connection", "resume-listen", id, "--json"], deps)).toEqual({
      kind: "connection-listen",
      verdict: "pending",
    });
    const pending = output.pop() ?? "null";
    expect(JSON.parse(pending)).toMatchObject({ verdict: "pending", conversationId: id });
    expect(viewConversation(dir).state.seq).toBe(before);
    // The subagent's callback carries the parent session ID and process; its marker refuses it.
    const child = await commit(root, owner, pending, { agent_id: "child", agent_type: "Explore" });
    expect(child).toMatchObject({ kind: "committed" });
    if (child.kind !== "committed") throw new Error("Missing subagent result");
    expect(child.context).toContain("ran in a subagent");
    // Claiming consumed it, so the parent cannot later commit the subagent's request.
    const replay = await commit(root, owner, pending);
    if (replay.kind !== "committed") throw new Error("Missing replay result");
    expect(replay.context).toContain("expired, was already used");
    expect(readConnection(dir, { ownerPresence: () => true, now: () => Date.now() }).state).toBe(
      "not-listening",
    );
    // A subagent's publication keeps its document and saves why it is not connected.
    const request = join(root, "subagent-publication.json");
    writeFileSync(
      request,
      JSON.stringify({
        artifact: {
          artifactId: "sub",
          bytes:
            '<html><head><meta name="lucid-theme" content="adaptive"></head><body><p>sub</p></body></html>',
          contentType: "text/html",
          version: 1,
        },
        creationId: "subagent-publication",
        serverUrl: "http://127.0.0.1:17454",
        workingDirectory: root,
      }),
    );
    await dispatch(["artifact", "publish", "--request", request, "--json"], deps);
    const published = output.pop() ?? "null";
    await commit(root, owner, published, { agent_id: "child", agent_type: "Explore" });
    expect(
      readConnection(conversations(root).dirFor(JSON.parse(published).conversationId)),
    ).toMatchObject({ reason: "subagent-provenance", state: "setup-required" });
    // Ordinary Bash output never touches proposal storage.
    expect(await commit(root, owner, "ordinary output")).toEqual({ kind: "skipped" });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Claude Code delivers complete feedback at Stop and records receipt and response from the parent", async () => {
  const { deps, dir, id, output, owner, root } = await claudeFixture();
  try {
    let now = Date.now();
    const records = conversations(root);
    const options = {
      listener: {
        now: () => now,
        wait: async (ms: number) => {
          now += ms;
        },
      },
      native: native(owner),
      signal: new AbortController().signal,
    };
    const stop = {
      cwd: root,
      hook_event_name: "Stop",
      session_id: SESSION,
      stop_hook_active: false,
    };
    const feedback = "Complete feedback including Unicode: ก🙂 and its final sentence.";
    const host = openWriter(dir);
    try {
      expect(
        host.acceptInput({ id: "feedback", mode: "queue", text: feedback }, { managed: true })
          .verdict,
      ).toBe("accepted");
    } finally {
      host.close();
    }
    await dispatch(["connection", "resume-listen", id, "--json"], deps);
    expect(await commit(root, owner, output.pop() ?? "")).toMatchObject({ kind: "committed" });
    const delivery = await runClaudeHook(records, stop, options);
    expect(delivery.kind).toBe("offered");
    if (delivery.kind !== "offered") throw new Error("Missing Claude Stop delivery");
    const delivered = JSON.parse(delivery.payload);
    expect(delivered.decision).toBe("block");
    expect(delivered.reason).toContain(feedback);
    expect(delivered.reason).toContain("<h1>Exact artifact context</h1>");
    expect(delivered.reason).toContain("its own foreground Bash call");
    const offerId = Object.keys(viewConversation(dir).state.connection?.offers ?? {})[0];
    if (!offerId) throw new Error("Missing durable offer");

    await dispatch(["connection", "receipt", id, "--offer", offerId, "--json"], deps);
    const receipt = output.pop() ?? "";
    expect(viewConversation(dir).state.connection?.offers[offerId]?.kind).toBe("sending");
    const received = await commit(root, owner, receipt);
    if (received.kind !== "committed") throw new Error("Missing receipt commit");
    expect(received.context).toContain("accepted");
    expect(viewConversation(dir).state.connection?.offers[offerId]?.kind).toBe("received");

    const response = join(root, "response.json");
    writeFileSync(response, JSON.stringify({ kind: "answer", text: "Answered in Claude Code." }));
    await dispatch(
      ["connection", "respond", id, "--offer", offerId, "--request", response, "--json"],
      deps,
    );
    await commit(root, owner, output.pop() ?? "");
    expect(viewConversation(dir).state.connection?.offers[offerId]).toMatchObject({
      kind: "finished",
      outcome: { kind: "answer", text: "Answered in Claude Code." },
    });

    // The continuation Stop listens again without another request, then expires once.
    const started = now;
    expect(await runClaudeHook(records, { ...stop, stop_hook_active: true }, options)).toEqual({
      kind: "stopped",
      reason: "expired",
    });
    expect(now - started).toBe(45_000);
    expect(await runClaudeHook(records, stop, options)).toEqual({ kind: "skipped" });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a new prompt clears a pending listening request and revokes an active wait", async () => {
  const { deps, dir, id, output, owner, root } = await claudeFixture();
  try {
    const records = conversations(root);
    const prompt = { cwd: root, hook_event_name: "UserPromptSubmit", session_id: SESSION };
    const stop = { cwd: root, hook_event_name: "Stop", session_id: SESSION };
    const signal = new AbortController().signal;
    await dispatch(["connection", "resume-listen", id, "--json"], deps);
    await commit(root, owner, output.pop() ?? "");
    const before = viewConversation(dir).state.seq;
    expect(await runClaudeHook(records, prompt, { native: native(owner), signal })).toEqual({
      kind: "skipped",
    });
    expect(await runClaudeHook(records, stop, { native: native(owner), signal })).toEqual({
      kind: "skipped",
    });
    expect(viewConversation(dir).state.seq).toBe(before);

    await dispatch(["connection", "resume-listen", id, "--json"], deps);
    await commit(root, owner, output.pop() ?? "");
    let now = Date.now();
    const result = await runClaudeHook(records, stop, {
      listener: {
        now: () => now,
        wait: async (ms: number) => {
          now += ms;
          expect(
            await runClaudeHook(records, prompt, { native: native(owner), retryMs: 1, signal }),
          ).toEqual({ kind: "stopped", reason: "interrupted" });
        },
      },
      native: native(owner),
      signal,
    });
    expect(result).toEqual({ kind: "stopped", reason: "interrupted" });
    expect(viewConversation(dir).state.connection?.disabledReason).toBe("interrupted");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("listening ends before Claude Code's consecutive Stop hook cap discards an offer", async () => {
  const { deps, dir, id, output, owner, root } = await claudeFixture();
  try {
    const records = conversations(root);
    const signal = new AbortController().signal;
    const stop = { cwd: root, hook_event_name: "Stop", session_id: SESSION };
    const host = openWriter(dir);
    try {
      host.acceptInput({ id: "capped", mode: "queue", text: "Held at the cap" }, { managed: true });
    } finally {
      host.close();
    }
    await dispatch(["connection", "resume-listen", id, "--json"], deps);
    await commit(root, owner, output.pop() ?? "");
    const registrations = join(root, ".registrations", "claude-cli", "stops");
    const capped = native(owner, 2);
    // Two earlier continuations in this turn reach the cap of two.
    const registration = await captureClaudeAuthor(root, { ...stop }, capped);
    if (!registration.ok || !("registration" in registration)) throw new Error("No registration");
    writeStopBlocks(root, registration.registration.registrationId, 2);
    const result = await runClaudeHook(
      records,
      { ...stop, stop_hook_active: true },
      { native: capped, signal },
    );
    expect(result).toMatchObject({ kind: "notice" });
    expect(Object.keys(viewConversation(dir).state.connection?.offers ?? {})).toHaveLength(0);
    // A fresh Stop resets the count, but the cleared request needs another resume-listen.
    expect(await runClaudeHook(records, stop, { native: capped, signal })).toEqual({
      kind: "skipped",
    });
    expect(readdirSync(registrations)).toHaveLength(1);
    expect(
      JSON.parse(
        readFileSync(
          join(registrations, `${registration.registration.registrationId}.json`),
          "utf8",
        ),
      ),
    ).toEqual({ count: 0 });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a proposal commits once, within its lifetime, for the lifecycle that saved it", async () => {
  const { dir, id, owner, root } = await claudeFixture();
  try {
    const binding = viewConversation(dir).state.connection?.binding;
    if (!binding) throw new Error("Missing binding");
    const operation = { conversationId: id, kind: "listen" } as const;
    const saved = saveClaudeProposal(root, binding, operation, 1_000);
    expect(claimClaudeProposal(root, saved.nonce, 1_000 + CLAUDE_PROPOSAL_TTL_MS + 1)).toBeNull();
    const fresh = saveClaudeProposal(root, binding, operation);
    expect(claimClaudeProposal(root, fresh.nonce)).toMatchObject({ operation });
    expect(claimClaudeProposal(root, fresh.nonce)).toBeNull();

    const stale = saveClaudeProposal(
      root,
      { ...binding, registrationId: crypto.randomUUID() },
      operation,
    );
    const result = await commit(root, owner, `lucid-claude-proposal:${stale.nonce}`);
    if (result.kind !== "committed") throw new Error("Missing lifecycle refusal");
    expect(result.context).toContain("different native lifecycle");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a Claude Code command without a registered session refuses and keeps the publication", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-claude-unregistered-"));
  try {
    const output: string[] = [];
    const request = join(root, "publication.json");
    writeFileSync(
      request,
      JSON.stringify({
        artifact: {
          artifactId: "doc",
          bytes:
            '<html><head><meta name="lucid-theme" content="adaptive"></head><body><p>kept</p></body></html>',
          contentType: "text/html",
          version: 1,
        },
        creationId: "unregistered",
        serverUrl: "http://127.0.0.1:17454",
        workingDirectory: root,
      }),
    );
    await dispatch(["artifact", "publish", "--request", request, "--json"], {
      claudeSession: SESSION,
      onOutput: (line) => output.push(line),
      rootDir: root,
    });
    const result = JSON.parse(output.pop() ?? "null");
    expect(result.publication).toEqual({ status: "published", version: 1 });
    expect(result.connection).toMatchObject({ reason: "registration-missing" });
    expect(result.connection.proposal).toBeUndefined();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

function acceptFeedback(dir: string, id: string, text: string): void {
  const host = openWriter(dir);
  try {
    expect(host.acceptInput({ id, mode: "queue", text }, { managed: true }).verdict).toBe(
      "accepted",
    );
  } finally {
    host.close();
  }
}

function listening(owner: ProcessOwner) {
  let now = Date.now();
  return {
    elapsed: () => now,
    options: {
      listener: {
        now: () => now,
        wait: async (ms: number) => {
          now += ms;
        },
      },
      native: native(owner),
      signal: new AbortController().signal,
    },
  };
}

test("Claude Code receives a large document by reference and answers only after reading all of it", async () => {
  const section = (index: number) =>
    `<section id="s${index}"><p>Paragraph ${index} with Unicode ก🙂 and "quotes".</p></section>\n`;
  const sections = Array.from({ length: 1_200 }, (_, index) => section(index)).join("");
  const document = `<html><head><meta name="lucid-theme" content="adaptive"></head><body>${sections}</body></html>`;
  expect(Buffer.byteLength(document)).toBeGreaterThan(60_000);
  const { deps, dir, id, output, owner, root } = await claudeFixture(document);
  try {
    const records = conversations(root);
    const { options } = listening(owner);
    const stop = { cwd: root, hook_event_name: "Stop", session_id: SESSION };
    const feedback = "Please tighten the final section.";
    acceptFeedback(dir, "large", feedback);
    await dispatch(["connection", "resume-listen", id, "--json"], deps);
    expect(await commit(root, owner, output.pop() ?? "")).toMatchObject({ kind: "committed" });

    const delivery = await runClaudeHook(records, stop, options);
    if (delivery.kind !== "offered") throw new Error(`Expected an offer, got ${delivery.kind}`);
    expect(Buffer.byteLength(delivery.payload)).toBeLessThanOrEqual(19_900);
    const reason: string = JSON.parse(delivery.payload).reason;
    expect(reason).toContain(feedback);
    expect(reason.includes(JSON.stringify(section(600)).slice(1, -1))).toBe(false);
    const command = reason.match(/lucid context '([^']+)' --offset 0 --bytes (\d+)/);
    if (!command?.[1]) throw new Error("Missing reading command");
    expect(Number(command[2])).toBe(24_000);
    const copy = command[1];
    const offerId = Object.keys(viewConversation(dir).state.connection?.offers ?? {})[0];
    if (!offerId) throw new Error("Missing durable offer");
    const offer = viewConversation(dir).state.connection?.offers[offerId]?.offer;
    // The same preparation without a size limit renders the inline context the copy must equal.
    const inlineHost = openWriter(dir);
    let inlineContext: string;
    try {
      const inline = prepareNativeFeedback(inlineHost, "large", {
        encode: (prompt) => prompt,
        maxBytes: 10_000_000,
      });
      if (inline.kind !== "ready")
        throw new Error(`Expected inline preparation, got ${inline.kind}`);
      inline.discard();
      inlineContext = inline.payload.split("\n\n<lucid-offer>\n\n")[0] ?? "";
    } finally {
      inlineHost.close();
    }

    await dispatch(["connection", "receipt", id, "--offer", offerId, "--json"], deps);
    await commit(root, owner, output.pop() ?? "");
    expect(viewConversation(dir).state.connection?.offers[offerId]?.kind).toBe("received");

    const response = join(root, "response.json");
    writeFileSync(response, JSON.stringify({ kind: "answer", text: "Tightened." }));
    const respond = async () => {
      await dispatch(
        ["connection", "respond", id, "--offer", offerId, "--request", response, "--json"],
        deps,
      );
      return commit(root, owner, output.pop() ?? "");
    };
    const early = await respond();
    if (early.kind !== "committed") throw new Error("Missing refused response");
    expect(early.context).toContain("Read the offered context in order to its end");
    expect(viewConversation(dir).state.connection?.offers[offerId]?.kind).toBe("received");

    // Reading follows nextOffset; the copy holds the complete context the inline offer would carry.
    let offset = 0;
    let text = "";
    let reads = 0;
    while (true) {
      const slice = readOfferedContext(copy, offset, 24_000);
      text += slice.text;
      offset = slice.nextOffset;
      reads += 1;
      if (slice.done) break;
    }
    expect(reads).toBeGreaterThan(1);
    // The copy quotes the document as JSON, exactly as the inline context does.
    expect(text.includes(JSON.stringify(document).slice(1, -1))).toBe(true);
    expect(text.endsWith(feedback)).toBe(true);
    // Preparing again after offer-started advances the recorded sequence number only.
    const sequenceFree = (value: string) => value.replaceAll(/"seq":\d+/g, '"seq":0');
    expect(sequenceFree(text) === sequenceFree(inlineContext)).toBe(true);
    expect(offer?.delivery).toEqual({ bytes: Buffer.byteLength(text), kind: "reference" });

    expect(await respond()).toMatchObject({ kind: "committed" });
    expect(viewConversation(dir).state.connection?.offers[offerId]).toMatchObject({
      kind: "finished",
      outcome: { kind: "answer", text: "Tightened." },
    });
    // Accepting the response removes the copy; replaying the log still shows the answer.
    expect(() => readOfferedContext(copy, 0, 16)).toThrow();
    expect(viewConversation(dir).state.connection?.offers[offerId]?.kind).toBe("finished");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a reference offer whose copy is lost refuses an answer and still records a failure", async () => {
  const body = `<main>${"<p>Large paragraph of recorded document text.</p>\n".repeat(900)}</main>`;
  const document = `<html><head><meta name="lucid-theme" content="adaptive"></head><body>${body}</body></html>`;
  const { deps, dir, id, output, owner, root } = await claudeFixture(document);
  try {
    const records = conversations(root);
    const { options } = listening(owner);
    acceptFeedback(dir, "lost", "Review this document.");
    await dispatch(["connection", "resume-listen", id, "--json"], deps);
    await commit(root, owner, output.pop() ?? "");
    const delivery = await runClaudeHook(
      records,
      { cwd: root, hook_event_name: "Stop", session_id: SESSION },
      options,
    );
    if (delivery.kind !== "offered") throw new Error("Missing offer");
    const copy = JSON.parse(delivery.payload).reason.match(/lucid context '([^']+)'/)?.[1];
    if (!copy) throw new Error("Missing copy path");
    const offerId = Object.keys(viewConversation(dir).state.connection?.offers ?? {})[0] ?? "";
    await dispatch(["connection", "receipt", id, "--offer", offerId, "--json"], deps);
    await commit(root, owner, output.pop() ?? "");
    rmSync(copy, { force: true, recursive: true });

    const response = join(root, "response.json");
    const respond = async (body: unknown) => {
      writeFileSync(response, JSON.stringify(body));
      await dispatch(
        ["connection", "respond", id, "--offer", offerId, "--request", response, "--json"],
        deps,
      );
      return commit(root, owner, output.pop() ?? "");
    };
    // A malformed answer is invalid before any copy check runs.
    const malformed = await respond({ kind: "answer", text: 42 });
    if (malformed.kind !== "committed") throw new Error("Missing malformed refusal");
    expect(malformed.context).not.toContain("no longer available");
    expect(viewConversation(dir).state.connection?.offers[offerId]?.kind).toBe("received");
    const answer = await respond({ kind: "answer", text: "Answered without the document." });
    if (answer.kind !== "committed") throw new Error("Missing refused answer");
    expect(answer.context).toContain("no longer available");
    expect(viewConversation(dir).state.connection?.offers[offerId]?.kind).toBe("received");
    expect(await respond({ kind: "failure", text: "The context copy was lost." })).toMatchObject({
      kind: "committed",
    });
    expect(viewConversation(dir).state.connection?.offers[offerId]).toMatchObject({
      kind: "finished",
      outcome: { kind: "failure" },
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a listen that expires with feedback held tells the person; an interrupted one does not", async () => {
  const { deps, dir, id, output, owner, root } = await claudeFixture();
  try {
    const records = conversations(root);
    const stop = { cwd: root, hook_event_name: "Stop", session_id: SESSION };
    // Feedback text alone above the transport limit cannot be sent by reference either.
    acceptFeedback(dir, "oversized", `Oversized feedback ${"x".repeat(25_000)}`);
    await dispatch(["connection", "resume-listen", id, "--json"], deps);
    await commit(root, owner, output.pop() ?? "");
    const { options } = listening(owner);
    const result = await runClaudeHook(records, stop, options);
    expect(result).toMatchObject({ kind: "notice" });
    if (result.kind !== "notice") throw new Error("Missing notice");
    expect(result.message).toContain("could not send 1 saved feedback item");
    expect(result.message).toContain("The feedback text exceeds this native transport's limit");
    expect(viewConversation(dir).state.connection?.heldInputs.oversized?.reason).toBe(
      "context-too-large",
    );
    const leftover = readdirSync(tmpdir()).filter((name) =>
      name.startsWith(`lucid-context-offer-${process.pid}-`),
    );
    expect(leftover).toEqual([]);

    // The next explicit listen retries the hold; an interrupt then ends it without a notice.
    await dispatch(["connection", "resume-listen", id, "--json"], deps);
    await commit(root, owner, output.pop() ?? "");
    const controller = new AbortController();
    let now = Date.now();
    const interrupted = await runClaudeHook(records, stop, {
      listener: {
        now: () => now,
        wait: async (ms: number) => {
          now += ms;
          controller.abort();
        },
      },
      native: native(owner),
      signal: controller.signal,
    });
    expect(interrupted).toEqual({ kind: "stopped", reason: "interrupted" });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Claude Code's Bash output limit sets the context slice", () => {
  expect(claudeContextSlice({})).toBe(24_000);
  expect(claudeContextSlice({ BASH_MAX_OUTPUT_LENGTH: "" })).toBe(24_000);
  expect(claudeContextSlice({ BASH_MAX_OUTPUT_LENGTH: "10000" })).toBe(8_000);
  expect(claudeContextSlice({ BASH_MAX_OUTPUT_LENGTH: "150000" })).toBe(24_000);
  expect(claudeContextSlice({ BASH_MAX_OUTPUT_LENGTH: "5000" })).toBeUndefined();
  expect(claudeContextSlice({ BASH_MAX_OUTPUT_LENGTH: "30k" })).toBeUndefined();
});

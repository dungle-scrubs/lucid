/**
 * CliHost — the deep module that owns the CLI dispatch discipline.
 *
 * Before, `mapping.ts` owned pure `argv -> MappedCommand`, `main.ts`
 * owned the impure `switch(mapped.kind) -> dynamic import -> call` with
 * a fresh `process.env.LUCID_ROOT` read per branch, and each command
 * (`send`, `watch`, `run`) re-derived `conversations(rootDir)` and its
 * own `(conversationId, rootDir) -> dir` dance. Fixing a flag (or
 * hunting a missing root, an invalid id, a wrong help path) meant
 * bouncing across `mapping + main + each opts type` — three edits, three
 * test files. The bugs hid in how the adapters were called (missing
 * root, invalid id, help vs unknown), not in the pure parse, yet only
 * the pure half had coverage. `run.ts` had decayed to a 1-line
 * forwarder — the seam already wanted to be deeper.
 *
 * 02 deepens the hook seam: `announce`/`inject` were second-class —
 * dispatch returned a bare `{kind:"announce"}` and `runCli` did a
 * dynamic `await import("./hooks/announce.js")` outside the injected
 * seam. All five commands now go through the same `dispatch` seam via
 * injectable `announceFn`/`injectFn`/`readStdinFn`, so hook dispatch is
 * testable without a filesystem or stdin pipe, and adding the future
 * Stop hook is one injection, not a new import in `runCli`.
 *
 * Now one module owns the whole discipline — `argv -> MappedCommand`
 * (via `mapSubcommand`), `rootDir` resolution once, and the effect
 * routing to the five commands — and hides it behind a small, deep
 * interface: `dispatch(argv, deps) -> DispatchResult` and the production
 * convenience `runCli(argv, deps)` that maps the result to stdout.
 * The adapters (`send`/`watch`/`run`/`announce`/`inject`) become thin
 * `(deps, parsed) -> effect` collaborators that never construct
 * `conversations()` themselves — the host does. The deletion test
 * passes: deleting this module would scatter `LUCID_ROOT` reads,
 * validation, and the `switch` across five adapters.
 *
 * What it is NOT: it is not the durable log (ConversationLog), not the
 * flock primitive, not the harness runner, and not the TUI renderer —
 * `watch`'s paint step stays in `main.ts` and is injected as `onView`.
 */

import type { ConnectionControl } from "../protocol/connection.js";
import { type ChatOpts, chatConversation } from "./chat.js";
import { type AnnounceResult, announce } from "./hooks/announce.js";
import { readStdin } from "./hooks/delivery.js";

import { type InjectResult, inject } from "./hooks/inject.js";

import { type MappedCommand, mapSubcommand } from "./mapping.js";
import { type Conversations, commandRecordDir, conversations } from "./record-addressing.js";
import type { RunOpts, RunResult } from "./run.js";
import { runConversation } from "./run.js";
import type { SendOpts } from "./send.js";
import { sendInput } from "./send.js";
import type { ServeOpts } from "./serve.js";
import type { WatchOpts } from "./watch.js";
import { watchConversation } from "./watch.js";

/** Injected seams — defaulted in production, faked in tests. */
export interface DispatchDeps {
  readonly reconnectDeps?: import("./reconnect.js").ReconnectDeps;
  readonly nativeAuthority?: import("../store/native-registration.js").RegistrationAuthority;
  /** Record root override — defaults to `process.env.LUCID_ROOT`. One read, not three. */
  readonly rootDir?: string;
  /** Record addressing factory — injected so CliHost owns the single `effectiveRoot` → `Conversations` binding (2). */
  readonly conversationsFactory?: (rootDir?: string) => Conversations;
  /** Command seams — injected so dispatch is testable without a flock. */
  readonly sendInputFn?: (conversationId: string, opts: SendOpts) => { inputId: string };
  readonly watchConversationFn?: (conversationId: string, opts: WatchOpts) => Promise<void>;
  readonly runConversationFn?: (opts: RunOpts) => Promise<RunResult>;
  readonly namingWorkerFn?: (root: string) => Promise<void>;
  readonly managedWorkerFn?: typeof import("./managed-worker.js").runManagedWorker;
  readonly wakeNamingFn?: (root: string) => void;
  readonly serveFn?: (opts: ServeOpts) => Promise<void>;
  readonly announceFn?: (stdin: string) => Promise<AnnounceResult>;
  readonly codexHookFn?: typeof import("./hooks/codex.js").runCodexHook;
  readonly claudeHookFn?: typeof import("./hooks/claude.js").runClaudeHook;
  /** Claude Code session reported to a tool command; null disables detection. Defaults to the
   * environment unless a test injects `nativeAuthority`. */
  readonly claudeSession?: string | null;
  readonly injectFn?: (stdin: string) => Promise<InjectResult>;
  readonly readStdinFn?: () => Promise<string>;
  /** Sink for help / confirmation lines — defaults to `console.log` in `runCli`. */
  readonly onOutput?: (line: string) => void;
  /** Sink for hook error lines (code: message) — defaults to stderr. */
  readonly onStderr?: (line: string) => void;
  /** For `watch`: view sink — injected in tests, defaulted to renderLines in `runCli`. */
  readonly onView?: WatchOpts["onView"];
  /** For `watch`/`run`: abort signal — wired from SIGINT in `runCli`. */
  readonly signal?: AbortSignal;
  /** Must match `chatConversation` exactly - one options object. The first
   * shape of this seam declared a `conversationId` parameter the real
   * function does not take, and TypeScript accepted the mismatch because a
   * function of fewer parameters is assignable to one of more. So the id
   * was passed, ignored, and every `lucid chat <name>` opened a conversation
   * named conv-<timestamp> instead. A seam that does not match its
   * implementation hides exactly this. */
  readonly chatConversationFn?: (opts: ChatOpts) => Promise<void>;
  readonly chatKeys?: AsyncIterable<string>;
  readonly chatNow?: () => number;
}

export type DispatchResult =
  | {
      readonly kind: "reconnect";
      readonly verdict: "completed" | "held" | "cancelled" | "pending";
      readonly exitCode: number;
    }
  | { readonly kind: "codex-hook" }
  | { readonly kind: "claude-hook" }
  | { readonly kind: "connection-listen"; readonly verdict: "requested" | "held" | "pending" }
  | { readonly kind: "connection-setup"; readonly verdict: "installed" | "unchanged" | "refused" }
  | { readonly kind: "connection-control"; readonly verdict: "accepted" | "refused" | "pending" }
  | { readonly kind: "connection-status" }
  | { readonly kind: "artifact-publish" }
  | { readonly kind: "handoff" }
  | { readonly kind: "hcn-supervisor" }
  | { readonly kind: "context" }
  | { readonly kind: "name-titles" }
  | { readonly kind: "managed-worker" }
  | { readonly kind: "send"; readonly conversationId: string; readonly inputId: string }
  | { readonly kind: "watch"; readonly conversationId: string }
  | { readonly kind: "run"; readonly conversationId: string; readonly dir: string }
  | {
      readonly kind: "await";
      readonly conversationId: string;
      readonly dir: string;
      readonly resumeInstruction: string;
    }
  | { readonly kind: "chat"; readonly conversationId: string }
  | { readonly kind: "serve" }
  | { readonly kind: "announce" }
  | { readonly kind: "inject" }
  | { readonly kind: "help"; readonly message: string };

/**
 * Dispatch `argv` (without the `lucid` prefix) to the right command.
 * Pure-ish: parsing via `mapSubcommand`, one `rootDir` resolution, and a
 * single switch. Impure only where it must delegate to the injected
 * seams. Testable: inject fakes for every seam and assert the result
 * without a real record dir.
 */
export const dispatch = async (
  argv: readonly string[],
  deps: DispatchDeps = {},
): Promise<DispatchResult> => {
  const mapped: MappedCommand = mapSubcommand(argv);

  // Help is terminal — no seams, no root, no flock.
  if (mapped.kind === "help") return { kind: "help", message: mapped.message };
  if (mapped.kind === "reconnect") {
    const { reconnectConversation } = await import("./reconnect.js");
    const records = (deps.conversationsFactory ?? conversations)(deps.rootDir);
    const result = await reconnectConversation(
      records,
      mapped.conversationId,
      {
        signal: deps.signal ?? new AbortController().signal,
        onProgress: (message) =>
          (deps.onStderr ?? ((line: string) => process.stderr.write(line)))(`${message}\n`),
      },
      deps.reconnectDeps,
    );
    const message =
      result.kind !== "completed"
        ? result.message
        : "The native interactive process ended. Use connection status to check listening and saved feedback.";
    (deps.onStderr ?? ((line: string) => process.stderr.write(line)))(`${message}\n`);
    return {
      kind: "reconnect",
      verdict: result.kind,
      exitCode:
        result.kind === "completed" && result.result.kind === "closed"
          ? (result.result.exitCode ?? 1)
          : result.kind === "pending"
            ? 0
            : result.kind === "cancelled"
              ? 130
              : 1,
    };
  }
  if (mapped.kind === "connection-setup") {
    const records = (deps.conversationsFactory ?? conversations)(deps.rootDir);
    const result =
      mapped.interface === "claude-cli"
        ? (await import("./claude-setup.js")).setupClaudeHooks(records.rootDir, mapped.hooksFile)
        : (await import("./codex-setup.js")).setupCodexHooks(records.rootDir, mapped.hooksFile);
    (deps.onOutput ?? console.log)(mapped.json ? JSON.stringify(result) : result.message);
    return { kind: "connection-setup", verdict: result.status };
  }
  if (mapped.kind === "codex-hook") {
    const { runCodexHook } = await import("./hooks/codex.js");
    const records = (deps.conversationsFactory ?? conversations)(mapped.root ?? deps.rootDir);
    let payload: unknown;
    try {
      payload = JSON.parse(await (deps.readStdinFn ?? readStdin)());
    } catch {
      payload = null;
    }
    const result = await (deps.codexHookFn ?? runCodexHook)(records, payload, {
      signal: deps.signal ?? new AbortController().signal,
    });
    if (result.kind === "offered") (deps.onOutput ?? console.log)(result.payload);
    if (result.kind === "held")
      (deps.onStderr ?? ((line: string) => process.stderr.write(line)))(
        `${result.reason}: ${result.message}\n`,
      );
    return { kind: "codex-hook" };
  }
  if (mapped.kind === "claude-hook") {
    const { runClaudeHook } = await import("./hooks/claude.js");
    const records = (deps.conversationsFactory ?? conversations)(mapped.root ?? deps.rootDir);
    let payload: unknown;
    try {
      payload = JSON.parse(await (deps.readStdinFn ?? readStdin)());
    } catch {
      payload = null;
    }
    const result = await (deps.claudeHookFn ?? runClaudeHook)(records, payload, {
      signal: deps.signal ?? new AbortController().signal,
    });
    const output = deps.onOutput ?? console.log;
    if (result.kind === "offered") output(result.payload);
    if (result.kind === "committed")
      output(
        JSON.stringify({
          hookSpecificOutput: { additionalContext: result.context, hookEventName: "PostToolUse" },
        }),
      );
    if (result.kind === "notice") output(JSON.stringify({ systemMessage: result.message }));
    if (result.kind === "held")
      (deps.onStderr ?? ((line: string) => process.stderr.write(line)))(
        `${result.reason}: ${result.message}\n`,
      );
    return { kind: "claude-hook" };
  }
  if (mapped.kind === "connection-listen") {
    const claudeSession = await commandClaudeSession(deps);
    const records = (deps.conversationsFactory ?? conversations)(deps.rootDir);
    if (claudeSession) {
      const { proposeClaudeOperation } = await import("./claude-commands.js");
      const result = proposeClaudeOperation(records, claudeSession, {
        conversationId: mapped.conversationId,
        kind: "listen",
      });
      (deps.onOutput ?? console.log)(proposalOutput(result, mapped.json));
      return {
        kind: "connection-listen",
        verdict: result.verdict === "pending" ? "pending" : "held",
      };
    }
    const { requestNativeListening } = await import("./native-listening.js");
    const result = requestNativeListening(records, mapped.conversationId, deps.nativeAuthority);
    (deps.onOutput ?? console.log)(mapped.json ? JSON.stringify(result) : result.message);
    return { kind: "connection-listen", verdict: result.kind };
  }
  if (mapped.kind === "connection-control") {
    const { readResponseRequest, runConnectionControl } = await import("./connection-control.js");
    const records = (deps.conversationsFactory ?? conversations)(deps.rootDir);
    let control: ConnectionControl;
    switch (mapped.operation) {
      case "cancel-input":
        control = { inputId: mapped.inputId, kind: "cancel-input" };
        break;
      case "receipt":
        control = { kind: "receipt", offerId: mapped.offerId };
        break;
      case "respond":
        control = {
          kind: "respond",
          offerId: mapped.offerId,
          outcome: await readResponseRequest(mapped.request),
        };
        break;
    }
    const claudeSession = control.kind === "cancel-input" ? null : await commandClaudeSession(deps);
    if (claudeSession && control.kind !== "cancel-input") {
      const { proposeClaudeOperation } = await import("./claude-commands.js");
      const result = proposeClaudeOperation(
        records,
        claudeSession,
        control.kind === "receipt"
          ? { conversationId: mapped.conversationId, kind: "receipt", offerId: control.offerId }
          : {
              conversationId: mapped.conversationId,
              kind: "respond",
              offerId: control.offerId,
              outcome: control.outcome,
            },
      );
      (deps.onOutput ?? console.log)(proposalOutput(result, mapped.json));
      return {
        kind: "connection-control",
        verdict: result.verdict === "pending" ? "pending" : "refused",
      };
    }
    const result = runConnectionControl(
      records,
      mapped.conversationId,
      control,
      deps.nativeAuthority,
    );
    (deps.onOutput ?? console.log)(mapped.json ? JSON.stringify(result) : result.message);
    return { kind: "connection-control", verdict: result.verdict };
  }
  if (mapped.kind === "connection-status") {
    const { readConnection } = await import("../store/connection-view.js");
    const records = (deps.conversationsFactory ?? conversations)(deps.rootDir);
    const result = readConnection(commandRecordDir(records, mapped.conversationId));
    (deps.onOutput ?? console.log)(mapped.json ? JSON.stringify(result) : result.message);
    return { kind: "connection-status" };
  }
  if (mapped.kind === "artifact-publish") {
    const { publishArtifact, readPublicationRequest } = await import("./artifact-publish.js");
    const claudeSession = await commandClaudeSession(deps);
    const result = await publishArtifact(
      await readPublicationRequest(mapped.request),
      deps.rootDir,
      deps.nativeAuthority,
      claudeSession
        ? (await import("./claude-commands.js")).claudePublicationConnector(claudeSession)
        : undefined,
    );
    (deps.onOutput ?? console.log)(
      mapped.json
        ? JSON.stringify(result)
        : [result.artifactUrl, result.connection.message, result.connection.proposal]
            .filter(Boolean)
            .join("\n"),
    );
    return { kind: "artifact-publish" };
  }
  if (mapped.kind === "handoff") {
    const { runHandoff } = await import("./handoff.js");
    const { parseHandoffRequest, readHandoffRequest } = await import("./handoff-request.js");
    const result = await runHandoff(
      parseHandoffRequest(await readHandoffRequest(mapped.request)),
      deps.rootDir,
    );
    (deps.onOutput ?? console.log)(
      mapped.json
        ? JSON.stringify(result)
        : [
            result.artifactUrl,
            result.continuation.idempotent
              ? `continuation ${result.continuation.inputId} already present`
              : `continuation ${result.continuation.inputId} queued`,
          ].join("\n"),
    );
    return { kind: "handoff" };
  }
  if (mapped.kind === "context") {
    const { readOfferedContext } = await import("../store/context-offer.js");
    const result = readOfferedContext(mapped.path, mapped.offset, mapped.bytes);
    const output = deps.onOutput ?? ((line: string) => console.log(line));
    output(
      mapped.json
        ? JSON.stringify(result)
        : `${result.text}\n\nnextOffset: ${result.nextOffset}; done: ${result.done}`,
    );
    return { kind: "context" };
  }
  if (mapped.kind === "announce") {
    const stdin = await (deps.readStdinFn ?? readStdin)();
    const fn = deps.announceFn ?? announce;
    const result = await fn(stdin);
    if (!result.ok) {
      const line = `${result.code ?? "hook-error"}: ${result.message ?? ""}\n`;
      (deps.onStderr ?? ((m: string) => process.stderr.write(m)))(line);
    }
    return { kind: "announce" };
  }
  if (mapped.kind === "inject") {
    const stdin = await (deps.readStdinFn ?? readStdin)();
    const fn = deps.injectFn ?? inject;
    const result = await fn(stdin);
    if (!result.ok) {
      const line = `${result.code ?? "hook-error"}: ${result.message ?? ""}\n`;
      (deps.onStderr ?? ((m: string) => process.stderr.write(m)))(line);
    }
    return { kind: "inject" };
  }

  if (mapped.kind === "name-titles") {
    const run = deps.namingWorkerFn ?? (await import("./naming.js")).runNamingWorker;
    await run(mapped.root);
    return { kind: "name-titles" };
  }
  if (mapped.kind === "hcn-supervisor") {
    await (await import("./hcn-supervisor.js")).superviseHcn(mapped.argv);
    return { kind: "hcn-supervisor" };
  }
  if (mapped.kind === "managed-worker") {
    const run = deps.managedWorkerFn ?? (await import("./managed-worker.js")).runManagedWorker;
    await run(mapped.root, mapped.conversationId, mapped.inputId, { signal: deps.signal });
    return { kind: "managed-worker" };
  }

  // One root resolution for the three record-touching commands. Not per-branch.
  // The factory is bound once to that root so adapters reuse the same
  // addressing discipline rather than re-deriving `conversations(rootDir)`
  // independently (2 — shotgun tail). When a fake factory is injected the
  // fake's binding is honored; otherwise the real `conversations` is used.
  const effectiveRoot = deps.rootDir ?? process.env.LUCID_ROOT;
  const convFactory: (rootDir?: string) => Conversations =
    deps.conversationsFactory ?? ((r?: string) => conversations(r ?? effectiveRoot));
  // Stabilize the effective Conversations instance for this dispatch so
  // `send`/`watch` share it when they use the default factory path.
  const dispatchConvs = convFactory(effectiveRoot);
  const boundFactory: (rootDir?: string) => Conversations = () => dispatchConvs;
  const sendFn = deps.sendInputFn ?? sendInput;
  const watchFn = deps.watchConversationFn ?? watchConversation;
  const runFn = deps.runConversationFn ?? runConversation;

  switch (mapped.kind) {
    case "serve": {
      // `serve` is long-lived, like `watch`: it holds the process open
      // until the terminal stops it, and says where it is on its own.
      const serveFn =
        deps.serveFn ??
        (async (opts: ServeOpts) => (await import("./serve.js")).serveConversation(opts));
      await serveFn({
        rootDir: effectiveRoot,
        ...(deps.wakeNamingFn ? { wakeNaming: deps.wakeNamingFn } : {}),
        conversationId: mapped.conversationId,
        conversationPanel: mapped.conversationPanel,
      });
      return { kind: "serve" };
    }
    case "send": {
      const { inputId } = sendFn(mapped.conversationId, {
        rootDir: effectiveRoot,
        text: mapped.text,
        conversationsFactory: deps.conversationsFactory ? convFactory : boundFactory,
      });
      if (deps.wakeNamingFn) deps.wakeNamingFn(dispatchConvs.rootDir);

      return { kind: "send", conversationId: mapped.conversationId, inputId };
    }
    case "watch": {
      // `watch` is long-lived — the caller (`runCli`) awaits it with a signal.
      // In tests the fake resolves immediately.
      await watchFn(mapped.conversationId, {
        rootDir: effectiveRoot,
        conversationsFactory: deps.conversationsFactory ? convFactory : boundFactory,
        onView: deps.onView ?? (() => {}),
        signal: deps.signal,
      });
      return { kind: "watch", conversationId: mapped.conversationId };
    }
    case "chat": {
      const chatFn = deps.chatConversationFn ?? chatConversation;
      // The id goes in the options, not as a first argument.
      // `chatConversation` takes one object, so a positional id was
      // accepted by the call and dropped on the floor - `lucid chat demo`
      // opened a conversation named conv-<timestamp>. TypeScript could not
      // see it: an extra argument to a one-parameter function is not an
      // error when the parameter has a default.
      await chatFn({
        conversationId: mapped.conversationId,
        rootDir: effectiveRoot,
        harnessName: mapped.harnessName,
        conversationsFactory: deps.conversationsFactory ? convFactory : boundFactory,
        signal: deps.signal,
        keys: deps.chatKeys,
        now: deps.chatNow,
        onView: deps.onView as unknown as ChatOpts["onView"],
      });
      return { kind: "chat", conversationId: mapped.conversationId ?? "" };
    }
    case "run": {
      // `run` holds the terminal until Ctrl-C, so it must say so. Silence
      // reads as a hang - and did, to the first person who pasted the three
      // commands from the docs as one block and watched nothing happen.
      const say = deps.onOutput ?? ((line: string) => console.log(line));
      const result = await runFn({
        rootDir: effectiveRoot,
        conversationId: mapped.conversationId,
        harnessName: mapped.harnessName,
        onStart: (running) => {
          say(`${running.conversationId} · ${running.harness} · ${running.profile}`);
          say(`record ${running.dir}`);
          say(`following the log — send to this conversation from anywhere; Ctrl-C to stop`);
        },
        onRecord: (r) => {
          if (!("verdict" in r) || r.verdict !== "accepted") return;
          if (r.kind === "input") say(`  → input ${r.inputId ?? ""}`.trimEnd());
          if (r.kind === "disposition" && r.outcome === "applied")
            say(`  ✓ delivered ${r.inputId ?? ""}`.trimEnd());
        },
      });
      if (result.awaitToken) {
        return {
          kind: "await",
          conversationId: result.conversationId,
          dir: result.dir,
          resumeInstruction: result.awaitToken.resumeInstruction,
        };
      }
      return { kind: "run", conversationId: result.conversationId, dir: result.dir };
    }
  }
};

/**
 * Production runner: `dispatch` + stdout mapping. Keeps `main.ts` a
 * 10-line adapter. Help and send-confirmation go to `onOutput`
 * (default `console.log`); `watch` gets a renderLines-backed sink if
 * none is injected. Hook execution now lives in `dispatch` (02), so
 * this is a pure sink-mapper with no dynamic hook imports.
 */
export const runCli = async (
  argv: readonly string[],
  deps: DispatchDeps = {},
): Promise<DispatchResult> => {
  // Only `watch` needs a paint sink — avoid importing the renderer for
  // every `send`/`run` invocation.
  const isWatch = argv[0] === "watch" || argv[0] === "chat";
  let defaultOnView: WatchOpts["onView"] | undefined;
  if (isWatch && !deps.onView) {
    const { renderLines } = await import("../tui/render.js");
    defaultOnView = (view) => {
      // Preserve the existing console.clear + line paint behavior.
      console.clear();
      for (const line of renderLines(view)) console.log(line);
    };
  }

  const result = await dispatch(argv, {
    ...deps,
    onView: deps.onView ?? defaultOnView,
  });

  const out = deps.onOutput ?? ((line: string) => console.log(line));
  if (result.kind === "help") out(result.message);
  else if (result.kind === "send") out(`sent to ${result.conversationId}`);
  else if (result.kind === "await") out(result.resumeInstruction);
  return result;
};

/** The proposal marker must reach stdout: the parent PostToolUse callback commits what it names. */
function proposalOutput(
  result: import("./claude-commands.js").ClaudeProposalResult,
  json: boolean,
): string {
  if (json) return JSON.stringify(result);
  return result.verdict === "pending" ? `${result.message}\n${result.proposal}` : result.message;
}

/** Only native authoring commands resolve a Claude Code session; other commands never load it. */
async function commandClaudeSession(deps: DispatchDeps): Promise<string | null | undefined> {
  if (deps.claudeSession !== undefined) return deps.claudeSession;
  if (deps.nativeAuthority) return null;
  return (await import("./claude-commands.js")).claudeCommandSession();
}

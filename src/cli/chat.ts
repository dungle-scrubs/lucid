/**
 * `lucid chat` — one window that drives, renders, and reads keys.
 *
 * Composes the pieces the ticket names: `startHeadless`'s lifecycle is
 * replicated here with the chat-specific render and input wiring. The
 * viewer and driver meet in one process: the harness is driven, the log
 * is followed under the append lock, and the keyboard is read.
 *
 * Why not just call startHeadless and layer on top: the chat needs the
 * host for enqueue, the profile for submit routing, and the tailer for
 * lock-taking reads — startHeadless hides the host. So the lifecycle
 * (ensure -> D-021 gate -> presence -> host -> source -> tailer) is
 * replicated with the same seams, and the chat adds the render and key
 * loops on top.
 *
 * The draft lives in this process and nowhere else, passed into
 * buildView on every paint. It survives repaints and does not survive
 * the process. Losing the lease does not exit: it stops accepting
 * submissions, keeps rendering, keeps the draft, and says the
 * conversation moved.
 */

import { createHcnRunner } from "../harness/hcn-runner.js";
import { nodeHarnessDeps } from "../harness/node-deps.js";
import type { HarnessName, HarnessRunner } from "../harness/runner.js";
import { decideAction } from "../modes/controller.js";
import { createHeadlessHost } from "../modes/host.js";
import { INPUT_QUEUE_MAX } from "../protocol/events.js";
import type { Frame } from "../protocol/index.js";
import { InputLedger } from "../protocol/ledgers/input.js";
import { channelStatus } from "../protocol/liveness.js";
import { acquirePresence, type PresenceHandle } from "../store/presence.js";
import { type HostRecord, openConversation, viewSnapshot } from "../store/store.js";
import { createTailer, followRecord, type RecordTailer } from "../store/tailer.js";
import { NotTTYError, runInputLoop } from "../tui/input.js";
import { renderLines } from "../tui/render.js";
import { buildView } from "../tui/view.js";
import { harnessForName, supportsSession } from "./harness.js";
import { type Conversations, conversations } from "./record-addressing.js";

export class ChatRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ChatRefused";
  }
}

export interface ChatOpts {
  readonly rootDir?: string;
  readonly conversationId?: string;
  readonly harnessName?: string;
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
  readonly randomConversationSuffix?: () => string;
  readonly keys?: AsyncIterable<string>;
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly signal?: AbortSignal;
  readonly onView?: (view: ReturnType<typeof buildView>) => void;
  readonly write?: (s: string) => void;
  readonly conversationsFactory?: (rootDir?: string) => Conversations;
  readonly acquirePresenceFn?: typeof acquirePresence;
  readonly openConversationFn?: typeof openConversation;
  readonly createHeadlessHostFn?: typeof createHeadlessHost;
  readonly runner?: HarnessRunner;
  readonly presence?: () => boolean | undefined;
  readonly onRecord?: (r: HostRecord) => void;
  readonly harness?: HarnessName;
}

const isTTYStream = (s: unknown): boolean =>
  typeof s === "object" && s !== null && "isTTY" in s && (s as { isTTY?: boolean }).isTTY === true;

// Raw mode has ONE owner, and it is `runInputLoop`. This file used to open
// the terminal itself as well, so two places entered raw mode and two places
// restored it - which is how a session that worked under `lucid run` on a
// pty failed to open under `lucid chat` on the same pty. The TTY guard stays
// here only so the refusal happens before a record is touched.
const requireTty = (opts: Pick<ChatOpts, "keys" | "stdin" | "stdout">): void => {
  if (opts.keys) return;
  const stdin = (opts.stdin ?? process.stdin) as NodeJS.ReadStream & { isTTY?: boolean };
  const stdout = (opts.stdout ?? process.stdout) as NodeJS.WriteStream & { isTTY?: boolean };
  if (!isTTYStream(stdin) || !isTTYStream(stdout)) throw new NotTTYError();
};

export const chatConversation = async (opts: ChatOpts = {}): Promise<void> => {
  const convsFactory = opts.conversationsFactory ?? conversations;
  const acquirePresenceFn = opts.acquirePresenceFn ?? acquirePresence;
  const openConversationFn = opts.openConversationFn ?? openConversation;
  const createHeadlessHostFn = opts.createHeadlessHostFn ?? createHeadlessHost;
  const nowFn = opts.now ?? (() => Date.now());
  const uuidFn = opts.randomUUID ?? (() => crypto.randomUUID());
  const suffixFn = opts.randomConversationSuffix ?? (() => Math.random().toString(36).slice(2, 6));
  const harness = opts.harness ?? harnessForName(opts.harnessName);
  const presenceProbe = opts.presence ?? (() => undefined);
  const stdout = (opts.stdout ?? process.stdout) as NodeJS.WriteStream;
  const write = opts.write ?? ((s: string) => stdout.write(s));

  // TTY guard — before any presence or host. Piped/redirected renders
  // once and exits non-zero instead of painting escape codes into a file.
  // Synthetic keys bypass the guard so the deterministic suite runs without a pty.
  const hasSynthetic = !!opts.keys;
  const stdinForCheck = (opts.stdin ?? process.stdin) as unknown as { isTTY?: boolean };
  const stdoutForCheck = (opts.stdout ?? process.stdout) as unknown as { isTTY?: boolean };
  // When synthetic keys are provided, skip TTY check entirely — tests inject keys.
  // When real terminal, require both stdin and stdout to be TTY.
  const syntheticBypass = hasSynthetic;
  if (!syntheticBypass) {
    const stdinTTY = isTTYStream(stdinForCheck);
    const stdoutTTY = isTTYStream(stdoutForCheck);
    if (!stdinTTY || !stdoutTTY) {
      // Render once via lock-free peek (one-shot, no dispatch, so torn tail
      // tolerance is fine — it is a single paint, not an act).
      const conversationId = opts.conversationId ?? `conv-${Date.now()}-${suffixFn()}`;
      const dir = convsFactory(opts.rootDir).dirFor(conversationId);
      try {
        const snap = viewSnapshot(dir, { now: nowFn, presence: presenceProbe });
        const view = buildView({
          transcript: snap.transcript,
          status: snap.status,
          rung: "chat",
          draft: "",
        });
        const lines = renderLines(view);
        write(`${lines.join("\n")}\n`);
      } catch {}
      throw new NotTTYError();
    }
  }

  const convs = convsFactory(opts.rootDir);
  const conversationId = opts.conversationId ?? `conv-${Date.now()}-${suffixFn()}`;
  const dir = convs.dirFor(conversationId);
  const { secret } = convs.ensure(conversationId);

  // Open host early to derive status for D-021 gate — same as runtime.
  // The host is opened before presence, so the gate can be checked without
  // acquiring. The presence handle does not exist yet, so executorLease
  // answers false until acquisition.
  let presenceHandle: PresenceHandle | undefined;
  let receive: ((frame: Frame) => void) | undefined;
  const host = openConversationFn(dir, {
    now: nowFn,
    presence: () => presenceProbe(),
    executorLease: () => presenceHandle?.held() === true,
    onEffect: (eff) => {
      if (eff.type === "send") receive?.(eff.frame);
    },
    onRecord: (r) => opts.onRecord?.(r),
  });

  const presenceVal = presenceProbe();
  const status = channelStatus(host.state(), nowFn(), { processAlive: presenceVal === true });
  const action = decideAction(status);
  if (action.action === "await-reattach") {
    try {
      host.close();
    } catch {}
    throw new ChatRefused(
      "presence-holds",
      `conversation ${conversationId} is already being driven (interactive session still attached) — use watch for read-only viewing`,
    );
  }

  // Try to acquire presence — failure means someone else drives.
  let presence: PresenceHandle;
  try {
    presence = acquirePresenceFn(dir, conversationId, {});
  } catch (cause) {
    try {
      host.close();
    } catch {}
    const msg = cause instanceof Error ? cause.message : String(cause);
    throw new ChatRefused(
      "lease-held",
      `conversation ${conversationId} is already being driven (${msg}) — use watch for read-only viewing`,
    );
  }
  presenceHandle = presence;
  let released = false;
  const doRelease = (): void => {
    if (released) return;
    released = true;
    try {
      presence.release();
    } catch {}
  };

  let turnCount = 0;
  const runner = opts.runner ?? createHcnRunner(nodeHarnessDeps());
  const profile = (await supportsSession(runner, harness)) ? "headless-session" : "headless-turn";

  const baseDeps = {
    harness,
    conversationId,
    secret,
    runner,
    mintTurnId: () => `turn-${++turnCount}`,
    sendFrame: (frame: Frame) => host.handleFrame(JSON.stringify(frame)),
    host: {
      cursor: () => host.cursor(),
      collectEffects: (from: number) => host.collectEffects(from),
      advanceCursor: (off: number) => host.advanceCursor(off),
    },
  } as const;

  let source: ReturnType<typeof createHeadlessHost>;
  try {
    source =
      profile === "headless-session"
        ? createHeadlessHostFn({ ...baseDeps, sessionId: uuidFn() }, "headless-session")
        : createHeadlessHostFn(baseDeps, "headless-turn");
  } catch (e) {
    try {
      host.close();
    } catch {}
    doRelease();
    throw e;
  }
  receive = source.receive;

  // Chat state — draft lives here, not in the input loop's closure, so
  // a refused submit can keep it.
  let chatDraft = "";
  let errorBanner: string | null = null;
  let following = false;
  let terminated = false;

  // Tailer for rendering — MUST use read() (lock-taking) because chat
  // acts on what it reads. The viewer uses peek() because it only paints.
  const tailer = createTailer(dir, { now: nowFn, presence: presenceProbe });

  const doRender = (): void => {
    // Lease loss detection — check handle before reading, so a lost lease
    // stops submissions even if the log has not grown.
    if (presenceHandle && !presenceHandle.held() && !following) {
      following = true;
      errorBanner = "conversation moved — another driver took over, input disabled (read-only)";
    }
    let view: ReturnType<typeof buildView>;
    try {
      // Read under the lock — the action path.
      const tail = tailer.read();
      const st = tail.state;
      const chStatus = channelStatus(st, nowFn(), { processAlive: presenceProbe() === true });
      const rung = following ? "following" : profile;
      // Build view with current draft. The draft field is what view.ts
      // already takes — this is the wiring that ticket says was missing.
      view = buildView({ transcript: tail.transcript, status: chStatus, rung, draft: chatDraft });
      // Append banner lines for error/following so they are visible in the window.
      // The banner is part of the view's lines for test observability.
      if (errorBanner) {
        view = {
          ...view,
          lines: [...view.lines, { kind: "agent" as const, text: errorBanner }],
        };
      }
      // When following, input box shows read-only hint.
      if (following) {
        view = { ...view, inputBox: `> ${chatDraft}  [read-only]` };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      view = {
        lines: [{ kind: "agent", text: `chat error: ${msg}` }],
        status: "error",
        rung: "chat",
        inputBox: `> ${chatDraft}`,
      };
      if (errorBanner) {
        view = { ...view, lines: [...view.lines, { kind: "agent", text: errorBanner }] };
      }
    }
    if (opts.onView) {
      opts.onView(view);
      return;
    }
    // Paint to terminal — clear and render. In tests, write is injected
    // but we still use renderLines for determinism.
    const lines = renderLines(view);
    // Use escape codes only on TTY; tests inject write/onView so this
    // branch is skipped there. For real TTY, clear screen.
    if (!opts.onView) {
      write("\x1b[2J\x1b[H");
      write(`${lines.join("\n")}\n`);
    } else {
      write(`${lines.join("\n")}\n`);
    }
  };

  // Follow the log — triggers render on growth. The tailer's poll
  // runs alongside fs.watch; the 500ms cadence is from tailer defaults.
  const tailerAbort = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) tailerAbort.abort();
    else opts.signal.addEventListener("abort", () => tailerAbort.abort(), { once: true });
  }
  // onTrigger uses read() — the lock-taking path.
  const onTrigger = (_t: RecordTailer): void => {
    if (terminated) return;
    // Use read() for chat — it acts on what it reads.
    try {
      // We call doRender which itself calls tailer.read(), so this is
      // one read per trigger. Avoid double-read by just rendering.
      doRender();
    } catch {}
  };

  const followPromise = followRecord({
    dir,
    pollMs: opts.pollMs ?? 50,
    signal: tailerAbort.signal,
    tailerDeps: { now: nowFn, presence: presenceProbe },
    onTrigger,
  }).catch(() => {});

  // Initial render — show the conversation before any keys.
  doRender();

  // Input handling — draft lives in chatDraft, updated on every key,
  // and submit decides answer vs queue vs steer vs refuse.
  // Refuse a non-interactive terminal before touching a record.
  requireTty({ keys: opts.keys, stdin: opts.stdin, stdout: opts.stdout });
  const keys = opts.keys;
  const tryEnqueue = (text: string, submitMode: "queue" | "steer"): void => {
    if (following) {
      errorBanner = "conversation moved — input disabled";
      chatDraft = text;
      doRender();
      return;
    }
    // Read current state under lock — the decision must be on locked state.
    let state: ReturnType<typeof host.state>;
    try {
      state = tailer.read().state;
    } catch {
      state = host.state();
    }
    const q = state.questionOpen;

    // Helper to refuse in window, keeping draft.
    const refuseInWindow = (msg: string): void => {
      errorBanner = msg;
      chatDraft = text;
      doRender();
    };

    if (q !== null) {
      // A question is open — answer path.
      if (profile === "headless-turn") {
        refuseInWindow(
          "answering needs a session profile — this harness has no session to answer into",
        );
        return;
      }
      if (q.answeringInputId !== undefined) {
        refuseInWindow("an answer is already in flight — wait for it to land");
        return;
      }
      if (InputLedger.atCapacity(state.inFlightInputs)) {
        refuseInWindow(
          `conversation too far behind — ${state.inFlightInputs} of ${INPUT_QUEUE_MAX} inputs in flight; wait for a turn to finish`,
        );
        return;
      }
      // No protocol refusal — send as answer. Mint fresh id even on retry.
      const id = uuidFn();
      const result = host.enqueueInput({ id, text, mode: "answer", turnId: q.turnId });
      if (result.verdict === "refused") {
        // Keep draft, fresh id next time — reusing refused id would draw duplicate.
        errorBanner = `${result.issue}: answer refused`;
        chatDraft = text;
        doRender();
        return;
      }
      errorBanner = null;
      chatDraft = "";
      doRender();
      return;
    }

    // No question — ordinary input. Use the submitMode from the key (queue vs steer).
    if (InputLedger.atCapacity(state.inFlightInputs)) {
      refuseInWindow(
        `conversation too far behind — ${state.inFlightInputs} of ${INPUT_QUEUE_MAX} inputs in flight; wait for a turn to finish`,
      );
      return;
    }
    const id = uuidFn();
    const result = host.enqueueInput({ id, text, mode: submitMode, turnId: undefined });
    if (result.verdict === "refused") {
      errorBanner = `${result.issue}: send refused`;
      chatDraft = text;
      doRender();
      return;
    }
    errorBanner = null;
    chatDraft = "";
    doRender();
  };

  // The key loop is `runInputLoop`'s, not a second copy of one. #48 built
  // that module for exactly this, and the first cut of this file imported
  // only its error class and reimplemented the rest - five setRawMode calls
  // of its own, its own escape-sequence handling, its own draft machine. A
  // duplicate is not just more code: it is a second thing to be wrong, and
  // it was. The live path failed to open a session under a pty while `run`
  // on the same pty did not.
  const runKeys = async (): Promise<void> => {
    await runInputLoop({
      ...(keys === undefined ? {} : { keys }),
      ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
      ...(opts.stdout === undefined ? {} : { stdout: opts.stdout }),
      onDraft: (draft) => {
        chatDraft = draft;
        // Typing clears a refusal banner: the person is answering it.
        if (draft !== "") errorBanner = null;
        doRender();
      },
      onSubmit: (text, mode) => {
        if (terminated) return;
        tryEnqueue(text, mode);
      },
      onInterrupt: () => {
        terminated = true;
      },
    });
    terminated = true;
  };

  // Ensure restore on every exit path, including throw.
  try {
    await runKeys();
  } finally {
    terminated = true;
    try {
      tailerAbort.abort();
    } catch {}
    try {
      await followPromise;
    } catch {}
    try {
      source.close();
    } catch {}
    try {
      host.close();
    } catch {}
    doRelease();
  }
};

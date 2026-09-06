import { INPUT_QUEUE_MAX } from "../protocol/events.js";
import { InputLedger } from "../protocol/ledgers/input.js";
import { classifyStoreFailure } from "../store/errors.js";
import { viewSnapshot } from "../store/store.js";
import { NotTTYError, runInputLoop } from "../tui/input.js";
import { renderLines } from "../tui/render.js";
import { buildView } from "../tui/view.js";
import { conversations } from "./record-addressing.js";
import { openDrivenConversation, PresenceAcquireError, type RuntimeDeps } from "./runtime.js";

export class ChatRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ChatRefused";
  }
}

export interface ChatOpts extends RuntimeDeps {
  readonly keys?: AsyncIterable<string>;
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly onView?: (view: ReturnType<typeof buildView>) => void;
  readonly write?: (s: string) => void;
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
  const nowFn = opts.now ?? (() => Date.now());
  const uuidFn = opts.randomUUID ?? (() => crypto.randomUUID());
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
      if (opts.conversationId === undefined) throw new NotTTYError();
      const dir = convsFactory(opts.rootDir).dirFor(opts.conversationId);
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

  let driven: Awaited<ReturnType<typeof openDrivenConversation>>;
  try {
    driven = await openDrivenConversation(opts);
  } catch (cause) {
    if (cause instanceof PresenceAcquireError) {
      throw new ChatRefused(
        "lease-held",
        `conversation is already being driven (${cause.message}) - use watch for read-only viewing`,
      );
    }
    throw cause;
  }
  if (driven.kind === "await-reattach")
    throw new ChatRefused(
      "presence-holds",
      `conversation ${driven.conversationId} is already being driven (interactive session still attached) - use watch for read-only viewing`,
    );
  const { host, source } = driven;

  // Chat state — draft lives here, not in the input loop's closure, so
  // a refused submit can keep it.
  let chatDraft = "";
  let errorBanner: string | null = null;
  let following = false;
  let terminated = false;
  let lastPaint: string | undefined;
  let driverEnded = false;

  const doRender = (): void => {
    // Lease loss detection — check handle before reading, so a lost lease
    // stops submissions even if the log has not grown.
    if (!driven.presenceHeld()) {
      following = true;
      errorBanner = driverEnded
        ? "driver stopped; input disabled (read-only)"
        : "conversation moved \u2014 another driver took over, input disabled (read-only)";
    }
    let view: ReturnType<typeof buildView>;
    try {
      const tail = host.snapshot();
      const chStatus = tail.status;
      // The rung reads the driver's live state: a preference honored
      // mid-conversation changes the profile, and the window must not
      // keep painting the one this process started under (RFC-12).
      const rung = following ? "following" : source.state().profile;
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
    const paint = `${renderLines(view).join("\n")}\n`;
    if (paint === lastPaint) return;
    write("\x1b[2J\x1b[H");
    write(paint);
    lastPaint = paint;
  };

  void driven.done
    .then(() => {
      driverEnded = true;
      if (!terminated) doRender();
    })
    .catch(() => {});

  const stopObserving = driven.observeTrigger(() => {
    if (!terminated) doRender();
  });

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
    // Submitting acts on the record, so refresh under the lock before choosing a mode.
    const state = host.collectEffects(host.cursor()).state;
    const q = state.questionOpen;

    // Helper to refuse in window, keeping draft.
    const refuseInWindow = (msg: string): void => {
      errorBanner = msg;
      chatDraft = text;
      doRender();
    };

    if (q !== null) {
      // A question is open — answer path. Read the live profile: a
      // mid-conversation driver change can move it (RFC-12).
      if (source.state().profile === "headless-turn") {
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
        try {
          tryEnqueue(text, mode);
        } catch (cause) {
          chatDraft = text;
          errorBanner = `send failed: ${classifyStoreFailure(cause) ?? "record operation failed"}; draft kept`;
          doRender();
        }
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
    stopObserving();
    driven.abort();
    await driven.done;
  }
};

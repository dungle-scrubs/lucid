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

import { type AnnounceResult, announce } from "./hooks/announce.js";
import { readStdin } from "./hooks/delivery.js";
import { type InjectResult, inject } from "./hooks/inject.js";
import { type MappedCommand, mapSubcommand } from "./mapping.js";
import type { RunOpts, RunResult } from "./run.js";
import { runConversation } from "./run.js";
import type { SendOpts } from "./send.js";
import { sendInput } from "./send.js";
import type { WatchOpts } from "./watch.js";
import { watchConversation } from "./watch.js";

/** Injected seams — defaulted in production, faked in tests. */
export interface DispatchDeps {
  /** Record root override — defaults to `process.env.LUCID_ROOT`. One read, not three. */
  readonly rootDir?: string;
  /** Command seams — injected so dispatch is testable without a flock. */
  readonly sendInputFn?: (conversationId: string, opts: SendOpts) => { inputId: string };
  readonly watchConversationFn?: (conversationId: string, opts: WatchOpts) => Promise<void>;
  readonly runConversationFn?: (opts: RunOpts) => Promise<RunResult>;
  readonly announceFn?: (stdin: string) => Promise<AnnounceResult>;
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
}

export type DispatchResult =
  | { readonly kind: "send"; readonly conversationId: string; readonly inputId: string }
  | { readonly kind: "watch"; readonly conversationId: string }
  | { readonly kind: "run"; readonly conversationId: string; readonly dir: string }
  | {
      readonly kind: "await";
      readonly conversationId: string;
      readonly dir: string;
      readonly resumeInstruction: string;
    }
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

  // One root resolution for the three record-touching commands. Not per-branch.
  const effectiveRoot = deps.rootDir ?? process.env.LUCID_ROOT;
  const sendFn = deps.sendInputFn ?? sendInput;
  const watchFn = deps.watchConversationFn ?? watchConversation;
  const runFn = deps.runConversationFn ?? runConversation;

  switch (mapped.kind) {
    case "send": {
      const { inputId } = sendFn(mapped.conversationId, {
        rootDir: effectiveRoot,
        text: mapped.text,
      });
      return { kind: "send", conversationId: mapped.conversationId, inputId };
    }
    case "watch": {
      // `watch` is long-lived — the caller (`runCli`) awaits it with a signal.
      // In tests the fake resolves immediately.
      await watchFn(mapped.conversationId, {
        rootDir: effectiveRoot,
        onView: deps.onView ?? (() => {}),
        signal: deps.signal,
      });
      return { kind: "watch", conversationId: mapped.conversationId };
    }
    case "run": {
      const result = await runFn({
        rootDir: effectiveRoot,
        conversationId: mapped.conversationId,
        harnessName: mapped.harnessName,
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
  const isWatch = argv[0] === "watch";
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

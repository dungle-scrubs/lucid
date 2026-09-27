import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The part of Pi's extension API this extension reads (Pi 0.87.1). */
interface PiSessionManager {
  getEntries(): readonly { readonly type: string }[];
  getHeader(): { readonly cwd?: string; readonly id?: string } | null | undefined;
  getSessionFile(): string | null | undefined;
  getSessionId(): string;
}
interface PiContext {
  readonly cwd: string;
  readonly mode: string;
  readonly sessionManager: PiSessionManager;
}
type PiInputResult = { readonly action: "continue" | "handled" } | undefined;
interface PiToolResultEvent {
  readonly content?: readonly unknown[];
  readonly toolCallId?: string;
  readonly toolName?: string;
}
type PiToolResult = { readonly content: readonly unknown[] } | undefined;
/** `pi.sendUserMessage` as this extension calls it (RFC 28 step 5). */
type PiSendMessage = (
  text: string,
  options?: { readonly deliverAs?: string; readonly expandPromptTemplates?: boolean },
) => unknown;
export interface PiExtensionApi {
  on(event: "session_start", handler: (event: unknown, ctx: PiContext) => void): void;
  on(event: "session_shutdown", handler: (event: unknown, ctx: PiContext) => void): void;
  on(event: "agent_settled", handler: (event: unknown, ctx: PiContext) => void): void;
  on(
    event: "tool_result",
    handler: (event: PiToolResultEvent, ctx: PiContext) => PiToolResult | Promise<PiToolResult>,
  ): void;
  on(
    event: "input",
    handler: (event: unknown, ctx: PiContext) => PiInputResult | Promise<PiInputResult>,
  ): void;
  /** Deliver a message into the session; absent in a runtime that predates it. */
  readonly sendUserMessage?: PiSendMessage;
}

/** How the extension runs the helper: the lucid command and the record root it serves. */
export interface PiHelperCommand {
  readonly command: readonly string[];
  readonly root: string;
}

/** The part of a spawned child the interactive role reads; tests pass a fake. */
export interface PiHelperChild {
  kill(signal?: string): void;
  on(event: "close" | "error" | "exit", listener: () => void): void;
  readonly stdin: {
    end(data?: string): void;
    on(event: "error", listener: (error: unknown) => void): void;
  };
  readonly stdout: { on(event: "data", listener: (chunk: unknown) => void): void } | undefined;
}

/** `child_process.spawn` as the interactive role calls it. */
export type PiHelperSpawn = (
  command: string,
  args: readonly string[],
  options: unknown,
) => PiHelperChild;

/** Timer functions the interactive role schedules its helper timeout with; tests pass a fake. */
export interface PiHelperTimers {
  clearTimeout(handle: unknown): void;
  setTimeout(handler: () => void, ms: number): unknown;
}

/**
 * The Lucid Pi extension (RFC 28). It runs inside Pi, not inside Lucid:
 * `piExtensionSource` serializes it with `Function.prototype.toString`, so
 * it references nothing outside its own body except globals.
 *
 * Two roles, decided from `ctx.mode` in `session_start` (RFC 28 "Roles by
 * mode"): `json` or `print` with `LUCID_PI_ATTEMPT` set is the headless
 * verify-after-open role; `tui` with a lucid command is the interactive
 * role, which registers the session and commits its Bash proposals through
 * the `_pi-hook` helper. Every other run takes no role: handlers return
 * undefined and never throw into Pi.
 */
export function lucidPiExtension(
  pi: PiExtensionApi,
  lucid?: PiHelperCommand,
  spawnHelper?: PiHelperSpawn,
  timers?: PiHelperTimers,
): void {
  const env = process.env;
  const attemptValue = env.LUCID_PI_ATTEMPT;
  const expectedSession = env.LUCID_PI_EXPECTED_SESSION;
  const expectedCwd = env.LUCID_PI_EXPECTED_CWD;
  const attestationPath = env.LUCID_PI_ATTESTATION;
  delete env.LUCID_PI_ATTEMPT;
  delete env.LUCID_PI_EXPECTED_SESSION;
  delete env.LUCID_PI_EXPECTED_CWD;
  delete env.LUCID_PI_ATTESTATION;
  if (attemptValue === undefined && lucid === undefined) return;
  const fs = process.getBuiltinModule("node:fs");
  const attempt =
    /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{64})$/.exec(
      attemptValue ?? "",
    );
  let role: "headless" | "interactive" | "none" | undefined;
  let verified = false;

  // ---- Interactive role (RFC 28 steps 1-3): one short-lived helper per event. ----
  const MARKER_TOKEN = /lucid-pi-proposal:[0-9a-f-]{36}/gi;
  const HELPER_RESULT_MAX = 49152;
  const HELPER_TIMEOUT_MS = 15000;
  const SETTLED_TIMEOUT_MS = 60000;
  const CANCEL_KILL_MS = 2000;
  // After the cancel SIGKILL, how long the supervisor still waits for exit evidence.
  const CANCEL_FINAL_MS = 1000;
  const UNCONFIRMED = "Lucid could not confirm these proposals. They are not retried.";
  const clock: PiHelperTimers = timers ?? {
    clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
    setTimeout: (handler, ms) => setTimeout(handler, ms),
  };
  const capture = (name: string, ctx: PiContext, extra?: Record<string, unknown>) => ({
    v: 1,
    event: name,
    mode: "tui",
    pid: process.pid,
    execPath: process.execPath,
    nativeSessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile() ?? null,
    workingDirectory: ctx.cwd,
    ...(extra ?? {}),
  });
  /** Spawn the helper, feed it one capture, and return its one JSON result, or undefined. */
  const runHelper = (
    name: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> =>
    new Promise((resolve) => {
      if (lucid === undefined || lucid.command.length === 0) {
        resolve(undefined);
        return;
      }
      const [program, ...tail] = lucid.command;
      if (program === undefined) {
        resolve(undefined);
        return;
      }
      let child: PiHelperChild;
      try {
        const spawn = (spawnHelper ??
          process.getBuiltinModule("node:child_process").spawn) as PiHelperSpawn;
        child = spawn(program, [...tail, "_pi-hook", name, "--root", lucid.root], {
          stdio: ["pipe", "pipe", "ignore"],
        });
      } catch {
        resolve(undefined);
        return;
      }
      let done = false;
      let bytes = 0;
      const chunks: Buffer[] = [];
      const finish = (value: Record<string, unknown> | undefined) => {
        if (done) return;
        done = true;
        clock.clearTimeout(timer);
        try {
          child.kill("SIGKILL");
        } catch {}
        resolve(value);
      };
      const timer = clock.setTimeout(() => finish(undefined), HELPER_TIMEOUT_MS);
      child.on("error", () => finish(undefined));
      child.on("close", () => {
        if (done) return;
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          finish(parsed !== null && typeof parsed === "object" ? parsed : undefined);
        } catch {
          finish(undefined);
        }
      });
      if (child.stdout)
        child.stdout.on("data", (chunk: unknown) => {
          if (done) return;
          const buffer =
            typeof chunk === "string"
              ? Buffer.from(chunk, "utf8")
              : chunk instanceof Uint8Array
                ? Buffer.from(chunk)
                : Buffer.from(String(chunk));
          chunks.push(buffer);
          bytes += buffer.length;
          if (bytes > HELPER_RESULT_MAX) finish(undefined);
        });
      child.stdin.on("error", () => {});
      try {
        child.stdin.end(JSON.stringify(data));
      } catch {
        finish(undefined);
      }
    });

  // ---- Interactive listening (RFC 28 steps 4-6): one supervised settled helper. ----
  let closing = false;
  let current:
    | {
        readonly child: PiHelperChild;
        readonly exited: Promise<void>;
        readonly terminate: () => void;
      }
    | undefined;
  /** One field of an event object, when the event is a plain object. */
  const field = (event: unknown, name: string): unknown =>
    event !== null && typeof event === "object" && !Array.isArray(event)
      ? (event as Record<string, unknown>)[name]
      : undefined;

  /** RFC 28 step 4: start the settled helper unawaited; the supervisor owns its lifecycle. */
  const startSettled = (ctx: PiContext): void => {
    if (closing || current !== undefined || lucid === undefined || lucid.command.length === 0)
      return;
    const [program, ...tail] = lucid.command;
    if (program === undefined) return;
    let child: PiHelperChild;
    try {
      const spawn = (spawnHelper ??
        process.getBuiltinModule("node:child_process").spawn) as PiHelperSpawn;
      child = spawn(program, [...tail, "_pi-hook", "settled", "--root", lucid.root], {
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      return;
    }
    let settled = false;
    let closed = false;
    let discarded = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    let deadline: unknown;
    let grace: unknown;
    let final: unknown;
    let released: () => void = () => {};
    const exited = new Promise<void>((resolve) => {
      released = resolve;
    });
    const discard = (signal: string): void => {
      discarded = true;
      try {
        child.kill(signal);
      } catch {}
      // A child that ignores SIGKILL (a grandchild holds its pipe) must not block
      // Pi's prompt forever: after a grace period the supervisor stops waiting.
      if (signal === "SIGKILL") final = clock.setTimeout(() => settle(), CANCEL_FINAL_MS);
    };
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(deadline);
      clock.clearTimeout(grace);
      clock.clearTimeout(final);
      current = undefined;
      released();
    };
    current = {
      child,
      exited,
      terminate: () => {
        discarded = true;
        clock.clearTimeout(deadline);
        clock.clearTimeout(grace);
        clock.clearTimeout(final);
        try {
          child.kill("SIGTERM");
        } catch {}
        grace = clock.setTimeout(() => discard("SIGKILL"), CANCEL_KILL_MS);
      },
    };
    deadline = clock.setTimeout(() => discard("SIGKILL"), SETTLED_TIMEOUT_MS);
    // `exit` proves the process is gone even when a grandchild holds the pipes
    // open and `close` never fires; `error` covers a spawn that never was.
    child.on("error", () => settle());
    child.on("exit", () => settle());
    child.on("close", () => {
      if (closed) return;
      closed = true;
      // The supervisor clears current before the result is read (RFC 28 step 4),
      // so the next agent_settled may already start a new helper while this one
      // delivers. A cancelled or timed-out helper never delivers, even when it
      // printed an offer (RFC 28 step 6).
      settle();
      if (discarded) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const record = parsed as Record<string, unknown>;
      const result = record.result;
      if (
        record.kind !== "listener" ||
        result === null ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        (result as Record<string, unknown>).kind !== "offered" ||
        typeof (result as Record<string, unknown>).payload !== "string"
      )
        return;
      try {
        // RFC 28 step 5: a throw here leaves the offer delivery-uncertain; nothing replays it.
        pi.sendUserMessage?.((result as { payload: string }).payload, {
          deliverAs: "followUp",
          expandPromptTemplates: false,
        });
      } catch {}
    });
    if (child.stdout)
      child.stdout.on("data", (chunk: unknown) => {
        const buffer =
          typeof chunk === "string"
            ? Buffer.from(chunk, "utf8")
            : chunk instanceof Uint8Array
              ? Buffer.from(chunk)
              : Buffer.from(String(chunk));
        chunks.push(buffer);
        bytes += buffer.length;
        if (bytes > HELPER_RESULT_MAX) discard("SIGKILL");
      });
    child.stdin.on("error", () => {});
    try {
      child.stdin.end(JSON.stringify(capture("settled", ctx)));
    } catch {
      discard("SIGKILL");
    }
  };

  /** RFC 28 step 6: kill a running settled helper and await its exit; idempotent. */
  const cancelSettled = async (): Promise<void> => {
    const running = current;
    if (running === undefined) return;
    running.terminate();
    await running.exited;
  };

  pi.on("session_start", async (event, ctx) => {
    try {
      if (attemptValue !== undefined && (ctx.mode === "json" || ctx.mode === "print")) {
        role = "headless";
        process.exitCode = 3;
        if (!attempt || !expectedSession || !expectedCwd || !attestationPath) return;
        const real = (path: string | undefined): string | undefined => {
          try {
            return path === undefined ? undefined : fs.realpathSync.native(path);
          } catch {
            return undefined;
          }
        };
        const expectedReal = real(expectedCwd);
        const sameFolder = (path: string | undefined): boolean =>
          path === expectedCwd || (expectedReal !== undefined && real(path) === expectedReal);
        let opened = "";
        let reason: string | undefined;
        try {
          opened = ctx.sessionManager.getSessionId();
          const header = ctx.sessionManager.getHeader();
          if (opened !== expectedSession || header?.id !== expectedSession)
            reason = "session-id-mismatch";
          else if (!sameFolder(header.cwd) || !sameFolder(ctx.cwd)) reason = "folder-mismatch";
          else if (!ctx.sessionManager.getEntries().some((entry) => entry.type === "message"))
            reason = "session-empty";
        } catch {
          reason = "verification-failed";
        }
        const record = {
          v: 1,
          attempt: attempt[1],
          nonce: attempt[2],
          outcome: reason === undefined ? "verified" : "refused",
          ...(reason === undefined ? {} : { reason }),
          expected: expectedSession,
          opened,
        };
        try {
          fs.writeFileSync(attestationPath, `${JSON.stringify(record)}\n`, {
            flag: "wx",
            mode: 0o600,
          });
        } catch {
          return;
        }
        if (reason === undefined) {
          verified = true;
          process.exitCode = 0;
        }
        return;
      }
      if (ctx.mode === "tui" && lucid !== undefined) {
        role = "interactive";
        // A replacing session_start cancels a running settled helper first (RFC 28 step 6).
        const reason = field(event, "reason");
        if (reason === "new" || reason === "resume" || reason === "fork" || reason === "reload")
          await cancelSettled();
        // Registration failure is the helper's to report; the session still runs.
        await runHelper("session-start", capture("session-start", ctx));
        return;
      }
      role = "none";
    } catch {
      /* A handler must never throw into Pi (RFC 28 Error Handling). */
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      if (role === "interactive" && lucid !== undefined) {
        // Shutdown is closing: a settled helper that fires now starts nothing.
        closing = true;
        await cancelSettled();
        await runHelper("session-shutdown", capture("session-shutdown", ctx));
      }
    } catch {
      /* Shutdown completes whatever Lucid observed. */
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    try {
      if (role !== "interactive" || lucid === undefined) return undefined;
      if (event.toolName !== "bash") return undefined;
      const content = Array.isArray(event.content) ? event.content : [];
      const markers: string[] = [];
      for (const item of content) {
        if (item === null || typeof item !== "object") continue;
        const block = item as { readonly text?: unknown; readonly type?: unknown };
        if (block.type !== "text" || typeof block.text !== "string") continue;
        for (const match of block.text.matchAll(MARKER_TOKEN))
          if (!markers.includes(match[0])) markers.push(match[0]);
      }
      if (markers.length === 0) return undefined;
      if (markers.length > 16)
        return {
          content: [
            ...content,
            {
              type: "text",
              text: "Lucid: more than 16 proposals in one command; none was recorded.",
            },
          ],
        };
      const result = await runHelper(
        "tool-result",
        capture("tool-result", ctx, { markers, toolCallId: event.toolCallId }),
      );
      const text =
        result !== null &&
        typeof result === "object" &&
        result.kind === "committed" &&
        typeof result.text === "string"
          ? result.text
          : result !== null &&
              typeof result === "object" &&
              result.kind === "refused" &&
              typeof result.message === "string"
            ? `Lucid refused: ${result.message}`
            : UNCONFIRMED;
      return { content: [...content, { type: "text", text }] };
    } catch {
      return undefined;
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    try {
      if (role !== "interactive" || lucid === undefined) return;
      // The helper runs unawaited; the supervisor owns its lifecycle, so a second
      // agent_settled while one runs starts nothing (RFC 28 step 4).
      startSettled(ctx);
    } catch {
      /* A handler must never throw into Pi. */
    }
  });

  // The pre-model gate belongs to the headless role alone (R4-R7); in the
  // interactive role `input` must never hold the person's prompt.
  pi.on("input", async (event) => {
    try {
      if (attemptValue !== undefined && role !== "none" && role !== "interactive")
        return verified ? { action: "continue" } : { action: "handled" };
      // Person input cancels a running settled helper before it can inject (RFC 28 step 6).
      if (role === "interactive" && field(event, "source") === "interactive") await cancelSettled();
      return undefined;
    } catch {
      /* The interactive role never holds the prompt; the headless gate stays closed. */
      return attemptValue !== undefined && role !== "none" && role !== "interactive"
        ? { action: "handled" }
        : undefined;
    }
  });
}

/** The extension file's text: an ES module whose default export is the extension. */
export function piExtensionSource(lucid?: PiHelperCommand): string {
  if (lucid === undefined)
    return `// Lucid Pi extension (RFC 28). Written by Lucid; do not edit.\nexport default ${lucidPiExtension.toString()};\n`;
  return `// Lucid Pi extension (RFC 28). Written by Lucid; do not edit.\nconst LUCID = ${JSON.stringify(lucid)};\nconst extension = ${lucidPiExtension.toString()};\nexport default function (pi) { return extension(pi, LUCID); }\n`;
}

/** Write the extension under the record root, named by its content hash, and
 * return its path. An existing file with the same text is reused; any other
 * content at that path is replaced. Throws when the file cannot be written. */
export function materializePiExtension(root: string, lucid?: PiHelperCommand): string {
  const source = piExtensionSource(lucid);
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const dir = join(root, ".integrations", "pi");
  const path = join(dir, `lucid-${digest}.js`);
  try {
    if (readFileSync(path, "utf8") === source) return path;
  } catch {
    // Absent or unreadable: write it below.
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, source, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  return path;
}

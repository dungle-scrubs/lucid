/**
 * The keypress loop: owns raw mode and its restoration, accumulates a
 * draft, and hands it over on submit.
 *
 * `render.ts` says it is NOT responsible for input reading — the driver
 * owns the keypress loop — and until this module there was no driver.
 * `view.ts:buildView` already takes a `draft` field where the in-progress
 * text goes on every paint. This module fills that field.
 *
 * It is NOT wired to a conversation here (ticket #49 assembles it). It
 * reads keys and reports what was typed, distinguishing an ordinary
 * submit from one that asks to interrupt a running turn, and an
 * interrupt from a submit so the caller can quit cleanly.
 *
 * Raw mode is restored on every exit path including a throw — a
 * terminal left raw after a crash is the worst small bug available
 * here. The loop refuses a non-interactive terminal rather than
 * painting escape codes into a pipe. Tests drive it with a synthetic
 * key source, not a pty, so the key source is injectable.
 */

export class NotTTYError extends Error {
  constructor(message = "not a TTY: refusing to take over a non-interactive terminal") {
    super(message);
    this.name = "NotTTYError";
  }
}

export type SubmitMode = "queue" | "steer";

export type InputResult =
  | { readonly kind: "submit"; readonly text: string; readonly mode: SubmitMode }
  | { readonly kind: "interrupt" };

export interface InputOptions {
  /** Defaults to process.stdin. Injected so tests supply a fake. */
  readonly stdin?: NodeJS.ReadStream;
  /** Defaults to process.stdout. Checked for TTY alongside stdin. */
  readonly stdout?: NodeJS.WriteStream;
  /**
   * Synthetic key source for tests. When provided, TTY checks and raw
   * mode are skipped and keys are consumed directly — the deterministic
   * suite has no pty.
   */
  readonly keys?: AsyncIterable<string>;
  /** Called after every draft mutation so the painter can repaint with
   * the current draft while the conversation grows underneath. The
   * paint clears the screen, so the draft must be supplied on every
   * paint. */
  readonly onDraft: (draft: string) => void;
}

// Control characters — the only bytes the driver interprets. Everything
// else with a printable presentation accumulates.
const CTRL_C = "\x03";
const CTRL_D = "\x04";
const BACKSPACE = "\x7f";
const BACKSPACE_ALT = "\x08";
const CTRL_U = "\x15";
const ESC = "\x1b";

// Submit keys: Enter submits ordinary (queue), Alt+Enter submits with
// interrupt intent (steer). Which key interrupts is Open Question 2;
// the RFC recommends a modifier on submit rather than a mode toggle,
// so interrupting is a property of this message, not a state the human
// remembers being in. Alt+Enter delivers Esc+CR in raw mode and is
// distinct from Enter without needing a separate terminal mode.
const CR = "\r";
const LF = "\n";

type ParsedKey =
  | { kind: "char"; char: string }
  | { kind: "backspace" }
  | { kind: "clear" }
  | { kind: "submit"; mode: SubmitMode }
  | { kind: "interrupt" }
  | { kind: "ignore" };

/**
 * Parse one code-point (or Esc+CR pair already combined by the caller)
 * into a semantic key. Printable code points accumulate; control bytes
 * are interpreted; everything else is ignored so an arrow-key escape
 * sequence does not inject bytes into the draft.
 */
const parseSingle = (ch: string, isAltEnter: boolean): ParsedKey => {
  if (isAltEnter) return { kind: "submit", mode: "steer" };
  if (ch === CTRL_C || ch === CTRL_D) return { kind: "interrupt" };
  if (ch === BACKSPACE || ch === BACKSPACE_ALT) return { kind: "backspace" };
  if (ch === CTRL_U) return { kind: "clear" };
  if (ch === CR || ch === LF) return { kind: "submit", mode: "queue" };
  // Ignore other C0 controls and DEL variants; arrow keys arrive as
  // Esc [ A etc and are filtered here byte by byte.
  const code = ch.charCodeAt(0);
  if (code < 0x20 || code === 0x7f) return { kind: "ignore" };
  return { kind: "char", char: ch };
};

/**
 * Drive the draft machine over an async key source, reporting every
 * draft mutation via onDraft. Returns on the first submit (with the
 * draft cleared) or interrupt. Empty submits are ignored — no event
 * and no clear — so an accidental Enter does not hand over nothing.
 */
async function* driveAll(
  keys: AsyncIterable<string>,
  onDraft: (draft: string) => void,
): AsyncGenerator<InputResult> {
  let draft = "";
  // Esc seen at end of previous chunk and not yet resolved — the next
  // chunk's first char decides alt-enter vs lone Esc.
  let pendingEsc = false;

  for await (const chunk of keys) {
    // Iterate by code points so a surrogate pair counts as one
    // backspace unit and one draft position.
    const points = [...chunk];
    for (let i = 0; i < points.length; i++) {
      const ch = points[i] as string;

      // Resolve a pending Esc from the previous chunk.
      if (pendingEsc) {
        pendingEsc = false;
        if (ch === CR || ch === LF) {
          // Alt+Enter split across chunks.
          if (draft.length > 0) {
            const text = draft;
            draft = "";
            onDraft(draft);
            yield { kind: "submit", text, mode: "steer" };
            continue;
          }
          continue;
        }
        // Lone Esc — ignore it and fall through to handle ch normally
        // (do not skip ch).
      }

      // Esc+CR/LF inside the same chunk is alt-enter (steer).
      if (ch === ESC) {
        const next = points[i + 1];
        if (next === CR || next === LF) {
          i++;
          if (draft.length > 0) {
            const text = draft;
            draft = "";
            onDraft(draft);
            yield { kind: "submit", text, mode: "steer" };
            continue;
          }
          continue;
        }
        // Esc at end of chunk — may be alt-enter split across chunks.
        if (i === points.length - 1) {
          pendingEsc = true;
          continue;
        }
        // Esc followed by non-CR/LF — part of an arrow-key sequence;
        // filter the whole CSI so it does not inject bytes (e.g. Esc [ A
        // for Up would otherwise leave "[A" in the draft).
        if (next === "[") {
          // Skip CSI introducer and its parameters until the final byte
          // (A-Za-z). For the cases here that is two more chars.
          let j = i + 1;
          while (
            j < points.length &&
            points[j] !== undefined &&
            !/[A-Za-z]/.test(points[j] as string)
          )
            j++;
          if (j < points.length) i = j;
          else i = points.length - 1;
        }
        continue;
      }

      const parsed = parseSingle(ch, false);
      switch (parsed.kind) {
        case "interrupt":
          yield { kind: "interrupt" };
          return;
        case "submit": {
          if (draft.length === 0) continue;
          const text = draft;
          draft = "";
          onDraft(draft);
          yield { kind: "submit", text, mode: parsed.mode };
          continue;
        }
        case "backspace": {
          if (draft.length > 0) {
            const pts = [...draft];
            pts.pop();
            draft = pts.join("");
            onDraft(draft);
          }
          break;
        }
        case "clear": {
          if (draft.length > 0) {
            draft = "";
            onDraft(draft);
          }
          break;
        }
        case "char": {
          draft += parsed.char;
          onDraft(draft);
          break;
        }
        case "ignore":
          break;
      }
    }
  }
  // Source exhausted without submit or interrupt — treat as interrupt
  // so a finite synthetic source does not hang the caller.
  yield { kind: "interrupt" };
  return;
}

const isTTYStream = (s: unknown): boolean =>
  typeof s === "object" && s !== null && "isTTY" in s && (s as { isTTY?: boolean }).isTTY === true;
/**
 * Read one submission. Enters raw mode, loops until Enter (queue) or
 * Alt+Enter (steer) submits the draft, or Ctrl+C / Ctrl+D interrupts.
 * Reports every draft change via onDraft so the view survives repaints.
 * Restores raw mode on every exit path, including a throw from onDraft
 * or from the key source.
 *
 * When `keys` is supplied the TTY guard and raw-mode dance are skipped
 * so the deterministic suite can drive the loop without a pty.
 */
/**
 * The keys, and how to give the terminal back.
 *
 * One place owns raw mode, the encoding, and the restore. Both entry points
 * below take their keys from here, so the path a test drives and the path a
 * person drives are the same path - which is the whole point of the source
 * being injectable. The first cut had `runInputLoop` reimplement the decode
 * inline for its synthetic branch, so the tests covered one implementation
 * and a person used another.
 */
const openKeys = (opts: InputOptions): { keys: AsyncIterable<string>; restore: () => void } => {
  if (opts.keys) return { keys: opts.keys, restore: () => {} };

  const stdin = (opts.stdin ?? process.stdin) as NodeJS.ReadStream & {
    setRawMode?: (mode: boolean) => void;
    isTTY?: boolean;
    isRaw?: boolean;
    setEncoding?: (enc: string) => void;
    resume?: () => void;
    pause?: () => void;
  };
  const stdout = (opts.stdout ?? process.stdout) as NodeJS.WriteStream & { isTTY?: boolean };
  if (!isTTYStream(stdin) || !isTTYStream(stdout)) throw new NotTTYError();

  const hadRaw = Boolean(stdin.isRaw);
  let rawEntered = false;
  if (typeof stdin.setRawMode === "function") {
    stdin.setRawMode(true);
    rawEntered = true;
  }
  // Node delivers Buffers by default; utf8 gives strings the driver
  // iterates by code point.
  if (typeof stdin.setEncoding === "function") stdin.setEncoding("utf8");
  if (typeof stdin.resume === "function") stdin.resume();

  const keys: AsyncIterable<string> = {
    async *[Symbol.asyncIterator](): AsyncIterator<string> {
      for await (const chunk of stdin as unknown as AsyncIterable<string | Buffer>) {
        yield typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
      }
    },
  };
  return {
    keys,
    restore: () => {
      if (rawEntered && typeof stdin.setRawMode === "function") {
        try {
          stdin.setRawMode(hadRaw);
        } catch {}
      }
      if (typeof stdin.pause === "function") {
        try {
          stdin.pause();
        } catch {}
      }
    },
  };
};

/**
 * The keypress loop that lives for the life of a chat session: stays
 * in raw mode across submits, reports every draft change, hands each
 * non-empty submit to onSubmit with its mode, and exits on interrupt.
 * Owns raw mode for the whole loop so mode is not thrased per submit.
 */
export const runInputLoop = async (
  opts: InputOptions & {
    readonly onSubmit: (text: string, mode: SubmitMode) => void | Promise<void>;
    readonly onInterrupt: () => void | Promise<void>;
  },
): Promise<void> => {
  const { keys, restore } = openKeys(opts);
  try {
    // One generator across every submit. It keeps reading rather than
    // returning on the first one, so the reading position survives a
    // submit - `for await` would close the key source on an early exit.
    for await (const result of driveAll(keys, opts.onDraft)) {
      if (result.kind === "interrupt") {
        await opts.onInterrupt();
        return;
      }
      try {
        await opts.onSubmit(result.text, result.mode);
      } catch {
        // A submit handler that fails must not take the session down with
        // it. The loop reads keys; what a refused submit means belongs to
        // the caller, which shows it in the window. Killing the window
        // here would lose the person's place over a refusal they could
        // have retyped.
      }
    }
  } finally {
    restore();
  }
};

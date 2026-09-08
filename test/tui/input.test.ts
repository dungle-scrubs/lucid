import { describe, expect, test } from "bun:test";
import {
  type InputOptions,
  type InputResult,
  NotTTYError,
  runInputLoop,
} from "../../src/tui/input.js";
import { buildView } from "../../src/tui/view.js";

// Synthetic source helper: yields each string as one chunk.
async function* keysOf(...chunks: string[]): AsyncIterable<string> {
  for (const c of chunks) yield c;
}

// Fake TTY stream that is async iterable and records raw-mode transitions.
type FakeStdin = NodeJS.ReadStream & {
  rawCalls: boolean[];
  getRaw(): boolean;
};

const fakeStdin = (chunks: string[], isTTY = true): FakeStdin => {
  const rawCalls: boolean[] = [];
  let raw = false;
  const s = {
    isTTY,
    isRaw: false,
    setRawMode(mode: boolean) {
      rawCalls.push(mode);
      raw = mode;
      (s as unknown as { isRaw: boolean }).isRaw = mode;
    },
    setEncoding() {},
    resume() {},
    pause() {},
    rawCalls,
    getRaw: () => raw,
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) yield c;
    },
  } as unknown as FakeStdin;
  // Attach rawCalls for inspection.
  (s as unknown as { rawCalls: boolean[] }).rawCalls = rawCalls;
  return s;
};

const fakeStdout = (isTTY = true): NodeJS.WriteStream =>
  ({ isTTY }) as unknown as NodeJS.WriteStream;

describe("TUI input driver (M6.1 step 5)", () => {
  test("typing accumulates into a draft; backspace removes; submit hands over text and clears", async () => {
    const drafts: string[] = [];
    const result = await firstInput({
      keys: keysOf("h", "e", "l", "l", "o", "\x7f", "\r"),
      onDraft: (d) => drafts.push(d),
    });

    expect(result).toEqual({ kind: "submit", text: "hell", mode: "queue" });
    // Draft reported on every mutation, cleared on submit.
    expect(drafts).toEqual(["h", "he", "hel", "hell", "hello", "hell", ""]);
  });

  test("backspace on empty draft is a no-op and does not report", async () => {
    const drafts: string[] = [];
    const result = await firstInput({
      keys: keysOf("\x7f", "\x7f", "a", "\r"),
      onDraft: (d) => drafts.push(d),
    });
    expect(result).toEqual({ kind: "submit", text: "a", mode: "queue" });
    expect(drafts).toEqual(["a", ""]);
  });

  test("empty submit is ignored — no handover, no clear", async () => {
    const drafts: string[] = [];
    const result = await firstInput({
      keys: keysOf("\r", "x", "\r"),
      onDraft: (d) => drafts.push(d),
    });
    // First Enter ignored, second submits "x".
    expect(result).toEqual({ kind: "submit", text: "x", mode: "queue" });
    expect(drafts).toEqual(["x", ""]);
  });

  test("the draft is reported to whoever is painting, so it survives a repaint", async () => {
    // The conversation can grow while someone is typing and the paint
    // clears the screen — the draft must be supplied on every paint via
    // the onDraft callback so buildView can carry it.
    let draft = "";
    const drafts: string[] = [];
    const onDraft = (d: string) => {
      draft = d;
      drafts.push(d);
    };

    // Type "hi" then simulate a log-growth repaint: buildView with
    // current draft plus a new transcript.
    const transcript1 = {
      events: [{ seq: 1, turnId: "t-1", event: { kind: "message", text: "hello" } }],
      inputs: [],
      aborted: [],
    } as unknown as Parameters<typeof buildView>[0]["transcript"];
    const viewBefore = buildView({
      transcript: transcript1,
      status: "headless-session",
      rung: "watch",
      draft,
    });
    expect(viewBefore.inputBox).toBe("> ");

    // Drive two keys, each reporting draft.
    const resultPromise = firstInput({ keys: keysOf("h", "i", "\r"), onDraft });
    const result = await resultPromise;
    expect(result).toEqual({ kind: "submit", text: "hi", mode: "queue" });

    // A repaint after typing must show the draft in the input box.
    // Simulate the tailer delivering a new event while the draft was "hi"
    // — the view is rebuilt with the same draft.
    const transcript2 = {
      events: [
        { seq: 1, turnId: "t-1", event: { kind: "message", text: "hello" } },
        { seq: 2, turnId: "t-1", event: { kind: "message", text: "second" } },
      ],
      inputs: [],
      aborted: [],
    } as unknown as Parameters<typeof buildView>[0]["transcript"];
    // While the draft was "hi" (before submit cleared it), a repaint
    // would have carried it. Verify onDraft saw "h" then "hi" before clear.
    expect(drafts).toEqual(["h", "hi", ""]);
    const viewWhileTyping = buildView({
      transcript: transcript2,
      status: "headless-session",
      rung: "watch",
      draft: "hi",
    });
    expect(viewWhileTyping.inputBox).toBe("> hi");
    expect(viewWhileTyping.lines.some((l) => l.text.includes("second"))).toBe(true);
  });

  test("an interrupt is distinguishable from a submit", async () => {
    const drafts: string[] = [];
    const submit = await firstInput({ keys: keysOf("x", "\r"), onDraft: (d) => drafts.push(d) });
    expect(submit.kind).toBe("submit");

    const interrupted = await firstInput({ keys: keysOf("x", "\x03"), onDraft: () => {} });
    expect(interrupted).toEqual({ kind: "interrupt" });

    // Ctrl+D also interrupts (EOF-style quit).
    const interrupted2 = await firstInput({ keys: keysOf("\x04"), onDraft: () => {} });
    expect(interrupted2).toEqual({ kind: "interrupt" });
  });

  test("the caller can distinguish an ordinary submit from one that asks to interrupt a running turn", async () => {
    // Enter -> queue, Alt+Enter (Esc+CR) -> steer. The protocol has had
    // steer from the start and nothing in a terminal has ever reached it.
    const ordinary = await firstInput({ keys: keysOf("a", "\r"), onDraft: () => {} });
    expect(ordinary).toEqual({ kind: "submit", text: "a", mode: "queue" });

    const steering = await firstInput({ keys: keysOf("b", "\x1b\r"), onDraft: () => {} });
    expect(steering).toEqual({ kind: "submit", text: "b", mode: "steer" });

    // Alt+Enter with LF also steers.
    const steering2 = await firstInput({ keys: keysOf("c", "\x1b\n"), onDraft: () => {} });
    expect(steering2).toEqual({ kind: "submit", text: "c", mode: "steer" });

    // Alt+Enter split across chunks (Esc at end of one, CR in next).
    const steering3 = await firstInput({ keys: keysOf("d", "\x1b", "\r"), onDraft: () => {} });
    expect(steering3).toEqual({ kind: "submit", text: "d", mode: "steer" });
  });

  test("driven in tests by a synthetic key source, not a pty — the loop is injectable", async () => {
    // The whole suite uses keys AsyncIterable; no stdin/stdout TTY is
    // touched. Verify a multi-chunk source with embedded backspace and
    // steer works without a terminal.
    const drafts: string[] = [];
    const result = await firstInput({
      keys: keysOf(
        "h",
        "e",
        "l",
        "l",
        "o",
        " ",
        "w",
        "o",
        "r",
        "l",
        "d",
        "\x7f",
        "\x7f",
        "x",
        "\x1b\r",
      ),
      onDraft: (d) => drafts.push(d),
    });
    // "hello world" minus two backspaces plus "x" -> "hello worx", steer.
    expect(result).toEqual({ kind: "submit", text: "hello worx", mode: "steer" });
    expect(drafts.at(-1)).toBe("");
  });

  test("it refuses to take over a terminal that is not interactive", async () => {
    await expect(
      firstInput({ stdin: fakeStdin([], false), stdout: fakeStdout(true), onDraft: () => {} }),
    ).rejects.toBeInstanceOf(NotTTYError);
    await expect(
      firstInput({ stdin: fakeStdin([], true), stdout: fakeStdout(false), onDraft: () => {} }),
    ).rejects.toBeInstanceOf(NotTTYError);
    // Synthetic source bypasses the TTY guard — injectable means testable
    // without a pty, so a non-TTY with keys still works.
    const ok = await firstInput({
      stdin: fakeStdin([], false),
      stdout: fakeStdout(false),
      keys: keysOf("a", "\r"),
      onDraft: () => {},
    });
    expect(ok).toEqual({ kind: "submit", text: "a", mode: "queue" });
  });

  test("raw mode is restored on every exit path, including a throw", async () => {
    // Submit path restores.
    const stdin1 = fakeStdin(["a", "\r"], true);
    await firstInput({ stdin: stdin1, stdout: fakeStdout(true), onDraft: () => {} });
    expect(stdin1.rawCalls).toEqual([true, false]);

    // Interrupt path restores.
    const stdin2 = fakeStdin(["\x03"], true);
    await firstInput({ stdin: stdin2, stdout: fakeStdout(true), onDraft: () => {} });
    expect(stdin2.rawCalls).toEqual([true, false]);

    // Throw from onDraft restores before propagating.
    const stdin3 = fakeStdin(["a", "b", "\r"], true);
    await expect(
      firstInput({
        stdin: stdin3,
        stdout: fakeStdout(true),
        onDraft: () => {
          throw new Error("paint blew up");
        },
      }),
    ).rejects.toThrow("paint blew up");
    expect(stdin3.rawCalls).toEqual([true, false]);

    // Throw from key source restores too. Use a throwing iterable.
    const _throwingKeys: AsyncIterable<string> = {
      async *[Symbol.asyncIterator]() {
        yield "a";
        throw new Error("source failed");
      },
    };
    // Synthetic path does not use raw mode, so no rawCalls — but for
    // live stdin, verify restoration on source throw:
    const failingStdin = {
      isTTY: true,
      isRaw: false,
      setRawMode(mode: boolean) {
        (failingStdin as unknown as { rawCalls: boolean[] }).rawCalls.push(mode);
      },
      setEncoding() {},
      resume() {},
      pause() {},
      rawCalls: [] as boolean[],
      [Symbol.asyncIterator]: async function* () {
        yield "a";
        throw new Error("stream error");
      },
    } as unknown as FakeStdin;
    (failingStdin as unknown as { rawCalls: boolean[] }).rawCalls = [];
    await expect(
      firstInput({ stdin: failingStdin, stdout: fakeStdout(true), onDraft: () => {} }),
    ).rejects.toThrow("stream error");
    expect((failingStdin as unknown as { rawCalls: boolean[] }).rawCalls).toEqual([true, false]);
  });

  test("surrogate pairs count as one backspace unit", async () => {
    const drafts: string[] = [];
    const result = await firstInput({
      keys: keysOf("a", "😀", "\x7f", "\r"),
      onDraft: (d) => drafts.push(d),
    });
    expect(result).toEqual({ kind: "submit", text: "a", mode: "queue" });
    expect(drafts).toEqual(["a", "a😀", "a", ""]);
  });

  test("arrow-key escape sequences do not inject bytes into the draft", async () => {
    // Up arrow sends Esc [ A in raw mode — must be ignored.
    const result = await firstInput({ keys: keysOf("a", "\x1b[A", "b", "\r"), onDraft: () => {} });
    expect(result).toEqual({ kind: "submit", text: "ab", mode: "queue" });
  });

  test("runInputLoop stays in raw mode across submits and exits on interrupt", async () => {
    const drafts: string[] = [];
    const submits: Array<{ text: string; mode: string }> = [];
    let interrupted = false;
    await runInputLoop({
      keys: keysOf("a", "\r", "b", "\x1b\r", "\x03"),
      onDraft: (d) => drafts.push(d),
      onSubmit: (text, mode) => {
        submits.push({ text, mode });
      },
      onInterrupt: () => {
        interrupted = true;
      },
    });
    expect(submits).toEqual([
      { text: "a", mode: "queue" },
      { text: "b", mode: "steer" },
    ]);
    expect(interrupted).toBe(true);
    // Draft cleared after each submit.
    expect(drafts).toEqual(["a", "", "b", ""]);
  });

  test("runInputLoop refuses non-TTY when no synthetic source is given", async () => {
    await expect(
      runInputLoop({
        stdin: fakeStdin([], false),
        stdout: fakeStdout(true),
        onDraft: () => {},
        onSubmit: () => {},
        onInterrupt: () => {},
      }),
    ).rejects.toBeInstanceOf(NotTTYError);
  });

  test("runInputLoop restores raw mode even when onSubmit throws", async () => {
    const stdin = fakeStdin(["a", "\r", "\x03"], true);
    let calls = 0;
    await runInputLoop({
      stdin,
      stdout: fakeStdout(true),
      onDraft: () => {},
      onSubmit: () => {
        calls++;
        if (calls === 1) throw new Error("handler failed");
      },
      onInterrupt: () => {},
    });
    // Raw mode still restored after handler throw and interrupt.
    expect(stdin.rawCalls).toEqual([true, false]);
  });
});

// Observe the first result through the same loop the terminal uses.
async function firstInput(opts: InputOptions): Promise<InputResult> {
  let result: InputResult = { kind: "interrupt" };
  let submitted = false;
  await runInputLoop({
    ...opts,
    onSubmit: (text, mode) => {
      if (!submitted) {
        result = { kind: "submit", text, mode };
        submitted = true;
      }
    },
    onInterrupt: () => {},
  });
  return result;
}

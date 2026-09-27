import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  lucidPiExtension,
  materializePiExtension,
  type PiExtensionApi,
  type PiHelperChild,
  type PiHelperSpawn,
  type PiHelperTimers,
  piExtensionSource,
} from "../../src/harness/pi-extension.js";

// The extension runs from the file Lucid writes, not from the module: these
// tests import that file, so they prove the serialized text is self-contained.
let extension: (pi: PiExtensionApi) => void;
const root = mkdtempSync(join(tmpdir(), "lucid-pi-ext-"));
beforeAll(async () => {
  const path = materializePiExtension(root);
  extension = (await import(pathToFileURL(path).href)).default;
});
afterEach(() => {
  process.exitCode = 0;
});

const SESSION = "01a0e08c-06b0-71d0-8bfd-8304dfbd84b3";
const ATTEMPT = "5f0c7a3e-1b2d-4c8e-9f10-2a3b4c5d6e7f";
const NONCE = "a".repeat(64);

type Handler = (event: unknown, ctx: unknown) => unknown;
const load = (env: Record<string, string>) => {
  Object.assign(process.env, env);
  const handlers = new Map<string, Handler>();
  extension({ on: (event: string, handler: Handler) => handlers.set(event, handler) } as never);
  return handlers;
};
const context = (opts: {
  mode?: string;
  id?: string;
  headerId?: string;
  cwd: string;
  headerCwd?: string;
  entries?: readonly { type: string }[];
}) => ({
  cwd: opts.cwd,
  mode: opts.mode ?? "json",
  sessionManager: {
    getSessionId: () => opts.id ?? SESSION,
    getHeader: () => ({ id: opts.headerId ?? opts.id ?? SESSION, cwd: opts.headerCwd ?? opts.cwd }),
    getEntries: () => opts.entries ?? [{ type: "model_change" }, { type: "message" }],
  },
});
const headless = (folder: string) => {
  const attestation = join(mkdtempSync(join(tmpdir(), "lucid-pi-att-")), `${ATTEMPT}.json`);
  const handlers = load({
    LUCID_PI_ATTEMPT: `${ATTEMPT}.${NONCE}`,
    LUCID_PI_EXPECTED_SESSION: SESSION,
    LUCID_PI_EXPECTED_CWD: folder,
    LUCID_PI_ATTESTATION: attestation,
  });
  const read = () => JSON.parse(readFileSync(attestation, "utf8"));
  return { handlers, attestation, read };
};

test("the written file is reused when its text is unchanged and replaced when it differs", () => {
  const first = materializePiExtension(root);
  expect(materializePiExtension(root)).toBe(first);
  writeFileSync(first, "tampered");
  expect(materializePiExtension(root)).toBe(first);
  expect(readFileSync(first, "utf8")).toBe(piExtensionSource());
});

test("the extension removes its variables before any tool can read them", () => {
  const folder = mkdtempSync(join(tmpdir(), "lucid-pi-cwd-"));
  headless(folder);
  for (const name of [
    "LUCID_PI_ATTEMPT",
    "LUCID_PI_EXPECTED_SESSION",
    "LUCID_PI_EXPECTED_CWD",
    "LUCID_PI_ATTESTATION",
  ])
    expect(process.env[name]).toBeUndefined();
});

test("the expected session and folder with messages is verified and the prompt continues", () => {
  const folder = mkdtempSync(join(tmpdir(), "lucid-pi-cwd-"));
  const { handlers, read } = headless(folder);
  handlers.get("session_start")?.({}, context({ cwd: folder }));
  expect(read()).toEqual({
    v: 1,
    attempt: ATTEMPT,
    nonce: NONCE,
    outcome: "verified",
    expected: SESSION,
    opened: SESSION,
  });
  expect(handlers.get("input")?.({}, {})).toEqual({ action: "continue" });
  expect(process.exitCode).toBe(0);
});

test.each([
  ["session-id-mismatch", { id: "01a0e08c-0000-7000-8000-000000000000" }],
  ["session-id-mismatch", { headerId: "01a0e08c-0000-7000-8000-000000000000" }],
  ["folder-mismatch", { cwd: "/elsewhere" }],
  ["folder-mismatch", { headerCwd: "/elsewhere" }],
  ["session-empty", { entries: [{ type: "model_change" }, { type: "thinking_level_change" }] }],
])("a %s refuses, writes the reason, exits 3, and drops the prompt", (reason, opts) => {
  const folder = mkdtempSync(join(tmpdir(), "lucid-pi-cwd-"));
  const { handlers, read } = headless(folder);
  handlers.get("session_start")?.({}, context({ cwd: folder, ...opts }));
  expect(read()).toMatchObject({ outcome: "refused", reason, attempt: ATTEMPT, nonce: NONCE });
  expect(handlers.get("input")?.({}, {})).toEqual({ action: "handled" });
  expect(process.exitCode).toBe(3);
});

test("a folder reached through a symlink matches by real path", () => {
  const real = realpathSync(mkdtempSync(join(tmpdir(), "lucid-pi-real-")));
  const link = join(mkdtempSync(join(tmpdir(), "lucid-pi-link-")), "work");
  symlinkSync(real, link);
  const { handlers, read } = headless(link);
  handlers.get("session_start")?.({}, context({ cwd: real }));
  expect(read().outcome).toBe("verified");
});

test("a throwing session manager refuses as verification-failed", () => {
  const folder = mkdtempSync(join(tmpdir(), "lucid-pi-cwd-"));
  const { handlers, read } = headless(folder);
  const broken = {
    ...context({ cwd: folder }),
    sessionManager: {
      getSessionId: () => {
        throw new Error("boom");
      },
    },
  };
  handlers.get("session_start")?.({}, broken);
  expect(read()).toMatchObject({ outcome: "refused", reason: "verification-failed" });
  expect(handlers.get("input")?.({}, {})).toEqual({ action: "handled" });
});

test("the prompt is dropped when session_start never ran", () => {
  const folder = mkdtempSync(join(tmpdir(), "lucid-pi-cwd-"));
  const { handlers } = headless(folder);
  expect(handlers.get("input")?.({}, {})).toEqual({ action: "handled" });
});

test("an existing attestation file is never overwritten, and the prompt is dropped", () => {
  const folder = mkdtempSync(join(tmpdir(), "lucid-pi-cwd-"));
  const { handlers, attestation } = headless(folder);
  writeFileSync(attestation, "earlier");
  handlers.get("session_start")?.({}, context({ cwd: folder }));
  expect(readFileSync(attestation, "utf8")).toBe("earlier");
  expect(handlers.get("input")?.({}, {})).toEqual({ action: "handled" });
  expect(process.exitCode).toBe(3);
});

test("an unparsable attempt writes no file and drops the prompt", () => {
  const folder = mkdtempSync(join(tmpdir(), "lucid-pi-cwd-"));
  const dir = mkdtempSync(join(tmpdir(), "lucid-pi-att-"));
  const handlers = load({
    LUCID_PI_ATTEMPT: "not-an-attempt",
    LUCID_PI_EXPECTED_SESSION: SESSION,
    LUCID_PI_EXPECTED_CWD: folder,
    LUCID_PI_ATTESTATION: join(dir, "x.json"),
  });
  handlers.get("session_start")?.({}, context({ cwd: folder }));
  expect(() => readFileSync(join(dir, "x.json"))).toThrow();
  expect(handlers.get("input")?.({}, {})).toEqual({ action: "handled" });
  expect(process.exitCode).toBe(3);
});

test("rpc and tui runs take no headless role, even with the variables set", () => {
  const folder = mkdtempSync(join(tmpdir(), "lucid-pi-cwd-"));
  for (const mode of ["rpc", "tui"]) {
    const { handlers, attestation } = headless(folder);
    handlers.get("session_start")?.({}, context({ cwd: folder, mode }));
    expect(() => readFileSync(attestation)).toThrow();
    expect(handlers.get("input")?.({}, {})).toBeUndefined();
    expect(process.exitCode).toBe(0);
  }
});

test("without LUCID_PI_ATTEMPT the extension registers nothing", () => {
  expect(load({}).size).toBe(0);
});

// ---- Interactive role (RFC 28 steps 1-3): the tui handlers and the helper seam. ----

const LUCID = { command: ["/usr/local/bin/lucid", "--quiet"], root: "/lucid/records" };

/** A fake child_process: one spawn records its argv and stdin, then replies from `output`. */
const helperSpawn = () => {
  const spawns: { args: string[]; stdin: string }[] = [];
  const api = {
    killed: 0,
    output: null as string | null,
    spawns,
    spawn: ((command: string, args: readonly string[]) => {
      const record = { args: [command, ...args], stdin: "" };
      spawns.push(record);
      const data: ((chunk: unknown) => void)[] = [];
      const closing: (() => void)[] = [];
      const child: PiHelperChild = {
        kill: () => {
          api.killed += 1;
        },
        on: (event: "close" | "error", listener: () => void) => {
          if (event === "close") closing.push(listener);
        },
        stdin: {
          end: (payload?: string) => {
            record.stdin = payload ?? "";
          },
          on: () => {},
        },
        stdout: { on: (_event: "data", listener: (chunk: unknown) => void) => data.push(listener) },
      };
      setTimeout(() => {
        if (api.output !== null) for (const listener of data) listener(Buffer.from(api.output));
        for (const listener of closing) listener();
      }, 0);
      return child;
    }) satisfies PiHelperSpawn,
  };
  return api;
};

const loadInteractive = (spawn: PiHelperSpawn, lucid = LUCID, timers?: PiHelperTimers) => {
  const handlers = new Map<string, Handler>();
  lucidPiExtension(
    { on: (event: string, handler: Handler) => handlers.set(event, handler) } as never,
    lucid,
    spawn,
    timers,
  );
  return handlers;
};
const tuiContext = (cwd = "/work") => ({
  cwd,
  mode: "tui",
  sessionManager: {
    getEntries: () => [{ type: "message" }],
    getHeader: () => ({ id: SESSION }),
    getSessionFile: () => "/work/session.jsonl",
    getSessionId: () => SESSION,
  },
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const bashResult = (text: string) => ({
  content: [{ type: "text", text }],
  toolCallId: "call-1",
  toolName: "bash",
});

/** A spawn seam the test drives by hand: each child's events fire only when told. */
const manualSpawn = () => {
  interface ManualChild {
    readonly emitClose: () => void;
    readonly emitData: (chunk: unknown) => void;
    readonly emitError: () => void;
    readonly kills: readonly string[];
  }
  const children: ManualChild[] = [];
  const spawn: PiHelperSpawn = () => {
    const kills: string[] = [];
    const closing: (() => void)[] = [];
    const data: ((chunk: unknown) => void)[] = [];
    const errors: (() => void)[] = [];
    children.push({
      emitClose: () => {
        for (const listener of closing) listener();
      },
      emitData: (chunk: unknown) => {
        for (const listener of data) listener(chunk);
      },
      emitError: () => {
        for (const listener of errors) listener();
      },
      kills,
    });
    return {
      kill: (signal?: string) => {
        kills.push(signal ?? "");
      },
      on: (event: "close" | "error", listener: () => void) => {
        (event === "close" ? closing : errors).push(listener);
      },
      stdin: {
        end: () => {},
        on: () => {},
      },
      stdout: { on: (_event: "data", listener: (chunk: unknown) => void) => data.push(listener) },
    } satisfies PiHelperChild;
  };
  return { children, spawn };
};

/** A manual clock for the helper timeout: advancing it fires what elapsed. */
const manualTimers = () => {
  let now = 0;
  let sequence = 0;
  const pending = new Map<number, { at: number; handler: () => void }>();
  const timers: PiHelperTimers = {
    clearTimeout: (handle: unknown) => {
      pending.delete(handle as number);
    },
    setTimeout: (handler: () => void, ms: number) => {
      sequence += 1;
      pending.set(sequence, { at: now + ms, handler });
      return sequence;
    },
  };
  return {
    advance: (ms: number) => {
      now += ms;
      for (const [handle, entry] of [...pending.entries()])
        if (entry.at <= now) {
          pending.delete(handle);
          entry.handler();
        }
    },
    timers,
  };
};

describe("interactive role", () => {
  test("session_start runs the session-start helper with the capture on stdin", async () => {
    const helper = helperSpawn();
    const handlers = loadInteractive(helper.spawn);
    await handlers.get("session_start")?.({}, tuiContext());
    await settle();
    expect(helper.spawns).toHaveLength(1);
    expect(helper.spawns[0]?.args).toEqual([
      "/usr/local/bin/lucid",
      "--quiet",
      "_pi-hook",
      "session-start",
      "--root",
      "/lucid/records",
    ]);
    expect(JSON.parse(helper.spawns[0]?.stdin ?? "{}")).toEqual({
      event: "session-start",
      execPath: process.execPath,
      mode: "tui",
      nativeSessionId: SESSION,
      pid: process.pid,
      sessionFile: "/work/session.jsonl",
      v: 1,
      workingDirectory: "/work",
    });
  });

  test("session_shutdown runs the session-shutdown helper", async () => {
    const helper = helperSpawn();
    const handlers = loadInteractive(helper.spawn);
    await handlers.get("session_start")?.({}, tuiContext());
    await handlers.get("session_shutdown")?.({}, tuiContext());
    await settle();
    expect(helper.spawns.map((spawn) => spawn.args[3])).toEqual([
      "session-start",
      "session-shutdown",
    ]);
  });

  test("a bash tool result with one marker appends the helper's committed text", async () => {
    const helper = helperSpawn();
    helper.output = JSON.stringify({ kind: "committed", text: "Lucid results:\nok", v: 1 });
    const handlers = loadInteractive(helper.spawn);
    await handlers.get("session_start")?.({}, tuiContext());
    const result = await handlers.get("tool_result")?.(
      bashResult(`published\nlucid-pi-proposal:${"a".repeat(36)}`),
      tuiContext(),
    );
    expect(result).toEqual({
      content: [
        { type: "text", text: `published\nlucid-pi-proposal:${"a".repeat(36)}` },
        { type: "text", text: "Lucid results:\nok" },
      ],
    });
    const capture = JSON.parse(helper.spawns[1]?.stdin ?? "{}");
    expect(capture).toMatchObject({
      event: "tool-result",
      markers: [`lucid-pi-proposal:${"a".repeat(36)}`],
      toolCallId: "call-1",
    });
  });

  test("a marker inside a --json output line is found and committed", async () => {
    const helper = helperSpawn();
    helper.output = JSON.stringify({ kind: "committed", text: "Lucid results:\nok", v: 1 });
    const handlers = loadInteractive(helper.spawn);
    await handlers.get("session_start")?.({}, tuiContext());
    const uuid = "5f0c7a3e-1b2d-4c8e-9f10-2a3b4c5d6e7f";
    const result = await handlers.get("tool_result")?.(
      bashResult(`{"v":1,"proposal":"lucid-pi-proposal:${uuid}","ok":true}`),
      tuiContext(),
    );
    expect((result as { content: { text: string }[] }).content[1]?.text).toBe("Lucid results:\nok");
    const capture = JSON.parse(helper.spawns[1]?.stdin ?? "{}");
    expect(capture).toMatchObject({
      event: "tool-result",
      markers: [`lucid-pi-proposal:${uuid}`],
      toolCallId: "call-1",
    });
  });

  test("the same token twice in one result, in JSON and on its own line, is passed once", async () => {
    const helper = helperSpawn();
    helper.output = JSON.stringify({ kind: "committed", text: "Lucid results:\nok", v: 1 });
    const handlers = loadInteractive(helper.spawn);
    await handlers.get("session_start")?.({}, tuiContext());
    const token = `lucid-pi-proposal:${"b".repeat(36)}`;
    await handlers.get("tool_result")?.(
      bashResult(`{"proposal":"${token}"}\n${token}`),
      tuiContext(),
    );
    const capture = JSON.parse(helper.spawns[1]?.stdin ?? "{}");
    expect(capture).toMatchObject({ event: "tool-result", markers: [token] });
  });

  test("a helper refusal appends the refusal message", async () => {
    const helper = helperSpawn();
    helper.output = JSON.stringify({
      kind: "refused",
      message: "The Pi hook capture is invalid.",
      reason: "invalid-capture",
      v: 1,
    });
    const handlers = loadInteractive(helper.spawn);
    await handlers.get("session_start")?.({}, tuiContext());
    const result = await handlers.get("tool_result")?.(
      bashResult(`lucid-pi-proposal:${"a".repeat(36)}`),
      tuiContext(),
    );
    expect((result as { content: { text: string }[] }).content[1]?.text).toBe(
      "Lucid refused: The Pi hook capture is invalid.",
    );
  });

  test("a helper that prints nothing leaves the proposals unconfirmed", async () => {
    const helper = helperSpawn();
    const handlers = loadInteractive(helper.spawn);
    await handlers.get("session_start")?.({}, tuiContext());
    const result = await handlers.get("tool_result")?.(
      bashResult(`lucid-pi-proposal:${"a".repeat(36)}`),
      tuiContext(),
    );
    expect((result as { content: { text: string }[] }).content[1]?.text).toBe(
      "Lucid could not confirm these proposals. They are not retried.",
    );
  });

  test("a helper that never exits is killed with SIGKILL after 15 s", async () => {
    const manual = manualSpawn();
    const clock = manualTimers();
    const handlers = loadInteractive(manual.spawn, LUCID, clock.timers);
    const starting = handlers.get("session_start")?.({}, tuiContext());
    clock.advance(15_000);
    await starting;
    const pending = handlers.get("tool_result")?.(
      bashResult(`lucid-pi-proposal:${"a".repeat(36)}`),
      tuiContext(),
    );
    clock.advance(15_000);
    const result = await pending;
    expect(manual.children[1]?.kills).toEqual(["SIGKILL"]);
    expect((result as { content: { text: string }[] }).content[1]?.text).toBe(
      "Lucid could not confirm these proposals. They are not retried.",
    );
  });

  test("stdout past the 49152-byte bound kills the child and leaves the proposals unconfirmed", async () => {
    const manual = manualSpawn();
    const handlers = loadInteractive(manual.spawn);
    const starting = handlers.get("session_start")?.({}, tuiContext());
    manual.children[0]?.emitClose();
    await starting;
    const pending = handlers.get("tool_result")?.(
      bashResult(`lucid-pi-proposal:${"a".repeat(36)}`),
      tuiContext(),
    );
    manual.children[1]?.emitData(Buffer.alloc(30_000, 0x7b));
    manual.children[1]?.emitData(Buffer.alloc(20_000, 0x7d));
    const result = await pending;
    expect(manual.children[1]?.kills).toEqual(["SIGKILL"]);
    expect((result as { content: { text: string }[] }).content[1]?.text).toBe(
      "Lucid could not confirm these proposals. They are not retried.",
    );
  });

  test("a spawn that throws leaves the proposals unconfirmed", async () => {
    const manual = manualSpawn();
    let calls = 0;
    const spawn: PiHelperSpawn = (command, args, options) => {
      calls += 1;
      if (calls > 1) throw new Error("spawn refused");
      return manual.spawn(command, args, options);
    };
    const handlers = loadInteractive(spawn);
    const starting = handlers.get("session_start")?.({}, tuiContext());
    manual.children[0]?.emitClose();
    await starting;
    const result = await handlers.get("tool_result")?.(
      bashResult(`lucid-pi-proposal:${"a".repeat(36)}`),
      tuiContext(),
    );
    expect((result as { content: { text: string }[] }).content[1]?.text).toBe(
      "Lucid could not confirm these proposals. They are not retried.",
    );
  });

  test("a child error event leaves the proposals unconfirmed", async () => {
    const manual = manualSpawn();
    const handlers = loadInteractive(manual.spawn);
    const starting = handlers.get("session_start")?.({}, tuiContext());
    manual.children[0]?.emitClose();
    await starting;
    const pending = handlers.get("tool_result")?.(
      bashResult(`lucid-pi-proposal:${"a".repeat(36)}`),
      tuiContext(),
    );
    manual.children[1]?.emitError();
    const result = await pending;
    expect((result as { content: { text: string }[] }).content[1]?.text).toBe(
      "Lucid could not confirm these proposals. They are not retried.",
    );
  });

  test("a bash tool result without a marker returns undefined and starts nothing", async () => {
    const helper = helperSpawn();
    const handlers = loadInteractive(helper.spawn);
    await handlers.get("session_start")?.({}, tuiContext());
    expect(
      await handlers.get("tool_result")?.(bashResult("ordinary output"), tuiContext()),
    ).toBeUndefined();
    expect(helper.spawns).toHaveLength(1);
  });

  test("seventeen distinct tokens on one line refuse the batch without starting a helper", async () => {
    const helper = helperSpawn();
    const handlers = loadInteractive(helper.spawn);
    await handlers.get("session_start")?.({}, tuiContext());
    const seventeen = Array.from(
      { length: 17 },
      (_, i) => `lucid-pi-proposal:${i.toString(16).padStart(36, "0")}`,
    );
    const result = await handlers.get("tool_result")?.(
      bashResult(seventeen.join(" ")),
      tuiContext(),
    );
    expect((result as { content: unknown[] }).content).toHaveLength(2);
    expect((result as { content: { text: string }[] }).content[1]?.text).toBe(
      "Lucid: more than 16 proposals in one command; none was recorded.",
    );
    expect(helper.spawns).toHaveLength(1);
  });

  test("a non-bash tool result returns undefined", async () => {
    const helper = helperSpawn();
    const handlers = loadInteractive(helper.spawn);
    await handlers.get("session_start")?.({}, tuiContext());
    expect(
      await handlers.get("tool_result")?.(
        bashResult(`lucid-pi-proposal:${"a".repeat(36)}`),
        tuiContext(),
      ),
    ).toBeDefined();
    const read = await loadInteractive(helper.spawn).get("tool_result")?.(
      { ...bashResult(`lucid-pi-proposal:${"a".repeat(36)}`), toolName: "read" },
      tuiContext(),
    );
    expect(read).toBeUndefined();
  });

  test("input in the interactive role never gates the prompt", async () => {
    const helper = helperSpawn();
    const handlers = loadInteractive(helper.spawn);
    await handlers.get("session_start")?.({}, tuiContext());
    expect(handlers.get("input")?.({}, {})).toBeUndefined();
  });
});

describe("piExtensionSource with a lucid command", () => {
  test("embeds the command and root and still exports a default function", () => {
    const source = piExtensionSource(LUCID);
    expect(source).toContain(`const LUCID = ${JSON.stringify(LUCID)};`);
    expect(source).toContain(`const extension = ${lucidPiExtension.toString()};`);
    expect(source).toContain("export default function (pi) { return extension(pi, LUCID); }");
  });

  test("without lucid the source is the headless template, byte for byte", () => {
    expect(piExtensionSource()).toBe(
      `// Lucid Pi extension (RFC 28). Written by Lucid; do not edit.\nexport default ${lucidPiExtension.toString()};\n`,
    );
  });

  test("materializePiExtension hashes the command and root into the file name", () => {
    const plain = materializePiExtension(root);
    const wired = materializePiExtension(root, LUCID);
    expect(wired).not.toBe(plain);
    expect(readFileSync(wired, "utf8")).toContain(`const LUCID = ${JSON.stringify(LUCID)};`);
    expect(materializePiExtension(root, { ...LUCID, root: "/other/records" })).not.toBe(wired);
  });
});

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLogSink,
  hubLogPath,
  inboundTrace,
  sinkStatus,
  observeRequests,
  resolveHubSink,
  startRequest,
} from "../src/server/observe.ts";
import { NotFoundError, ValidationError } from "../src/errors.ts";

/**
 * The wide-event boundary (plan 07, M1.1). One record per request, built as
 * the request flows and emitted once; identifiers and outcomes only, never
 * review content (D-005).
 */

/** A sink that remembers every line, so tests assert on what was EMITTED,
 *  not on builder internals. */
const capture = () => {
  const lines: string[] = [];
  return { lines, sink: (line: string) => void lines.push(line) };
};

describe("startRequest: the record and its lifecycle", () => {
  test("a completed request emits one record with method, path, status, duration and id", () => {
    const { lines, sink } = capture();
    let t = 1000;
    const req = startRequest(
      { method: "GET", path: "/hub/sessions", id: "abc123def456" },
      { sink, clock: () => (t += 250) },
    );
    req.end(200);

    const exits = lines.map((l) => JSON.parse(l)).filter((r) => r.event === "request");
    expect(exits).toHaveLength(1);
    const record = exits[0];
    expect(record.method).toBe("GET");
    expect(record.path).toBe("/hub/sessions");
    expect(record.status).toBe(200);
    expect(record.id).toBe("abc123def456");
    expect(record.durationMs).toBe(250);
  });

  test("two attach calls merge rather than replace", () => {
    const { lines, sink } = capture();
    const req = startRequest(
      { method: "POST", path: "/hub/create", id: "id1" },
      { sink, clock: () => 0 },
    );
    req.attach({ artifact: "/proj/.lucid/plan.html", project: "/proj" });
    req.attach({ harness: "claude" });
    req.end(200);

    const [record] = lines.map((l) => JSON.parse(l)).filter((r) => r.event === "request");
    expect(record.artifact).toBe("/proj/.lucid/plan.html");
    expect(record.project).toBe("/proj");
    expect(record.harness).toBe("claude");
  });

  test("fail(err) lifts error.type and error.code off a typed error", () => {
    const { lines, sink } = capture();
    const req = startRequest(
      { method: "POST", path: "/hub/create", id: "id2" },
      { sink, clock: () => 0 },
    );
    req.fail(new NotFoundError({ message: "no such artifact" }));
    req.end(404);

    const [record] = lines.map((l) => JSON.parse(l)).filter((r) => r.event === "request");
    expect(record.error).toEqual({ type: "NotFoundError", code: "NOT_FOUND" });
  });

  test("entry and exit are distinguishable: a request that never completes leaves an entry with no exit", () => {
    const { lines, sink } = capture();
    startRequest({ method: "POST", path: "/hub/create", id: "hang1" }, { sink, clock: () => 0 });
    // No end() - the request hung. The entry record is the only evidence.

    const records = lines.map((l) => JSON.parse(l));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: "request.start",
      id: "hang1",
      method: "POST",
      path: "/hub/create",
    });
    expect(records.filter((r) => r.event === "request")).toHaveLength(0);
  });

  test("end called twice emits exactly once - a double emit double-counts every request", () => {
    const { lines, sink } = capture();
    const req = startRequest(
      { method: "GET", path: "/hub/sessions", id: "id3" },
      { sink, clock: () => 0 },
    );
    req.end(200);
    req.end(500);

    const exits = lines.map((l) => JSON.parse(l)).filter((r) => r.event === "request");
    expect(exits).toHaveLength(1);
    expect(exits[0].status).toBe(200);
  });

  test("the record carries no body: prompts, notes and artifact HTML have nowhere to land", () => {
    const PROMPT = "SENTINEL_PROMPT_do_the_thing";
    const NOTE = "SENTINEL_NOTE_this_heading_is_wrong";
    const HTML = "<h1>SENTINEL_HTML_artifact_body</h1>";
    const { lines, sink } = capture();
    const req = startRequest(
      { method: "POST", path: "/hub/create", id: "id4" },
      { sink, clock: () => 0 },
    );
    // A careless caller hands over content alongside the identifiers. The
    // cast models a JS call site TS cannot police - the RUNTIME must drop it.
    req.attach({
      artifact: "/proj/.lucid/plan.html",
      prompt: PROMPT,
      note: NOTE,
      html: HTML,
    } as never);
    // And a typed error whose message/detail carry the review's content.
    req.fail(
      new ValidationError({ message: `refused: ${NOTE}`, detail: { prompt: PROMPT, body: HTML } }),
    );
    req.end(400);

    const serialised = lines.join("\n");
    expect(serialised).not.toContain(PROMPT);
    expect(serialised).not.toContain(NOTE);
    expect(serialised).not.toContain("SENTINEL_HTML_artifact_body");
    expect(serialised).toContain("/proj/.lucid/plan.html");
    expect(serialised).toContain("VALIDATION_ERROR");
  });
});

describe("observeRequests: the funnel wrapper the daemon's fetch uses (M1.2)", () => {
  const req = (path: string, method = "GET") =>
    new Request(`http://127.0.0.1:9/${path.replace(/^\//, "")}`, { method });

  test("a handled request emits entry then exit with the handler's status, one id joining them", async () => {
    const { lines, sink } = capture();
    const observed = observeRequests({ sink }, async () => new Response("ok", { status: 201 }));
    const res = await observed(req("/hub/sessions", "POST"));

    expect(res.status).toBe(201);
    const records = lines.map((l) => JSON.parse(l));
    expect(records.map((r) => r.event)).toEqual(["request.start", "request"]);
    expect(records[1].status).toBe(201);
    expect(records[1].path).toBe("/hub/sessions");
    expect(records[1].method).toBe("POST");
    expect(records[0].id).toBe(records[1].id);
    expect(records[0].id).toMatch(/^[a-f0-9]{16}$/);
  });

  test("a handler that throws a typed error still emits - with error.type and error.code", async () => {
    const { lines, sink } = capture();
    const observed = observeRequests({ sink }, async () => {
      throw new ValidationError({ message: "bad artifact" });
    });
    await expect(observed(req("/hub/open", "POST"))).rejects.toThrow("bad artifact");

    const exit = lines.map((l) => JSON.parse(l)).find((r) => r.event === "request");
    expect(exit.status).toBe(500);
    expect(exit.error).toEqual({ type: "ValidationError", code: "VALIDATION_ERROR" });
  });

  test("an UNTYPED throw still leaves an identity: error.name, code UNKNOWN, message dropped", async () => {
    const { lines, sink } = capture();
    const observed = observeRequests({ sink }, async () => {
      throw new TypeError("cannot read SENTINEL_SECRET of undefined");
    });
    await expect(observed(req("/hub/sessions"))).rejects.toThrow();

    const exit = lines.map((l) => JSON.parse(l)).find((r) => r.event === "request");
    expect(exit.status).toBe(500);
    expect(exit.error).toEqual({ type: "TypeError", code: "UNKNOWN" });
    expect(lines.join("\n")).not.toContain("SENTINEL_SECRET");
  });

  test("the PATH is capped too - a 16k request target must not eat the rotation budget (R2)", async () => {
    const { lines, sink } = capture();
    const observed = observeRequests({ sink }, async () => new Response("ok"));
    await observed(req(`/hub/${"x".repeat(16_000)}`));

    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(1024);
    }
  });

  test("attached identifiers are capped: a megabyte name cannot rotate real evidence away", async () => {
    const { lines, sink } = capture();
    const observed = observeRequests({ sink }, async (_req, observation) => {
      observation.attach({ artifact: "x".repeat(100_000), project: "/proj" });
      return new Response("ok");
    });
    await observed(req("/hub/create", "POST"));

    const exit = lines.map((l) => JSON.parse(l)).find((r) => r.event === "request");
    expect((exit.artifact as string).length).toBeLessThanOrEqual(256);
    expect(exit.project).toBe("/proj");
  });

  test("an inbound x-lucid-request becomes the TRACE; the id stays the record's own (D-011)", async () => {
    const { lines, sink } = capture();
    const observed = observeRequests({ sink }, async () => new Response("ok"));
    await observed(
      new Request("http://127.0.0.1:9/hub/open", {
        method: "POST",
        headers: { "x-lucid-request": "feedc0ffee123456" },
      }),
    );

    const exit = lines.map((l) => JSON.parse(l)).find((r) => r.event === "request");
    expect(exit.trace).toBe("feedc0ffee123456");
    expect(exit.id).toMatch(/^[a-f0-9]{16}$/);
    expect(exit.id).not.toBe("feedc0ffee123456");
  });

  test("two requests sharing a trace keep DISTINCT ids - the hang signal survives the join (D-011)", async () => {
    const { lines, sink } = capture();
    const observed = observeRequests({ sink }, async () => new Response("ok"));
    const withTrace = () =>
      new Request("http://127.0.0.1:9/hub/open", {
        method: "POST",
        headers: { "x-lucid-request": "feedc0ffee123456" },
      });
    await observed(withTrace());
    await observed(withTrace());

    const exits = lines.map((l) => JSON.parse(l)).filter((r) => r.event === "request");
    expect(exits).toHaveLength(2);
    expect(exits[0].trace).toBe("feedc0ffee123456");
    expect(exits[1].trace).toBe("feedc0ffee123456");
    expect(exits[0].id).not.toBe(exits[1].id);
    // And each entry pairs its exit by id, 1:1.
    const entries = lines.map((l) => JSON.parse(l)).filter((r) => r.event === "request.start");
    expect(entries.map((r) => r.id).sort()).toEqual(exits.map((r) => r.id).sort());
  });

  test("with no inbound trace, the trace IS the record's id - every record joins something", async () => {
    const { lines, sink } = capture();
    const observed = observeRequests({ sink }, async () => new Response("ok"));
    await observed(new Request("http://127.0.0.1:9/hub/sessions"));

    const exit = lines.map((l) => JSON.parse(l)).find((r) => r.event === "request");
    expect(exit.trace).toBe(exit.id);
  });

  test("the handler can attach route context, and it rides the exit record", async () => {
    const { lines, sink } = capture();
    const observed = observeRequests({ sink }, async (_req, observation) => {
      observation.attach({ session: "abc123" });
      return new Response("ok");
    });
    await observed(req("/s/abc123/"));

    const exit = lines.map((l) => JSON.parse(l)).find((r) => r.event === "request");
    expect(exit.session).toBe("abc123");
  });
});

describe("inboundTrace: adopt a well-formed inbound trace, refuse anything else (M1.3)", () => {
  const headers = (value?: string) =>
    new Headers(value === undefined ? {} : { "x-lucid-request": value });

  test("a well-formed inbound trace is adopted", () => {
    expect(inboundTrace(headers("abc123def4567890"))).toBe("abc123def4567890");
  });

  test("a missing trace adopts nothing", () => {
    expect(inboundTrace(headers())).toBeUndefined();
  });

  test("a malformed trace is REFUSED outright - the log-injection guard (R4)", () => {
    for (const hostile of [
      "short",
      "ABC123DEF4567890", // case is part of well-formed
      "abc123def456789012345678", // arbitrary length
      'abc123","fake":"1', // a JSON-injection attempt (raw newlines never
      // get this far - the Headers layer itself rejects them)
      "../../etc/passwd",
    ]) {
      expect(inboundTrace(headers(hostile))).toBeUndefined();
    }
  });
});

describe("hubLogPath: explicit override, then env, then home (the registryFilePath contract)", () => {
  test("LUCID_HUB_LOG steers the default - the tier the e2e harness isolates by", () => {
    const prev = process.env.LUCID_HUB_LOG;
    process.env.LUCID_HUB_LOG = "/tmp/steered/hub.log";
    try {
      expect(hubLogPath()).toBe("/tmp/steered/hub.log");
      expect(hubLogPath("/explicit/hub.log")).toBe("/explicit/hub.log");
    } finally {
      if (prev === undefined) delete process.env.LUCID_HUB_LOG;
      else process.env.LUCID_HUB_LOG = prev;
    }
  });
});

describe("resolveHubSink: the rotating file is the hub's DEFAULT, not a second path (D-009)", () => {
  test("with no log supplied, a message lands in the rotating file AND on the mirror", () => {
    const dir = mkdtempSync(join(tmpdir(), "lucid-observe-"));
    const path = join(dir, "hub.log");
    const mirrored: string[] = [];
    try {
      const log = resolveHubSink({ hubLogPath: path, mirror: (m) => void mirrored.push(m) });
      log("attend plan: pausing attendance for 5 minutes");
      expect(readFileSync(path, "utf8")).toBe("attend plan: pausing attendance for 5 minutes\n");
      expect(mirrored).toEqual(["attend plan: pausing attendance for 5 minutes"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a supplied log keeps the (message: string) => void contract and wins over the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "lucid-observe-"));
    const path = join(dir, "hub.log");
    const seen: string[] = [];
    try {
      const log = resolveHubSink({ log: (m: string) => void seen.push(m), hubLogPath: path });
      log("injected");
      expect(seen).toEqual(["injected"]);
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sinkStatus: the logger is not self-concealing (M3.2, technique 1)", () => {
  test("reports the real path, size and generation - not a hardcoded guess", () => {
    const dir = mkdtempSync(join(tmpdir(), "lucid-observe-"));
    const path = join(dir, "hub.log");
    try {
      const before = sinkStatus(path);
      expect(before.path).toBe(path);
      expect(before.exists).toBe(false);
      expect(before.bytes).toBe(0);
      expect(before.rotated).toBe(false);

      const sink = createLogSink({ path, maxBytes: 100 });
      sink("a".repeat(60));
      const after = sinkStatus(path);
      expect(after.exists).toBe(true);
      expect(after.bytes).toBe(61);
      expect(after.rotated).toBe(false);

      sink("b".repeat(60));
      expect(sinkStatus(path).rotated).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("write health is derived from DISK, not from this process having tried", () => {
    // The status reader is `lucid status`, a DIFFERENT process from the hub
    // that owns the sink - so an in-process error map is always empty there
    // and `writable` was a hardcoded true. It reported a log whose every
    // write was failing as "healthy but idle", which is precisely the
    // self-concealing failure this field exists to expose.
    const dir = mkdtempSync(join(tmpdir(), "lucid-observe-"));
    const readonlyDir = join(dir, "ro");
    mkdirSync(readonlyDir);
    chmodSync(readonlyDir, 0o555);
    try {
      // Nothing in THIS process ever opened a sink here.
      const status = sinkStatus(join(readonlyDir, "hub.log"));
      expect(status.exists).toBe(false);
      expect(status.writable).toBe(false);
      expect(status.error).toBeTruthy();
    } finally {
      chmodSync(readonlyDir, 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a path whose parent does not exist yet is HEALTHY - the sink creates it (#91 re-review)", () => {
    // ~/.lucid does not exist until the first hub runs, so this is the
    // fresh-install case: the very first `lucid` a new user types. Probing
    // the immediate parent reported their log as broken while writes to it
    // in fact succeed - the lie flipped direction rather than going away.
    const dir = mkdtempSync(join(tmpdir(), "lucid-observe-"));
    const deep = join(dir, "never", "created", "hub.log");
    try {
      expect(sinkStatus(deep).writable).toBe(true);
      // And it is not wishful: the sink really does create the tree.
      createLogSink({ path: deep })('{"event":"proof"}');
      const after = sinkStatus(deep);
      expect(after.exists).toBe(true);
      expect(after.bytes).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a sink that CANNOT write says so - a silent logger hides its own failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "lucid-observe-"));
    const path = join(dir, "nope", "hub.log");
    try {
      // A directory that cannot be created: the parent is a FILE.
      writeFileSync(join(dir, "nope"), "not a directory");
      const sink = createLogSink({ path });
      sink("this cannot land");
      const status = sinkStatus(path);
      expect(status.exists).toBe(false);
      expect(status.writable).toBe(false);
      expect(status.error).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a healthy sink reports writable with no error", () => {
    const dir = mkdtempSync(join(tmpdir(), "lucid-observe-"));
    const path = join(dir, "hub.log");
    try {
      createLogSink({ path })("fine");
      const status = sinkStatus(path);
      expect(status.writable).toBe(true);
      expect(status.error).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createLogSink: the file that survives detaching (D-002)", () => {
  test("writes each line to the file, rotates at the cap, keeps exactly one previous generation", () => {
    const dir = mkdtempSync(join(tmpdir(), "lucid-observe-"));
    const path = join(dir, "hub.log");
    try {
      const sink = createLogSink({ path, maxBytes: 100 });
      sink("a".repeat(60)); // 61 bytes with newline
      expect(readFileSync(path, "utf8")).toBe(`${"a".repeat(60)}\n`);

      sink("b".repeat(60)); // would exceed 100 → rotate first
      expect(readFileSync(`${path}.1`, "utf8")).toBe(`${"a".repeat(60)}\n`);
      expect(readFileSync(path, "utf8")).toBe(`${"b".repeat(60)}\n`);

      sink("c".repeat(60)); // rotate again → the a-generation is GONE
      expect(readFileSync(`${path}.1`, "utf8")).toBe(`${"b".repeat(60)}\n`);
      expect(readFileSync(path, "utf8")).toBe(`${"c".repeat(60)}\n`);
      expect(existsSync(`${path}.2`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

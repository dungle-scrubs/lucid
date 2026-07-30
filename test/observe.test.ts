import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogSink, hubLogPath, resolveHubSink, startRequest } from "../src/server/observe.ts";
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

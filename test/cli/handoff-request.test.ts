import { expect, test } from "bun:test";
import { parseHandoffRequest, withUnmanagedMarker } from "../../src/cli/handoff-request.js";
import { mapSubcommand } from "../../src/cli/mapping.js";

const base = () => ({
  artifact: {
    artifactId: "walkthrough",
    bytes: "<h1>Handoff</h1>",
    contentType: "text/html",
    version: 1,
  },
  continuation: { inputId: "continue-1", text: "Review this document." },
  creationId: "handoff-1",
  serverUrl: "http://127.0.0.1:17454",
  settings: { effort: "high", harness: "codex", model: "test-model", profile: "headless-turn" },
  workingDirectory: "/tmp",
});

test("a valid handoff request parses", () => {
  const parsed = parseHandoffRequest(base());
  expect(parsed.artifact.artifactId).toBe("walkthrough");
  expect(parsed.continuation.inputId).toBe("continue-1");
  expect(parsed.creationId).toBe("handoff-1");
});

test("creationId and conversationId together are refused", () => {
  expect(() => parseHandoffRequest({ ...base(), conversationId: "conv-1" })).toThrow(
    "either creationId or conversationId",
  );
});

test("neither creation identity is refused", () => {
  const request = base() as Record<string, unknown>;
  delete request.creationId;
  expect(() => parseHandoffRequest(request)).toThrow("creationId or an existing conversationId");
});

test("an oversize artifact is refused, never truncated", () => {
  expect(() =>
    parseHandoffRequest({
      ...base(),
      artifact: { ...base().artifact, bytes: "x".repeat(1_000_001) },
    }),
  ).toThrow("exceeds");
});

test("a multibyte artifact past the code-unit limit is refused", () => {
  const bytes = "<h1></h1>".padEnd(9, "x") + "界".repeat(999_992);
  expect(bytes.length).toBe(1_000_001);
  expect(() => parseHandoffRequest({ ...base(), artifact: { ...base().artifact, bytes } })).toThrow(
    "exceeds",
  );
});

test("a multibyte artifact under the code-unit limit is accepted", () => {
  // 400,000 copies of U+754C: 400,009 code units (under the limit) but
  // 1,200,009 UTF-8 bytes (over it). Acceptance proves the host compares
  // code units, not bytes.
  const bytes = "<h1></h1>".padEnd(9, "x") + "界".repeat(400_000);
  expect(bytes.length).toBe(400_009);
  expect(Buffer.byteLength(bytes, "utf8")).toBeGreaterThan(1_000_000);
  expect(() =>
    parseHandoffRequest({ ...base(), artifact: { ...base().artifact, bytes } }),
  ).not.toThrow();
});

test("an empty continuation is refused", () => {
  expect(() =>
    parseHandoffRequest({ ...base(), continuation: { inputId: "c-1", text: "" } }),
  ).toThrow("nonempty text");
});

test("an oversize continuation is refused", () => {
  expect(() =>
    parseHandoffRequest({
      ...base(),
      continuation: { inputId: "c-1", text: "y".repeat(1_000_001) },
    }),
  ).toThrow("exceeds");
});

test("a non-loopback serverUrl is refused", () => {
  expect(() => parseHandoffRequest({ ...base(), serverUrl: "https://example.com/" })).toThrow(
    "serverUrl",
  );
});

test("a relative working directory is refused", () => {
  expect(() => parseHandoffRequest({ ...base(), workingDirectory: "relative/path" })).toThrow(
    "absolute workingDirectory",
  );
});

test("handoff maps request and json flags", () => {
  expect(mapSubcommand(["handoff", "--request", "req.json"])).toEqual({
    allowUnmanaged: false,
    json: false,
    kind: "handoff",
    request: "req.json",
  });
  expect(mapSubcommand(["handoff", "--request", "req.json", "--json"])).toEqual({
    allowUnmanaged: false,
    json: true,
    kind: "handoff",
    request: "req.json",
  });
  expect(mapSubcommand(["handoff", "--request", "req.json", "--allow-unmanaged"])).toMatchObject({
    allowUnmanaged: true,
    kind: "handoff",
  });
  expect(mapSubcommand(["handoff"])).toMatchObject({ kind: "help" });
  expect(mapSubcommand(["handoff", "--request"])).toMatchObject({ kind: "help" });
});

test("a portless serverUrl is refused", () => {
  expect(() => parseHandoffRequest({ ...base(), serverUrl: "http://127.0.0.1/" })).toThrow(
    "serverUrl",
  );
});

test("an unknown request field is refused", () => {
  expect(() => parseHandoffRequest({ ...base(), nativeSessionId: "foreign-session" })).toThrow(
    "Unknown handoff request field",
  );
});

test("the unmanaged marker parses; invalid values are refused", () => {
  expect(parseHandoffRequest({ ...base(), theme: "unmanaged" }).theme).toBe("unmanaged");
  expect(parseHandoffRequest(base()).theme).toBeUndefined();
  for (const bad of [null, true, 0, [], {}, "UNMANAGED", "adaptive"]) {
    expect(() => parseHandoffRequest({ ...base(), theme: bad })).toThrow("theme field");
  }
  // The flag supplies the marker only when the field is absent.
  expect(withUnmanagedMarker({ ...base() }, true)).toMatchObject({ theme: "unmanaged" });
  expect(withUnmanagedMarker({ ...base() }, false)).not.toHaveProperty("theme");
  expect(withUnmanagedMarker({ ...base(), theme: "bogus" }, true)).toMatchObject({
    theme: "bogus",
  });
});

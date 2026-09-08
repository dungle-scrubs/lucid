import { expect, test } from "bun:test";
import { dispatch } from "../../src/cli/dispatch.js";
import type { ServeOpts } from "../../src/cli/serve.js";

test("serve without view options links to the hub and leaves visibility unspecified", async () => {
  let options: ServeOpts | undefined;
  const result = await dispatch(["serve"], {
    rootDir: "/tmp/lucid-serve-view-test",
    serveFn: async (value) => {
      options = value;
    },
  });
  expect(result).toEqual({ kind: "serve" });
  expect(options).toEqual({
    conversationId: undefined,
    conversationPanel: undefined,
    rootDir: "/tmp/lucid-serve-view-test",
  });
});

test("serve carries explicit visibility and conversation regardless of option order", async () => {
  for (const conversationPanel of ["open", "closed"] as const) {
    for (const args of [
      ["serve", "release review", "--conversation-panel", conversationPanel],
      ["serve", "--conversation-panel", conversationPanel, "release review"],
    ]) {
      let options: ServeOpts | undefined;
      await dispatch(args, {
        serveFn: async (value) => {
          options = value;
        },
      });
      expect(options?.conversationId).toBe("release review");
      expect(options?.conversationPanel).toBe(conversationPanel);
    }
  }
});

test("invalid serve arguments return guidance before starting a server or resolving records", async () => {
  for (const args of [
    ["--conversation-panel"],
    ["--conversation-panel", "wide"],
    ["--conversation-panel", "OPEN"],
    ["--conversation-panel", "open", "--conversation-panel", "closed"],
    ["--unknown"],
    ["one", "two"],
    [".."],
    ["bad/name"],
    [""],
    ["--help"],
    ["-h"],
  ]) {
    let called = false;
    const result = await dispatch(["serve", ...args], {
      conversationsFactory: () => {
        called = true;
        throw new Error("Must not resolve records");
      },
      serveFn: async () => {
        called = true;
      },
    });
    expect(result.kind).toBe("help");
    expect(called).toBe(false);
    if (result.kind === "help") {
      expect(result.message).toContain("--conversation-panel");
      expect(result.message).toContain("closed");
      expect(result.message).toContain("open");
    }
  }
});

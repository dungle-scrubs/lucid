import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type {
  ContextCountOptions,
  HarnessRunner,
  StreamTurnOptions,
} from "../../src/harness/runner.js";
import { createContextPreparer } from "../../src/modes/context-preparation.js";
import {
  type ConversationContext,
  renderConversationContext,
} from "../../src/store/conversation-context.js";

const context: ConversationContext = {
  digest: "captured-context",
  from: 0,
  history: [],
  mandatory: [
    {
      id: "artifact:doc:1",
      kind: "artifact",
      provenance: { version: 1 },
      role: "agent",
      seq: 2,
      text: "Complete current document",
    },
  ],
  pending: {
    id: "input:current",
    kind: "message",
    provenance: { inputId: "current" },
    role: "user",
    seq: 1,
    text: "Update this document",
  },
  through: 2,
};
const route = {
  harness: "claude" as const,
  model: "selected-model",
  effort: "high",
  profile: "headless-turn" as const,
  cwd: "/working-folder",
  resume: "working-session",
};
const render = (captured: ConversationContext): string =>
  `Protocol teaching\n${renderConversationContext(captured, "Full source: external offered copy")}`;

function fakeRunner(counts: ContextCountOptions[]): HarnessRunner {
  return {
    countContext: async (request) => {
      counts.push(request);
      return {
        status: "available",
        executable: { path: "/fake/harness", version: "verified" },
        method: "native-context-estimate",
        model: route.model,
        inputLimitTokens: 10000,
        totalTokens: 9000,
      };
    },
    inspect: async () => {
      throw new Error("No summary needed");
    },
    capabilities: async () => {
      throw new Error("Unused");
    },
    openSession: async () => {
      throw new Error("No working session may open here");
    },
    streamTurn: () => {
      throw new Error("Fitting context must not start a model");
    },
  };
}

test("fitting context preserves the exact full prompt and native occupancy", async () => {
  const counts: ContextCountOptions[] = [];
  const prepare = createContextPreparer(fakeRunner(counts));
  const result = await prepare({ context, render, route });
  expect(result.prompt).toBe(render(context));
  expect(result.summary).toBeNull();
  expect(result.accounting.totalTokens).toBe(9000);
  expect(counts).toEqual([{ ...route, prompt: result.prompt }]);
});

test("long history is summarized separately while current content and recent messages stay whole", async () => {
  const counts: ContextCountOptions[] = [];
  const launches: StreamTurnOptions[] = [];
  const history = Array.from({ length: 12 }, (_, seq) => ({
    id: `event:${seq}`,
    kind: "message" as const,
    provenance: { harness: "previous-harness" },
    role: seq % 2 ? "assistant" : "user",
    seq,
    text: `Message ${seq}: ${"older text ".repeat(70)}`,
  }));
  const captured = { ...context, history, through: 20 };
  const runner: HarnessRunner = {
    ...fakeRunner(counts),
    countContext: async (request) => {
      counts.push(request);
      return {
        status: "available",
        executable: { path: "/fake/harness", version: "verified" },
        method: "native-context-estimate",
        model: route.model,
        inputLimitTokens: request.isolation ? 20000 : 6500,
        totalTokens: request.prompt.length,
      };
    },
    inspect: async (_harness, choice) => {
      expect(choice).toMatchObject({ model: route.model, isolation: "tool-free" });
      return { name: route.harness, verifiedAgainst: "verified", session: true };
    },
    streamTurn: async function* (request) {
      launches.push(request);
      expect(request.resume).toBeUndefined();
      expect(request.isolation).toBe("tool-free");
      expect(request.model).toBe(route.model);
      expect(request.cwd).not.toBe(route.cwd);
      expect(existsSync(request.cwd ?? "")).toBe(true);
      expect(request.prompt).not.toContain(context.pending.text);
      expect(request.prompt).toContain("previous-harness");
      expect(
        counts.some((count) => count.cwd === request.cwd && count.prompt === request.prompt),
      ).toBe(true);
      yield {
        kind: "message",
        role: "assistant",
        text: "Keep the document readable. Decision from event:0 remains unresolved; event:7 records the prior result.",
      };
      yield { kind: "done", exitCode: 0, cause: "clean" };
    },
  };
  const result = await createContextPreparer(runner)({ context: captured, render, route });
  expect(launches).toHaveLength(1);
  expect(result.summary).toMatchObject({ model: route.model, from: 0, through: 8 });
  for (const entry of history.slice(-4)) expect(result.prompt).toContain(entry.text);
  expect(result.prompt).toContain(context.pending.text);
  expect(result.prompt).toContain(context.mandatory[0]?.text ?? "missing");
  expect(result.prompt).toContain("Full source: external offered copy");
  expect(result.accounting.totalTokens).toBeLessThanOrEqual(result.accounting.inputLimitTokens);
  expect(captured.history).toEqual(history);
  expect(existsSync(launches[0]?.cwd ?? "")).toBe(false);
});

test.each([false, true])(
  "history larger than one summary request is reduced in counted passes, transport refusal: %s",
  async (transport) => {
    const counts: ContextCountOptions[] = [];
    const launched: string[] = [];
    const history = Array.from({ length: 44 }, (_, seq) => ({
      id: `event:${seq}`,
      kind: "message" as const,
      provenance: { harness: "previous" },
      role: seq % 2 ? "assistant" : "user",
      seq,
      text: `original-${seq}: ${"x".repeat(650)}`,
    }));
    const runner: HarnessRunner = {
      ...fakeRunner(counts),
      countContext: async (request) => {
        counts.push(request);
        if (transport && !request.isolation && request.prompt.length > 7000)
          return { status: "unavailable", reason: "transport-limit" };
        return {
          status: "available",
          executable: { path: "/fake/harness", version: "verified" },
          method: "native-context-estimate",
          model: route.model,
          inputLimitTokens: request.isolation ? 3500 : 7000,
          totalTokens: request.prompt.length,
        };
      },
      inspect: async () => ({ name: route.harness, verifiedAgainst: "verified", session: true }),
      streamTurn: async function* (request) {
        expect(request.prompt.length).toBeLessThanOrEqual(3500);
        expect(
          counts.some(
            (count) => count.isolation === "tool-free" && count.prompt === request.prompt,
          ),
        ).toBe(true);
        launched.push(request.prompt);
        yield {
          kind: "message",
          role: "assistant",
          text: request.prompt.includes("original-")
            ? `Derived first pass: ${"y".repeat(800)}`
            : "Decisions and constraints remain in the cited source range; unresolved work stays unresolved.",
        };
        yield { kind: "done", exitCode: 0, cause: "clean" };
      },
    };
    const result = await createContextPreparer(runner)({
      context: { ...context, history, through: 60 },
      render,
      route,
    });
    expect(launched.length).toBeGreaterThan(2);
    expect(launched.some((prompt) => prompt.includes("Derived first pass"))).toBe(true);
    expect(result.prompt).toContain("original-43");
    expect(result.prompt).toContain(context.pending.text);
    expect(result.accounting.totalTokens).toBeLessThanOrEqual(7000);
  },
);

test("summary reuse follows source content and selected model, while every final prompt is recounted", async () => {
  const counts: ContextCountOptions[] = [];
  let summaries = 0;
  const history = Array.from({ length: 12 }, (_, seq) => ({
    id: `event:${seq}`,
    kind: "message" as const,
    provenance: {},
    role: "user",
    seq,
    text: "x".repeat(700),
  }));
  const runner: HarnessRunner = {
    ...fakeRunner(counts),
    countContext: async (request) => {
      counts.push(request);
      return {
        status: "available",
        executable: { path: "/fake/harness", version: "verified" },
        method: "native-context-estimate",
        model: request.model ?? "unknown",
        inputLimitTokens: request.isolation ? 20000 : 6000,
        totalTokens: request.prompt.length,
      };
    },
    inspect: async () => ({ name: route.harness, verifiedAgainst: "verified", session: true }),
    streamTurn: async function* () {
      summaries++;
      yield {
        kind: "message",
        role: "assistant",
        text: `Summary number ${summaries}: unresolved work and source references.`,
      };
      yield { kind: "done", exitCode: 0, cause: "clean" };
    },
  };
  const prepare = createContextPreparer(runner);
  const captured = { ...context, history, through: 20 };
  const first = await prepare({ context: captured, render, route });
  const changedPending = {
    ...captured,
    pending: { ...captured.pending, text: "A different pending request" },
  };
  const second = await prepare({ context: changedPending, render, route });
  expect(summaries).toBe(1);
  expect(second.prompt).toContain(changedPending.pending.text);
  expect(second.summary).toEqual(first.summary);
  expect(counts.at(-1)?.prompt).toBe(second.prompt);
  const changedHistory = {
    ...captured,
    history: history.map((entry, index) =>
      index === 0 ? { ...entry, text: "Changed constraint" } : entry,
    ),
  };
  const third = await prepare({ context: changedHistory, render, route });
  expect(summaries).toBe(2);
  expect(third.summary?.digest).not.toBe(first.summary?.digest);
  await prepare({ context: captured, render, route: { ...route, model: "new-selection" } });
  expect(summaries).toBe(3);
});

test("cancellation while accounting finishes cannot return a dispatchable prompt", async () => {
  const counts: ContextCountOptions[] = [];
  const controller = new AbortController();
  const runner = fakeRunner(counts);
  const prepare = createContextPreparer({
    ...runner,
    countContext: async (request) => {
      const result = await runner.countContext(request);
      controller.abort();
      return result;
    },
  });
  await expect(
    prepare({ context, render, route: { ...route, signal: controller.signal } }),
  ).rejects.toMatchObject({ code: "E-HUB-06" });
});

test("an explicit full-request transport limit can use measured mandatory context and bounded summaries", async () => {
  const counts: ContextCountOptions[] = [];
  const history = Array.from({ length: 12 }, (_, seq) => ({
    id: `event:${seq}`,
    kind: "message" as const,
    provenance: {},
    role: "user",
    seq,
    text: "x".repeat(700),
  }));
  const prepare = createContextPreparer({
    ...fakeRunner(counts),
    countContext: async (request) => {
      counts.push(request);
      if (!request.isolation && request.prompt.length > 8000)
        return { status: "unavailable", reason: "transport-limit" };
      return {
        status: "available",
        executable: { path: "/fake/harness", version: "verified" },
        method: "native-context-estimate",
        model: route.model,
        inputLimitTokens: request.isolation ? 20000 : 6000,
        totalTokens: request.prompt.length,
      };
    },
    inspect: async () => ({ name: route.harness, verifiedAgainst: "verified", session: true }),
    streamTurn: async function* () {
      yield {
        kind: "message",
        role: "assistant",
        text: "Preserved decisions, unresolved work, and references to the original source range.",
      };
      yield { kind: "done", exitCode: 0, cause: "clean" };
    },
  });
  const result = await prepare({ context: { ...context, history, through: 20 }, render, route });
  expect(result.summary).not.toBeNull();
  expect(result.accounting.totalTokens).toBeLessThanOrEqual(6000);
  expect(result.prompt).toContain(context.pending.text);
});

test.each([
  "unknown-budget",
  "mandatory-too-large",
  "isolation-refused",
  "summary-budget-unknown",
  "summary-failed",
  "summary-tool",
  "summary-empty",
  "summary-overflow",
  "model-changed",
  "summary-never-fits",
])("%s holds the unchanged pending input without a truncated start", async (scenario) => {
  const counts: ContextCountOptions[] = [];
  const launches: StreamTurnOptions[] = [];
  const history = Array.from({ length: 12 }, (_, seq) => ({
    id: `event:${seq}`,
    kind: "message" as const,
    provenance: {},
    role: "user",
    seq,
    text: "x".repeat(700),
  }));
  const captured = { ...context, history, through: 20 };
  const before = JSON.stringify(captured);
  const runner: HarnessRunner = {
    ...fakeRunner(counts),
    countContext: async (request) => {
      counts.push(request);
      if (
        scenario === "unknown-budget" ||
        (request.isolation && scenario === "summary-budget-unknown")
      )
        return { status: "unavailable", reason: "unverified-adapter" };
      return {
        status: "available",
        executable: { path: "/fake/harness", version: "verified" },
        method: "native-context-estimate",
        model: scenario === "model-changed" && request.isolation ? "unexpected" : route.model,
        inputLimitTokens: request.isolation ? 20000 : scenario === "mandatory-too-large" ? 1 : 6000,
        totalTokens: request.prompt.length,
      };
    },
    inspect: async () => {
      if (scenario === "isolation-refused") throw new Error("Unsupported isolation");
      return { name: route.harness, verifiedAgainst: "verified", session: true };
    },
    streamTurn: async function* (request) {
      launches.push(request);
      if (scenario === "summary-tool") yield { kind: "tool", name: "forbidden" };
      yield {
        kind: "message",
        role: "assistant",
        text:
          scenario === "summary-empty"
            ? ""
            : "y".repeat(scenario === "summary-overflow" ? 16001 : 9000),
      };
      yield {
        kind: "done",
        cause: scenario === "summary-failed" ? "error" : "clean",
        exitCode: scenario === "summary-failed" ? 1 : 0,
      };
    },
  };
  await expect(
    createContextPreparer(runner)({ context: captured, render, route }),
  ).rejects.toMatchObject({ code: "E-HUB-06" });
  expect(JSON.stringify(captured)).toBe(before);
  expect(launches.length).toBeLessThanOrEqual(64);
  if (
    [
      "unknown-budget",
      "mandatory-too-large",
      "isolation-refused",
      "summary-budget-unknown",
      "model-changed",
    ].includes(scenario)
  )
    expect(launches).toHaveLength(0);
  for (const launch of launches) {
    expect(launch.isolation).toBe("tool-free");
    expect(launch.resume).toBeUndefined();
    expect(existsSync(launch.cwd ?? "")).toBe(false);
  }
});

test("a large source entry splits without losing text or breaking Unicode boundaries", async () => {
  const counts: ContextCountOptions[] = [];
  const original = "Keep this constraint 🧭 ".repeat(300);
  const fragments: string[] = [];
  const history = Array.from({ length: 5 }, (_, seq) => ({
    id: `event:${seq}`,
    kind: "message" as const,
    provenance: { harness: "previous" },
    role: "user",
    seq,
    text: seq === 0 ? original : `recent ${seq}`,
  }));
  const runner: HarnessRunner = {
    ...fakeRunner(counts),
    countContext: async (request) => {
      counts.push(request);
      return {
        status: "available",
        executable: { path: "/fake/harness", version: "verified" },
        method: "native-context-estimate",
        model: route.model,
        inputLimitTokens: request.isolation ? 2500 : 6000,
        totalTokens: request.prompt.length,
      };
    },
    inspect: async () => ({ name: route.harness, verifiedAgainst: "verified", session: true }),
    streamTurn: async function* (request) {
      const entries = JSON.parse(request.prompt.split("\n\n").at(-1) ?? "[]") as {
        text: string;
        provenance: { sourceId: string };
      }[];
      for (const entry of entries) {
        expect(entry.provenance.sourceId).toBe("event:0");
        expect(Buffer.from(entry.text).toString("utf8")).toBe(entry.text);
        fragments.push(entry.text);
      }
      yield {
        kind: "message",
        role: "assistant",
        text: "event:0: Keep this constraint. Source offsets preserve the full original text.",
      };
      yield { kind: "done", exitCode: 0, cause: "clean" };
    },
  };
  const result = await createContextPreparer(runner)({
    context: { ...context, history, through: 10 },
    render,
    route,
  });
  expect(fragments.length).toBeGreaterThan(1);
  expect(fragments.join("")).toBe(original);
  expect(result.prompt).toContain("recent 4");
});

test("a later smaller request reuses the fuller first-pass summary", async () => {
  const counts: ContextCountOptions[] = [];
  const history = Array.from({ length: 12 }, (_, seq) => ({
    id: `event:${seq}`,
    kind: "message" as const,
    provenance: {},
    role: "user",
    seq,
    text: `original-${"x".repeat(700)}`,
  }));
  let launches = 0;
  const runner: HarnessRunner = {
    ...fakeRunner(counts),
    countContext: async (request) => {
      counts.push(request);
      return {
        status: "available",
        executable: { path: "/fake/harness", version: "verified" },
        method: "native-context-estimate",
        model: route.model,
        inputLimitTokens: request.isolation ? 20000 : 6500,
        totalTokens: request.prompt.length,
      };
    },
    inspect: async () => ({ name: route.harness, verifiedAgainst: "verified", session: true }),
    streamTurn: async function* (request) {
      launches++;
      yield {
        kind: "message",
        role: "assistant",
        text: request.prompt.includes("original-")
          ? `First-pass details ${"d".repeat(1500)}`
          : "Further reduced constraints and source references.",
      };
      yield { kind: "done", exitCode: 0, cause: "clean" };
    },
  };
  const prepare = createContextPreparer(runner);
  const large = {
    ...context,
    history,
    through: 20,
    pending: { ...context.pending, text: "p".repeat(1100) },
  };
  const first = await prepare({ context: large, render, route });
  expect(first.prompt).toContain("Further reduced");
  const afterFirst = launches;
  const second = await prepare({ context: { ...context, history, through: 20 }, render, route });
  expect(second.prompt).toContain("First-pass details");
  expect(launches).toBe(afterFirst);
});

test("sparse message history can summarize older tool output while retaining recent messages", async () => {
  const counts: ContextCountOptions[] = [];
  const history = [
    {
      id: "event:0",
      kind: "message" as const,
      provenance: {},
      role: "user",
      seq: 0,
      text: "Older request",
    },
    ...Array.from({ length: 20 }, (_, index) => ({
      id: `event:${index + 1}`,
      kind: "tool" as const,
      provenance: {},
      role: "tool",
      seq: index + 1,
      text: "old result ".repeat(70),
    })),
    {
      id: "event:21",
      kind: "message" as const,
      provenance: {},
      role: "assistant",
      seq: 21,
      text: "Recent answer remains complete",
    },
  ];
  const prepare = createContextPreparer({
    ...fakeRunner(counts),
    countContext: async (request) => {
      counts.push(request);
      return {
        status: "available",
        executable: { path: "/fake/harness", version: "verified" },
        method: "native-context-estimate",
        model: route.model,
        inputLimitTokens: request.isolation ? 25000 : 6000,
        totalTokens: request.prompt.length,
      };
    },
    inspect: async () => ({ name: route.harness, verifiedAgainst: "verified", session: true }),
    streamTurn: async function* () {
      yield {
        kind: "message",
        role: "assistant",
        text: "Older tool findings and request constraints, with source references.",
      };
      yield { kind: "done", exitCode: 0, cause: "clean" };
    },
  });
  const result = await prepare({ context: { ...context, history, through: 30 }, render, route });
  expect(result.prompt).toContain("Recent answer remains complete");
  expect(result.summary).toMatchObject({ from: 0, through: 21 });
});

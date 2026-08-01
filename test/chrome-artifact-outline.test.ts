import { describe, expect, test } from "bun:test";
import {
  createChromeArtifactOutline,
  type OutlineLayoutMeasurement,
  type OutlinePort,
  type OutlineStatePatch,
  type OutlineStateView,
} from "../client/chrome/artifact-outline-session.ts";
import { isOutlineChannelBootstrap } from "../client/shared/protocol.ts";

class FakePort implements OutlinePort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly sent: unknown[] = [];
  closed = false;
  started = false;

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  start(): void {
    this.started = true;
  }

  close(): void {
    this.closed = true;
  }

  receive(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

const setup = () => {
  let now = 100;
  const patches: OutlineStatePatch[] = [];
  let layout: OutlineLayoutMeasurement | null = {
    preferredWidth: 240,
    safeInsets: { bottom: 40, right: 30, top: 60 },
  };
  let state: OutlineStateView = { outlineHealth: null, outlineSnapshot: null };
  const controller = createChromeArtifactOutline({
    getState: () => state,
    measureLayout: () => layout,
    now: () => now,
    setState: (patch) => {
      state = { ...state, ...patch };
      patches.push(patch);
    },
  });
  controller.setLayoutAvailable(true);
  controller.setActive(true);
  return {
    advance: (ms: number) => {
      now += ms;
    },
    controller,
    loseLayout: () => {
      layout = null;
    },
    patches,
  };
};

const completeSnapshot = (requestGeneration: number, generation = 7) => ({
  type: "outline-snapshot",
  requestGeneration,
  generation,
  availability: "complete",
  headings: [
    { key: "h-1", label: "First" },
    { key: "h-2", label: "Second" },
  ],
  activeKey: "h-1",
  proof: { complete: true, clearancePx: 24, reason: "clear" },
});

describe("active-session artifact outline bridge", () => {
  test("recognizes only the exact pre-artifact bootstrap envelope", () => {
    expect(
      isOutlineChannelBootstrap({
        source: "lucid-overlay-bootstrap",
        type: "private-channel",
        version: 1,
      }),
    ).toBe(true);
    expect(
      isOutlineChannelBootstrap({
        source: "lucid-overlay-bootstrap",
        type: "private-channel",
        version: 2,
      }),
    ).toBe(false);
    expect(isOutlineChannelBootstrap({ type: "private-channel", version: 1 })).toBe(false);
  });

  test("accepts only the first private port and requests the measured safe slot", () => {
    const { controller } = setup();
    const port = new FakePort();
    expect(controller.acceptPort(port)).toBe(true);
    expect(port.started).toBe(true);
    expect(port.sent).toEqual([
      {
        type: "outline-layout-request",
        generation: 1,
        preferredWidth: 240,
        safeInsets: { bottom: 40, right: 30, top: 60 },
      },
    ]);

    const replacement = new FakePort();
    expect(controller.acceptPort(replacement)).toBe(false);
    expect(replacement.closed).toBe(true);
    expect(port.closed).toBe(false);
  });

  test("commits only bounded, current-generation snapshots and strips diagnostic prose", () => {
    const { controller, patches } = setup();
    const port = new FakePort();
    controller.acceptPort(port);
    const beforeStale = patches.length;
    port.receive(completeSnapshot(0));
    expect(patches).toHaveLength(beforeStale);

    port.receive(completeSnapshot(1));
    expect(patches.at(-1)?.outlineSnapshot?.headings.map(({ label }) => label)).toEqual([
      "First",
      "Second",
    ]);

    port.receive({
      type: "outline-invalidated",
      generation: 8,
      health: {
        code: "AO-003",
        generation: 8,
        occurrenceCount: 3,
        reason: "artifact text must not enter chrome diagnostics",
      },
    });
    expect(patches.at(-1)).toEqual({
      outlineHealth: { code: "AO-003", count: 3, generation: 8 },
      outlineSnapshot: null,
    });
  });

  test("bounds publication rate and routes activation only to the current projection", () => {
    const { advance, controller, patches } = setup();
    const port = new FakePort();
    controller.acceptPort(port);
    port.receive(completeSnapshot(1));
    for (let index = 0; index < 5; index += 1) {
      advance(1);
      port.receive(completeSnapshot(1, 8 + index));
    }
    expect(patches.filter(({ outlineSnapshot }) => outlineSnapshot != null)).toHaveLength(4);

    expect(controller.activate("missing", "normal")).toBe(false);
    expect(controller.activate("h-2", "reduced")).toBe(true);
    expect(port.sent.at(-1)).toEqual({
      type: "outline-activate",
      generation: 10,
      key: "h-2",
      motion: "reduced",
    });

    advance(1_001);
    const patchCount = patches.length;
    port.receive(completeSnapshot(1, 9));
    expect(patches).toHaveLength(patchCount);
  });

  test("clears state and ignores publications whenever the session is inactive or detached", () => {
    const { controller, patches } = setup();
    const port = new FakePort();
    controller.acceptPort(port);
    port.receive(completeSnapshot(1));
    controller.setActive(false);
    expect(patches.at(-1)).toEqual({ outlineHealth: null, outlineSnapshot: null });
    const count = patches.length;
    port.receive(completeSnapshot(1, 9));
    expect(patches).toHaveLength(count);

    controller.setActive(true);
    expect(port.sent.at(-1)).toMatchObject({ generation: 2, type: "outline-layout-request" });

    controller.setActive(false);
    expect(port.sent.at(-1)).toEqual({ type: "outline-suspend" });
    controller.setActive(true);
    expect(port.sent.at(-1)).toMatchObject({ generation: 3, type: "outline-layout-request" });

    controller.resetChannel();
    expect(port.closed).toBe(true);
  });

  test("slot loss clears the projection and disables activation without closing the live port", () => {
    const { controller, loseLayout, patches } = setup();
    const port = new FakePort();
    controller.acceptPort(port);
    port.receive(completeSnapshot(1));

    loseLayout();
    controller.setLayoutAvailable(false);
    expect(patches.at(-1)).toEqual({ outlineHealth: null, outlineSnapshot: null });
    const patchCount = patches.length;
    port.receive(completeSnapshot(1, 8));
    expect(patches).toHaveLength(patchCount);
    expect(controller.activate("h-1", "normal")).toBe(false);
    expect(port.closed).toBe(false);
  });

  test("a revision rejects old-DOM publications until the acknowledged layout request", () => {
    const { controller, patches } = setup();
    const port = new FakePort();
    controller.acceptPort(port);
    port.receive(completeSnapshot(1));

    const revision = controller.prepareRevision();
    const afterRevision = patches.length;
    port.receive(completeSnapshot(1, 8));
    expect(patches).toHaveLength(afterRevision);
    expect(controller.activate("h-1", "normal")).toBe(false);

    expect(controller.requestLayout(true)).toBe(false);
    controller.setActive(false);
    controller.setActive(true);
    expect(port.sent.at(-1)).toEqual({ type: "outline-suspend" });
    port.receive({ revision: revision + 1, type: "outline-revision-complete" });
    expect(port.sent.at(-1)).toEqual({ type: "outline-suspend" });
    port.receive({ revision, type: "outline-revision-complete" });
    expect(port.sent.at(-1)).toMatchObject({ generation: 3, type: "outline-layout-request" });
    port.receive(completeSnapshot(3, 9));
    expect(patches.at(-1)?.outlineSnapshot?.generation).toBe(9);
  });

  test("a first private port supersedes a revision orphaned by the missing-artifact frame", () => {
    const { controller } = setup();
    controller.prepareRevision();
    const port = new FakePort();

    expect(controller.acceptPort(port)).toBe(true);
    expect(port.sent).toEqual([
      {
        generation: 2,
        preferredWidth: 240,
        safeInsets: { bottom: 40, right: 30, top: 60 },
        type: "outline-layout-request",
      },
    ]);
  });
});

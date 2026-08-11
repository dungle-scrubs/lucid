import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Frame } from "../../src/protocol/index.js";
import { createConversationRecord, openConversation } from "../../src/store/store.js";
import { paint, renderLines } from "../../src/tui/render.js";
import { buildView } from "../../src/tui/view.js";
import { attach, event } from "../protocol/helpers.js";

const rig = () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-tui-"));
  const { secret } = createConversationRecord(root, "conv-1");
  const box = { now: 1_000, presence: undefined as boolean | undefined };
  const host = openConversation(join(root, "conv-1"), {
    now: () => box.now,
    presence: () => box.presence,
    onRecord: () => {},
    onEffect: () => {},
  });
  return { root, secret, host, box, send: (f: Frame) => host.handleFrame(JSON.stringify(f)) };
};

describe("TUI view-model (M6.1)", () => {
  test("D-009: the view IS fold(log) - a rebuild from the reopened store's transcript is identical, no separate state", () => {
    const r = rig();
    r.send(attach({ conversationId: "conv-1", secret: r.secret }));
    r.send(event({ epoch: 1, n: 1, turnId: "t-1", event: { kind: "message", text: "hello" } }));
    r.host.enqueueInput({ id: "in-1", text: "a question", mode: "queue" });

    const live = buildView({
      transcript: r.host.transcript(),
      inputs: r.host.state().inputs,
      status: r.host.status(),
      rung: "hooks",
      draft: "typing…",
    });

    // Reopen the store and rebuild the view purely from the folded log +
    // state: byte-identical. The TUI holds no state the log does not.
    const reopened = openConversation(join(r.root, "conv-1"), {
      now: () => r.box.now,
      presence: () => r.box.presence,
      onRecord: () => {},
      onEffect: () => {},
    });
    const rebuilt = buildView({
      transcript: reopened.transcript(),
      inputs: reopened.state().inputs,
      status: reopened.status(),
      rung: "hooks",
      draft: "typing…",
    });
    expect(rebuilt).toEqual(live);
  });

  test("conversation view interleaves agent output and human input in seq order with per-item disposition marks", () => {
    const r = rig();
    r.send(attach({ conversationId: "conv-1", secret: r.secret, profile: "headless-session" }));
    r.send(event({ epoch: 1, n: 1, turnId: "t-1", event: { kind: "message", text: "agent one" } }));
    r.host.enqueueInput({ id: "in-1", text: "human asks", mode: "queue" });
    r.send({ kind: "disposition", epoch: 1, inputId: "in-1", outcome: "queued" });

    const view = buildView({
      transcript: r.host.transcript(),
      inputs: r.host.state().inputs,
      status: r.host.status(),
      rung: "n/a",
      draft: "",
    });

    // Ordered by seq: agent event (seq 2) then the human input (seq 3).
    expect(view.lines.map((l) => l.kind)).toEqual(["agent", "human"]);
    expect(view.lines[0]).toMatchObject({ kind: "agent", text: "agent one" });
    // The human line carries its disposition mark (queued = accepted, held).
    expect(view.lines[1]).toMatchObject({ kind: "human", text: "human asks", mark: "»" });
  });

  test("the status line shows channel state + rung + input box, and an aborted-but-not-done turn is flagged while a completed one is not", () => {
    const r = rig();
    r.box.presence = true;
    r.send(attach({ conversationId: "conv-1", secret: r.secret }));
    // A turn that completes (has a done event).
    r.send(
      event({ epoch: 1, n: 1, turnId: "t-done", event: { kind: "message", text: "finished" } }),
    );
    r.send(event({ epoch: 1, n: 2, turnId: "t-done", event: { kind: "done", exitCode: 0 } }));
    // A turn left in flight, then a lease-expiry takeover aborts it. The
    // human process is gone (presence false), so the headless takeover is
    // legal and the channel is agent-gone.
    r.send(
      event({ epoch: 1, n: 3, turnId: "t-live", event: { kind: "message", text: "interrupted" } }),
    );
    r.box.now = 1_000 + 15_000;
    r.box.presence = false;
    const takeover = r.send(
      attach({ conversationId: "conv-1", secret: r.secret, profile: "headless-session" }),
    );
    expect(takeover.verdict).toBe("accepted");

    const view = buildView({
      transcript: r.host.transcript(),
      inputs: r.host.state().inputs,
      status: r.host.status(),
      rung: "observe",
      draft: "hi",
    });

    // The takeover succeeded, so the channel is now the live successor
    // (headless-session); the state indicator reflects the current state.
    expect(view.status).toContain("headless-session");
    expect(view.rung).toBe("rung:observe");
    expect(view.inputBox).toBe("> hi");

    // The completed turn's line is NOT flagged aborted; the interrupted
    // one IS - even though both turns received an abort-turn signal.
    const finished = view.lines.find((l) => l.text === "finished");
    const interrupted = view.lines.find((l) => l.text === "interrupted");
    expect(finished?.aborted).toBe(false);
    expect(interrupted?.aborted).toBe(true);
  });
});

describe("TUI render (M6.1)", () => {
  test("renderLines paints the view-model verbatim - body lines, a rule, the status+rung line, the input box - and paint writes them to the injected sink", () => {
    const view = buildView({
      transcript: {
        events: [{ seq: 2, epoch: 1, turnId: "t-1", event: { kind: "message", text: "hi" } }],
        aborted: [],
      },
      inputs: [],
      status: "interactive-attached",
      rung: "hooks",
      draft: "type here",
    });
    const lines = renderLines(view);
    expect(lines[0]).toContain("hi");
    expect(lines.at(-1)).toBe("> type here");
    expect(
      lines.some((l) => l.includes("[interactive-attached]") && l.includes("rung:hooks")),
    ).toBe(true);

    let out = "";
    paint(view, (chunk) => {
      out += chunk;
    });
    expect(out).toContain("hi");
    expect(out).toContain("> type here");
    expect(out.startsWith("\x1b[2J")).toBe(true); // cleared before paint
  });
});

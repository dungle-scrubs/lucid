import { describe, expect, test } from "bun:test";
import { closedChatCorner } from "../../src/server/client/closed-chat-status.js";

const idle = {
  panelOpen: false,
  queuedNotes: 0,
  dead: false,
  damaged: false,
  connected: true,
  sending: false,
  submissionBusy: false,
  workBusy: false,
};

describe("the closed-chat corner", () => {
  test("queued notes hold the send button", () => {
    expect(closedChatCorner({ ...idle, queuedNotes: 3 })).toBe("send");
  });

  test("an emptied queue hands the corner to the running work", () => {
    // The send finished, the notes left, the turn has not landed.
    expect(closedChatCorner({ ...idle, workBusy: true })).toBe("status");
    // The request itself is still in flight.
    expect(closedChatCorner({ ...idle, sending: true })).toBe("status");
    expect(closedChatCorner({ ...idle, submissionBusy: true })).toBe("status");
  });

  test("nothing in flight means nothing in the corner", () => {
    expect(closedChatCorner(idle)).toBe("none");
  });

  test("an open panel shows everything in chat itself", () => {
    expect(closedChatCorner({ ...idle, panelOpen: true, queuedNotes: 3 })).toBe("none");
    expect(closedChatCorner({ ...idle, panelOpen: true, workBusy: true })).toBe("none");
  });

  test("a dead connection leaves the corner alone", () => {
    expect(closedChatCorner({ ...idle, dead: true, workBusy: true })).toBe("none");
    expect(closedChatCorner({ ...idle, damaged: true, queuedNotes: 1 })).toBe("none");
    expect(closedChatCorner({ ...idle, connected: false, queuedNotes: 1 })).toBe("none");
  });
});

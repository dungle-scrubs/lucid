import { describe, expect, test } from "bun:test";
import {
  attendance,
  workingLine,
  type AttendanceState,
  type WorkingLineState,
} from "../client/chrome/attendance.ts";

const baseWorking: WorkingLineState["agentWorking"] = {
  since: new Date(Date.now() - 30000).toISOString(),
  heardAt: new Date(Date.now() - 5000).toISOString(),
  intent: "revise",
};

const state = (
  overrides: Partial<WorkingLineState & AttendanceState> = {},
): WorkingLineState & AttendanceState =>
  ({
    agentWorking: null,
    annotationCount: 0,
    attendantPresence: null,
    attend: false,
    awaitingAck: null,
    harnessCount: 1,
    harness: "the agent",
    lastAttendant: null,
    lastTurnEnd: null,
    messageCount: 0,
    resumable: false,
    status: "active",
    agentsListening: 0,
    ...overrides,
  }) as WorkingLineState & AttendanceState;

describe("workingLine precedence", () => {
  test("awaiting-ack wins over turn-ended when feedback is unacked and a turn also ended", () => {
    const s = state({
      agentWorking: null,
      awaitingAck: new Set(["a"]),
      lastTurnEnd: { reason: "no-change", code: "normal" },
      status: "active",
    });
    expect(workingLine(s, Date.now()).kind).toBe("awaiting-ack");
  });

  test("turn-ended wins over blocked when no working window is open", () => {
    const s = state({
      agentWorking: null,
      lastTurnEnd: { reason: "no-change", code: "normal" },
      status: "active",
    });
    expect(workingLine(s, Date.now()).kind).toBe("turn-ended");
  });

  test("blocked wins over progress", () => {
    const s = state({
      agentWorking: { ...baseWorking, blocked: "need your input" },
    });
    const line = workingLine(s, Date.now());
    expect(line.kind).toBe("blocked");
  });

  test("progress (single agent narrating phases) is its own arm", () => {
    const s = state({
      agentWorking: {
        ...baseWorking,
        progress: { label: "thinking", total: undefined },
      },
    });
    const line = workingLine(s, Date.now());
    expect(line.kind).toBe("progress");
  });

  test("fan-out (progress with total) is its own arm", () => {
    const s = state({
      agentWorking: {
        ...baseWorking,
        progress: { label: "working", total: 3, done: 1 },
      },
    });
    const line = workingLine(s, Date.now());
    expect(line.kind).toBe("fan-out");
  });

  test("stale is derived from the grace constant via workingClock", () => {
    const s = state({
      agentWorking: {
        ...baseWorking,
        heardAt: "2000-01-01T00:00:00Z",
      },
    });
    const line = workingLine(s, Date.now());
    expect(line.kind).toBe("stale");
  });

  test("live is an explicit arm when working is fresh with no progress", () => {
    const s = state({
      agentWorking: { ...baseWorking },
    });
    const line = workingLine(s, Date.now());
    expect(line.kind).toBe("live");
  });

  test("none is an explicit arm when nothing is working and no turn ended", () => {
    const s = state({ agentWorking: null, status: "active" });
    const line = workingLine(s, Date.now());
    expect(line.kind).toBe("none");
  });

  test("none when status is not active even if working exists", () => {
    const s = state({ agentWorking: { ...baseWorking }, status: "reloading" });
    expect(workingLine(s, Date.now()).kind).toBe("none");
  });

  test("fan-out wins over stale when fresh", () => {
    const fresh = state({
      agentWorking: {
        ...baseWorking,
        progress: { label: "working", total: 3 },
      },
    });
    expect(workingLine(fresh, Date.now()).kind).toBe("fan-out");
  });

  test("progress degrades to stale when quiet exceeds grace", () => {
    const s = state({
      agentWorking: {
        ...baseWorking,
        heardAt: "2000-01-01T00:00:00Z",
        progress: { label: "thinking", total: undefined },
      },
    });
    expect(workingLine(s, Date.now()).kind).toBe("stale");
  });
});

describe("attendance", () => {
  test("interactive when presence is interactive", () => {
    const s = state({
      attendantPresence: { interactive: true },
      attend: true,
      resumable: true,
      lastAttendant: { harness: "codex" },
    });
    expect(attendance(s).interactive).toBe(true);
    expect(attendance(s).mode).toBe("interactive");
  });

  test("listening when agents are blocked in wait", () => {
    const s = state({
      attendantPresence: null,
      attend: true,
    });
    expect(attendance(s).listening).toBe(0);
    expect(attendance(s).mode).toBe("unattached");
  });

  test("spawnable when attend and resumable", () => {
    const s = state({
      attendantPresence: null,
      attend: true,
      resumable: true,
      lastAttendant: { harness: "claude" },
    });
    expect(attendance(s).spawnable).toBe(true);
    expect(attendance(s).mode).toBe("spawn");
  });

  test("harness name falls back to 'the agent'", () => {
    const s = state({ lastAttendant: null });
    expect(attendance(s).harness).toBe("the agent");
  });
});

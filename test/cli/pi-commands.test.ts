import { describe, expect, test } from "bun:test";
import { piCommandSession, proposalAncestryRefusal } from "../../src/cli/pi-commands.js";
import type { ProcessSnapshot } from "../../src/process-owner.js";
import type { ProcessOwner } from "../../src/protocol/process-owner.js";

describe("piCommandSession", () => {
  const ID = "pi-session-01";
  test("reads PI_SESSION_ID", () => {
    expect(piCommandSession({ PI_SESSION_ID: ID })).toBe(ID);
  });
  test("rejects an invalid session ID", () => {
    expect(piCommandSession({ PI_SESSION_ID: "not a wire id\u0007" })).toBeUndefined();
    expect(piCommandSession({ PI_SESSION_ID: "" })).toBeUndefined();
  });
  test("returns undefined when the native role environment variable is set", () => {
    expect(piCommandSession({ LUCID_NATIVE_ROLE: "headless", PI_SESSION_ID: ID })).toBeUndefined();
    expect(piCommandSession({ LUCID_NATIVE_ROLE: "", PI_SESSION_ID: ID })).toBeUndefined();
  });
  test("returns undefined without a session variable", () => {
    expect(piCommandSession({})).toBeUndefined();
  });
});

describe("proposalAncestryRefusal (RFC 28 step 2)", () => {
  const REFUSAL = "proposal-ancestry-unverified";
  const owner: ProcessOwner = {
    executable: "/Users/me/.local/bin/pi",
    pid: 100,
    startedAt: "100:1",
  };
  const snap = (pid: number, executable: string, parentPid: number): ProcessSnapshot => ({
    executable,
    parentPid,
    pid,
    startedAt: `${pid}:0`,
  });
  /** A chain named parent-first: chain[i] is the parent of chain[i-1]. */
  const chainProbe =
    (chain: Record<number, { executable: string; parent: number } | null | undefined>) =>
    (pid: number) => {
      const entry = chain[pid];
      return entry === undefined || entry === null
        ? entry
        : snap(pid, entry.executable, entry.parent);
    };

  test("a clean chain (shell, then owner) is accepted", () => {
    const probe = chainProbe({
      500: { executable: "/bin/bash", parent: 100 },
    });
    expect(proposalAncestryRefusal(owner, probe, 500)).toBeNull();
  });

  test("a node between the command and the owner is refused", () => {
    const probe = chainProbe({
      500: { executable: "/bin/bash", parent: 400 },
      400: { executable: "/usr/local/bin/node", parent: 100 },
    });
    expect(proposalAncestryRefusal(owner, probe, 500)).toBe(REFUSAL);
  });

  test("a pi between the command and the owner is refused", () => {
    const probe = chainProbe({
      500: { executable: "/bin/zsh", parent: 400 },
      400: { executable: "/Users/me/.local/bin/pi", parent: 100 },
    });
    expect(proposalAncestryRefusal(owner, probe, 500)).toBe(REFUSAL);
  });

  test("a bun and a deno between the command and the owner are refused", () => {
    for (const name of ["bun", "deno"]) {
      const probe = chainProbe({
        500: { executable: "/bin/zsh", parent: 400 },
        400: { executable: `/opt/homebrew/bin/${name}`, parent: 100 },
      });
      expect(proposalAncestryRefusal(owner, probe, 500)).toBe(REFUSAL);
    }
  });

  test("an executable equal to the owner's is refused", () => {
    const probe = chainProbe({
      500: { executable: "/bin/zsh", parent: 400 },
      400: { executable: owner.executable, parent: 300 },
      300: { executable: "/bin/zsh", parent: 100 },
    });
    expect(proposalAncestryRefusal(owner, probe, 500)).toBe(REFUSAL);
  });

  test("an unreadable process between the command and the owner is refused", () => {
    const probe = chainProbe({
      500: { executable: "/bin/zsh", parent: 400 },
      400: undefined,
    });
    expect(proposalAncestryRefusal(owner, probe, 500)).toBe(REFUSAL);
  });

  test("a gone process between the command and the owner is refused", () => {
    const probe = chainProbe({
      500: { executable: "/bin/zsh", parent: 400 },
      400: null,
    });
    expect(proposalAncestryRefusal(owner, probe, 500)).toBe(REFUSAL);
  });

  test("a chain that never reaches the owner is refused", () => {
    // A long shell chain that stops at pid 1 without meeting the owner.
    const chain: Record<number, { executable: string; parent: number }> = {};
    let pid = 500;
    for (let next = 499; pid > 460; next--) {
      chain[pid] = { executable: "/bin/zsh", parent: next };
      pid = next;
    }
    chain[pid] = { executable: "/sbin/launchd", parent: 1 };
    expect(proposalAncestryRefusal(owner, chainProbe(chain), 500)).toBe(REFUSAL);
  });

  test("a revisited pid is refused", () => {
    const probe = chainProbe({
      500: { executable: "/bin/zsh", parent: 400 },
      400: { executable: "/bin/zsh", parent: 500 },
    });
    expect(proposalAncestryRefusal(owner, probe, 500)).toBe(REFUSAL);
  });

  test("more than 64 steps is refused", () => {
    const chain: Record<number, { executable: string; parent: number }> = {};
    let pid = 1000;
    for (let next = 999; next > 900; next--) {
      chain[pid] = { executable: "/bin/zsh", parent: next };
      pid = next;
    }
    expect(proposalAncestryRefusal(owner, chainProbe(chain), 1000)).toBe(REFUSAL);
  });

  test("an unreadable command process itself is refused", () => {
    const probe = chainProbe({ 500: undefined });
    expect(proposalAncestryRefusal(owner, probe, 500)).toBe(REFUSAL);
  });
});

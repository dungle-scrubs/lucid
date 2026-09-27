import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeBinding } from "../../src/protocol/connection.js";
import {
  claimNativeProposal,
  NATIVE_PROPOSAL_TTL_MS,
  PROPOSAL_MARKERS,
  proposalNonces,
  saveNativeProposal,
} from "../../src/store/native-proposals.js";

const binding = (iface: "claude-cli" | "pi-cli"): NativeBinding => ({
  generation: crypto.randomUUID(),
  harness: iface === "pi-cli" ? "pi" : "claude",
  interface: iface,
  nativeSessionId: "pi-session-01",
  owner: { executable: "/usr/local/bin/runtime", pid: 4242, startedAt: "4242:1" },
  registrationId: crypto.randomUUID(),
  workingDirectory: "/tmp/work",
});

test("a pi-cli proposal saves and claims under its own interface folder", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-pi-proposal-"));
  try {
    const registration = binding("pi-cli");
    const saved = saveNativeProposal(root, registration, {
      kind: "listen",
      conversationId: "pi-record",
    });
    const proposals = readdirSync(join(root, ".registrations", "pi-cli", "proposals"));
    expect(proposals).toEqual([`${saved.nonce}.json`]);
    expect(claimNativeProposal(root, "pi-cli", saved.nonce)).toMatchObject({
      nonce: saved.nonce,
      operation: { kind: "listen", conversationId: "pi-record" },
      registrationId: registration.registrationId,
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("markers are per interface: a Claude marker is not a Pi nonce and the reverse", () => {
  const claudeText = `${PROPOSAL_MARKERS["claude-cli"]}${crypto.randomUUID()}`;
  const piText = `${PROPOSAL_MARKERS["pi-cli"]}${crypto.randomUUID()}`;
  expect(proposalNonces("claude-cli", `${claudeText}\n${piText}`)).toHaveLength(1);
  expect(proposalNonces("pi-cli", `${claudeText}\n${piText}`)).toHaveLength(1);
  const [claudeNonce] = proposalNonces("claude-cli", claudeText);
  const [piNonce] = proposalNonces("pi-cli", piText);
  expect(claudeNonce).not.toBe(piNonce);
});

test("claiming consumes a proposal and an expired proposal is never committed", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-pi-proposal-ttl-"));
  try {
    const registration = binding("pi-cli");
    const operation = { conversationId: "pi-record", kind: "bind" } as const;
    const saved = saveNativeProposal(root, registration, operation, 1_000);
    expect(
      claimNativeProposal(root, "pi-cli", saved.nonce, 1_000 + NATIVE_PROPOSAL_TTL_MS + 1),
    ).toBeNull();
    const fresh = saveNativeProposal(root, registration, operation);
    expect(claimNativeProposal(root, "pi-cli", fresh.nonce)).toMatchObject({ nonce: fresh.nonce });
    expect(claimNativeProposal(root, "pi-cli", fresh.nonce)).toBeNull();
    expect(claimNativeProposal(root, "claude-cli", fresh.nonce)).toBeNull();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("saving refuses a registration whose interface has no proposal store", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-pi-proposal-iface-"));
  try {
    expect(() =>
      saveNativeProposal(
        root,
        { ...binding("pi-cli"), interface: "codex-cli" },
        {
          kind: "listen",
          conversationId: "pi-record",
        },
      ),
    ).toThrow(/codex-cli/);
    expect(() => readdirSync(join(root, ".registrations"))).toThrow(/ENOENT/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

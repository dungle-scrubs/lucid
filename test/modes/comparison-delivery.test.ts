import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHcnRunner } from "../../src/harness/hcn-runner.js";
import { HCN_MIN_VERSION } from "../../src/harness/version.js";
import type { ComparisonHold } from "../../src/modes/comparison-delivery.js";
import { createComparisonDelivery } from "../../src/modes/comparison-delivery.js";
import { hostSeamFor, openHeadlessSession, openHeadlessTurns } from "../../src/modes/host.js";
import { deliverFirstQueued } from "../../src/modes/interactive-host.js";
import { encodeAnnotationBatch } from "../../src/protocol/annotations.js";
import { comparisonMetadata } from "../../src/protocol/comparison-note.js";
import { readContentSource } from "../../src/protocol/content-comparison.js";
import type { Frame } from "../../src/protocol/frames.js";
import { openWriter } from "../../src/store/conversation-host.js";
import type { ArtifactVersion } from "../../src/store/log.js";
import { hashArtifactBytes } from "../../src/store/log.js";
import {
  createConversationRecord,
  openConversation,
  viewConversation,
} from "../../src/store/store.js";
import { FakeHcnProcess, fakeSpawner } from "../harness/fakes.js";
import { attach } from "../protocol/helpers.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const artifact = (
  version: number,
  bytes = `<p>Saved words at version ${version}.</p>`,
): ArtifactVersion => ({
  artifactId: "doc",
  at: 1000,
  author: "agent",
  bytes,
  contentType: "text/html",
  hash: hashArtifactBytes(bytes),
  version,
});
const note = (source: ArtifactVersion, reviewed: ArtifactVersion, earlierVersion = 1): string => {
  const p = readContentSource(source.bytes).passages[0];
  if (!p) throw new Error("test passage missing");
  return encodeAnnotationBatch({
    artifactId: "doc",
    version: source.version,
    comparison: { earlierVersion, reviewedHash: reviewed.hash, reviewedVersion: reviewed.version },
    notes: [
      {
        note: "Bring back this wording and keep the current additions",
        spots: [
          {
            author: p.author,
            id: p.id,
            snippet: p.text,
            selectors: p.selectors,
            sourceVersion: source.version,
            sourceHash: source.hash,
          },
        ],
      },
    ],
  });
};
const record = () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-comparison-"));
  roots.push(root);
  const { secret } = createConversationRecord(root, "comparison");
  const dir = join(root, "comparison");
  return { dir, root, secret };
};
const flush = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 10));
};

describe("comparison admission at the shared append boundary", () => {
  test("fresh provenance and reviewed head are checked on every admission; accepted replay precedes both", () => {
    const { dir } = record();
    const a = openWriter(dir),
      b = openWriter(dir);
    const v1 = artifact(1),
      v2 = artifact(2);
    a.writeArtifact(v1);
    a.writeArtifact(v2);
    const text = note(v1, v2);
    expect(b.submitInput({ id: "once", text })).toMatchObject({ verdict: "accepted" });
    const v3 = artifact(3);
    a.writeArtifact(v3);
    expect(b.submitInput({ id: "once", text })).toMatchObject({ verdict: "accepted" });
    expect(b.submitInput({ id: "fresh", text })).toMatchObject({
      verdict: "refused",
      issue: "E-COMP-02",
    });
    expect(b.enqueueInput({ id: "source-path", text, mode: "queue" })).toMatchObject({
      verdict: "refused",
      issue: "E-COMP-02",
    });
    expect(b.submitInput({ id: "once", text: `${text}\nchanged` })).toMatchObject({
      verdict: "refused",
      issue: "E-COMP-06",
    });
    expect(viewConversation(dir).transcript.inputs.map((i) => i.id)).toEqual(["once"]);
    a.close();
    b.close();
  });
  test("source outside a refreshed pair remains valid, arbitrary element and hash claims do not", () => {
    const { dir } = record();
    const host = openWriter(dir);
    const versions = [artifact(1), artifact(2), artifact(3), artifact(4)];
    for (const v of versions) host.writeArtifact(v);
    const text = note(versions[1] as ArtifactVersion, versions[3] as ArtifactVersion);
    expect(host.submitInput({ id: "retained-source", text }).verdict).toBe("accepted");
    for (const [id, candidate] of [
      ["bad-id", text.replace('"id":"e1"', '"id":"e200"')],
      ["bad-source-hash", text.replace('"sourceHash":"', '"sourceHash":"bad')],
      ["wrong-quote", text.replace('"exact":"Saved', '"exact":"Wrong')],
      ["bad-version", text.replace('"sourceVersion":2', '"sourceVersion":1')],
      ["wrong-offset", text.replace('"start":0', '"start":1')],
    ])
      expect(host.submitInput({ id: id as string, text: candidate as string })).toMatchObject({
        verdict: "refused",
        issue: "E-COMP-03",
      });
    expect(host.enqueueInput({ id: "wrong-mode", text, mode: "steer" }).verdict).toBe("refused");
    host.close();
  });
  test("legacy inputs and unknown extension fields remain readable; known malformed extensions are refused", () => {
    const { dir } = record();
    const host = openWriter(dir);
    const a = artifact(1),
      b = artifact(2);
    host.writeArtifact(a);
    host.writeArtifact(b);
    expect(host.submitInput({ id: "plain", text: 'What does "comparison" mean?' }).verdict).toBe(
      "accepted",
    );
    const text = note(a, b).replace('"comparison":{', '"future":true,"comparison":{"future":42,');
    expect(host.submitInput({ id: "future", text }).verdict).toBe("accepted");
    expect(
      comparisonMetadata(note(a, b).replace('"comparison":{', '"comparison":null,"unused":{')).kind,
    ).toBe("invalid");
    expect(
      comparisonMetadata(note(a, b).replace('"quote":{', '"quote":null,"unused":{')).kind,
    ).toBe("invalid");
    host.close();
  });
});

describe("bounded preparation", () => {
  test("every failure cause holds with guidance, and only a newer head or a new participation retries", () => {
    const old = artifact(1),
      reviewed = artifact(2);
    const text = note(old, reviewed);
    let head = 2,
      capable = false,
      reads = 0;
    let current: ArtifactVersion | null = reviewed;
    const holds: ComparisonHold[] = [];
    const deps = {
      get capable() {
        return capable;
      },
      head: () => head,
      snapshot: () => {
        reads++;
        return { head, artifact: current };
      },
      hold: (event: ComparisonHold) => holds.push(event),
      documentLimit: 100,
    };
    const delivery = createComparisonDelivery(deps);
    expect(delivery.prepare("input", text).kind).toBe("held");
    expect(holds[0]?.message).toContain("cannot receive");
    capable = true;
    delivery.prepare("input", text);
    expect(reads).toBe(0);
    head = 3;
    current = null;
    delivery.prepare("input", text);
    expect(holds.at(-1)?.message).toContain("unavailable");
    expect(reads).toBe(1);
    delivery.prepare("input", text);
    expect(reads).toBe(1);
    head = 4;
    current = artifact(4, `<p>${"x".repeat(150)}</p>`);
    delivery.prepare("input", text);
    expect(holds.at(-1)?.message).toContain("too large");
    current = artifact(4);
    delivery.prepare("input", text);
    expect(reads).toBe(2);
    const attached = createComparisonDelivery(deps);
    const ready = attached.prepare("input", text);
    expect(ready.kind).toBe("ready");
    if (ready.kind === "ready") {
      expect(ready.prompt).toContain("Dispatch version: 4");
      expect(ready.prompt).toContain(JSON.stringify(current.bytes));
      expect(ready.prompt).not.toContain("set `replaces` to the `version` it names");
    }
    expect(holds).toHaveLength(3);
  });
  test("busy, hash mismatch, older context and transport limits never substitute or truncate", () => {
    const a = artifact(1),
      b = artifact(2);
    const text = note(a, b);
    const holds: ComparisonHold[] = [];
    for (const snapshot of [
      () => {
        throw new Error("busy");
      },
      () => ({ head: 1, artifact: a }),
      () => ({ head: 2, artifact: { ...b, hash: "0".repeat(64) } }),
    ]) {
      const delivery = createComparisonDelivery({
        capable: true,
        head: () => 2,
        snapshot,
        hold: (e) => holds.push(e),
      });
      expect(delivery.prepare("input", text).kind).toBe("held");
    }
    const large = createComparisonDelivery({
      capable: true,
      head: () => 2,
      snapshot: () => ({ head: 2, artifact: b }),
      promptLimit: 10,
      hold: (e) => holds.push(e),
    });
    expect(large.prepare("input", text).kind).toBe("held");
    expect(holds.at(-1)?.message).toContain("too large");
  });
});

for (const mode of ["session", "turn"] as const) {
  test(`${mode}: held note is skipped, ordinary input keeps its identity, a newer head releases the original note`, async () => {
    const { dir, secret } = record();
    let receive: (frame: Frame) => void = () => {};
    const host = openConversation(dir, {
      now: () => 1000,
      presence: () => undefined,
      executorLease: () => true,
      onRecord: () => {},
      onEffect: (e) => {
        if (e.type === "send") receive(e.frame);
      },
    });
    const a = artifact(1),
      b = artifact(2);
    host.writeArtifact(a);
    host.writeArtifact(b);
    const proc = new FakeHcnProcess(),
      nextProc = new FakeHcnProcess();
    const spawner = fakeSpawner([proc, nextProc]);
    let busy = true,
      attempts = 0,
      turn = 0;
    const seam = hostSeamFor(host);
    const common = {
      conversationId: "comparison",
      harness: "claude" as const,
      secret,
      runner: createHcnRunner({ spawn: spawner.spawn, bin: "/fake/hcn" }),
      mintTurnId: () => `turn-${++turn}`,
      sendFrame: (frame: Frame) => host.handleFrame(JSON.stringify(frame)),
      host: {
        ...seam,
        comparisonSnapshot: (id: string) => {
          attempts++;
          if (busy) throw new Error("synthetic busy");
          return host.comparisonSnapshot(id);
        },
      },
    };
    const source =
      mode === "session"
        ? openHeadlessSession({ ...common, sessionId: "eb04301d-8756-4a8b-ae3e-aac0e71f7265" })
        : openHeadlessTurns(common);
    receive = source.receive;
    if (mode === "session")
      proc.emit({
        kind: "session",
        sessionId: "eb04301d-8756-4a8b-ae3e-aac0e71f7265",
        harness: "claude",
        hcn: HCN_MIN_VERSION,
        escalateQuestions: true,
      });
    try {
      expect(host.submitInput({ id: "historical", text: note(a, b) }).verdict).toBe("accepted");
      await flush();
      expect(host.transcript().inputs.find((i) => i.id === "historical")?.status).toBe("queued");
      expect(attempts).toBe(1);
      source.recordChanged?.();
      source.receive({ kind: "credit", epoch: host.state().epoch, tokens: 1 });
      await flush();
      expect(attempts).toBe(1);
      host.enqueueInput({ id: "ordinary", text: "ordinary later input", mode: "queue" });
      await flush();
      if (mode === "session") {
        expect(proc.commands.some((c) => c.id === "ordinary")).toBe(true);
        proc.emit({ kind: "disposition", id: "ordinary", disposition: "started" });
        proc.emit({ kind: "turn", turnId: "native-ordinary", id: "ordinary" });
      }
      expect(mode === "session" ? proc.writes.join("") : proc.writes.join("")).toContain(
        "ordinary later input",
      );
      await flush();
      busy = false;
      source.recordChanged?.();
      await flush();
      expect(attempts).toBe(1);
      const current = artifact(3, "<p>Current human additions must survive.</p>");
      host.writeArtifact({ ...current, author: "human" });
      source.recordChanged?.();
      await flush();
      expect(attempts).toBe(1); // Recovery cannot interrupt the ordinary turn.
      proc.emit({ kind: "message", role: "assistant", text: "ordinary answer" });
      proc.emit({ kind: "done", exitCode: 0, cause: "clean" });
      if (mode === "turn") proc.exit(0);
      await flush();
      expect(host.transcript().inputs.find((i) => i.id === "ordinary")?.status).toBe("applied");
      const running = mode === "session" ? proc : nextProc;
      const deliveredPrompt =
        mode === "session" ? running.writes.join("") : (nextProc.writes.join("") ?? "");
      expect(deliveredPrompt).toContain("Dispatch version: 3");
      expect(deliveredPrompt).toContain("Current human additions must survive");
      expect(attempts).toBe(2);
      if (mode === "session") {
        proc.emit({ kind: "disposition", id: "historical", disposition: "started" });
        proc.emit({ kind: "turn", turnId: "native-historical", id: "historical" });
      }
      // A human save during generation makes the dispatch base stale. The
      // ordinary emission guard refuses it; a later full revision uses v4.
      host.writeArtifact(artifact(4, "<p>Newest human addition.</p>"));
      running.emit({
        kind: "message",
        role: "assistant",
        text: '```lucid-artifact\n{"id":"doc","replaces":3,"contentType":"text/html"}\n<p>Stale revision.</p>\n```',
      });
      await flush();
      expect(host.artifactHeads().get("doc")).toBe(4);
      running.emit({
        kind: "message",
        role: "assistant",
        text: '```lucid-artifact\n{"id":"doc","replaces":4,"contentType":"text/html"}\n<p>Newest human addition.</p><p>Earlier wording restored.</p>\n```',
      });
      running.emit({ kind: "done", exitCode: 0, cause: "clean" });
      if (mode === "turn") running.exit(0);
      await flush();
      expect(host.transcript().inputs.find((i) => i.id === "historical")?.status).toBe("applied");
      expect(host.artifactHeads().get("doc")).toBe(5);
      expect(host.readArtifact("doc", 4)?.bytes).toBe("<p>Newest human addition.</p>");
      expect(host.readArtifact("doc", 5)?.bytes).toContain("Newest human addition.");
      expect(host.transcript().events.filter((e) => e.event.code === "E-COMP-07")).toHaveLength(1);
    } finally {
      source.close();
      host.close();
    }
  });
}

for (const mode of ["session", "turn"] as const) {
  test(`${mode}: explicit reattachment retries a repaired same head once and preserves acceptance order`, async () => {
    const { dir, secret } = record();
    let receive: (frame: Frame) => void = () => {};
    const host = openConversation(dir, {
      now: () => 1000,
      presence: () => undefined,
      executorLease: () => true,
      onRecord: () => {},
      onEffect: (effect) => {
        if (effect.type === "send") receive(effect.frame);
      },
    });
    const a = artifact(1),
      b = artifact(2);
    host.writeArtifact(a);
    host.writeArtifact(b);
    host.submitInput({ id: "first", text: note(a, b) });
    host.submitInput({ id: "second", text: note(a, b).replace("Bring back", "Consider") });
    let busy = true,
      attempts = 0,
      turns = 0;
    const p1 = new FakeHcnProcess(),
      p2 = new FakeHcnProcess(),
      p3 = new FakeHcnProcess();
    const spawn = fakeSpawner(mode === "session" ? [p1, p2] : [p2, p3]);
    const common = {
      conversationId: "comparison",
      harness: "claude" as const,
      secret,
      runner: createHcnRunner({ spawn: spawn.spawn, bin: "/fake/hcn" }),
      mintTurnId: () => `reattach-${++turns}`,
      sendFrame: (frame: Frame) => host.handleFrame(JSON.stringify(frame)),
      host: {
        ...hostSeamFor(host),
        comparisonSnapshot: (id: string) => {
          attempts++;
          if (busy) throw new Error("synthetic unavailable");
          return host.comparisonSnapshot(id);
        },
      },
    };
    const open = () =>
      mode === "session"
        ? openHeadlessSession({ ...common, sessionId: "eb04301d-8756-4a8b-ae3e-aac0e71f7265" })
        : openHeadlessTurns(common);
    const announce = (p: FakeHcnProcess) => {
      if (mode === "session")
        p.emit({
          kind: "session",
          sessionId: "eb04301d-8756-4a8b-ae3e-aac0e71f7265",
          harness: "claude",
          hcn: HCN_MIN_VERSION,
          escalateQuestions: true,
        });
    };
    let source = open();
    receive = source.receive;
    announce(p1);
    try {
      await flush();
      expect(attempts).toBe(2);
      busy = false;
      source.recordChanged?.();
      await flush();
      expect(attempts).toBe(2);
      source.close();
      await flush();
      source = open();
      receive = source.receive;
      announce(p2);
      await flush();
      const firstPrompt =
        mode === "session" ? p2.commands.find((c) => c.id === "first")?.text : p2.writes.join("");
      expect(firstPrompt).toContain("Dispatch version: 2");
      if (mode === "session") {
        p2.emit({ kind: "disposition", id: "first", disposition: "started" });
        p2.emit({ kind: "turn", turnId: "first-native", id: "first" });
      }
      p2.emit({ kind: "message", role: "assistant", text: "First delivered" });
      p2.emit({ kind: "done", exitCode: 0, cause: "clean" });
      if (mode === "turn") p2.exit(0);
      await flush();
      const secondPrompt =
        mode === "session" ? p2.commands.find((c) => c.id === "second")?.text : p3.writes.join("");
      expect(secondPrompt).toContain("Dispatch version: 2");
      expect(secondPrompt).toContain("Consider");
      expect(attempts).toBe(4);
      expect(host.transcript().inputs.map((i) => i.id)).toEqual(["first", "second"]);
      expect(host.transcript().events.filter((e) => e.event.code === "E-COMP-07")).toHaveLength(2);
    } finally {
      source.close();
      host.close();
    }
  });
}

test("turn resume refusal preserves comparison input without an automatic fresh spawn", async () => {
  const { dir, secret } = record();
  let receive: (frame: Frame) => void = () => {};
  const host = openConversation(dir, {
    now: () => 1000,
    presence: () => undefined,
    executorLease: () => true,
    onRecord: () => {},
    onEffect: (effect) => {
      if (effect.type === "send") receive(effect.frame);
    },
  });
  const a = artifact(1),
    b = artifact(2);
  host.writeArtifact(a);
  host.writeArtifact(b);
  const stale = new FakeHcnProcess(),
    fresh = new FakeHcnProcess();
  const spawn = fakeSpawner([stale, fresh]);
  let turn = 0;
  const source = openHeadlessTurns({
    conversationId: "comparison",
    harness: "claude",
    secret,
    resume: "eb04301d-8756-4a8b-ae3e-aac0e71f7265",
    runner: createHcnRunner({ spawn: spawn.spawn, bin: "/fake/hcn" }),
    mintTurnId: () => `resume-${++turn}`,
    sendFrame: (frame: Frame) => host.handleFrame(JSON.stringify(frame)),
    host: hostSeamFor(host),
  });
  receive = source.receive;
  try {
    host.submitInput({ id: "historical", text: note(a, b) });
    await flush();
    expect(stale.writes.join("")).toContain("Dispatch version: 2");
    host.writeArtifact(artifact(3, "<p>Saved while resume was being attempted.</p>"));
    stale.emit({ kind: "failure", class: "rejected", message: "synthetic unknown session" });
    stale.exit(2);
    await flush();
    expect(spawn.calls).toHaveLength(1);
    expect(host.transcript().inputs.find((i) => i.id === "historical")?.status).toBe("queued");
    expect(host.transcript().events.some((e) => e.event.code === "E-HUB-05")).toBe(true);
    expect(host.transcript().inputs).toHaveLength(1);
  } finally {
    source.close();
    host.close();
  }
});

test("hooks: durable holds survive hook processes, newer content releases full context, new attachment permits same-head repair", () => {
  const { dir, secret } = record();
  const host = openWriter(dir, { presence: () => true });
  const a = artifact(1),
    b = artifact(2);
  host.writeArtifact(a);
  host.writeArtifact(b);
  expect(
    host.handleFrame(
      JSON.stringify(attach({ conversationId: "comparison", secret, profile: "interactive" })),
    ).verdict,
  ).toBe("accepted");
  host.submitInput({ id: "historical", text: note(a, b) });
  const output: string[] = [];
  const capture = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  try {
    expect(deliverFirstQueued(dir, { rung: "observe", promptLimit: 100_000 })).toMatchObject({
      delivered: 0,
    });
    expect(deliverFirstQueued(dir, { rung: "hooks", promptLimit: 100_000 })).toMatchObject({
      delivered: 0,
    });
    host.enqueueInput({
      id: "later-ordinary",
      text: "A later ordinary message with all its words",
      mode: "queue",
    });
    expect(deliverFirstQueued(dir, { promptLimit: 100_000 })).toMatchObject({ delivered: 1 });
    expect(JSON.parse(output.at(-1) ?? "{}").reason).toContain(
      "A later ordinary message with all its words",
    );
    expect(
      viewConversation(dir).transcript.inputs.find((i) => i.id === "later-ordinary")?.status,
    ).toBe("applied");
    expect(deliverFirstQueued(dir, { promptLimit: 100_000 })).toMatchObject({ delivered: 0 });
    expect(
      viewConversation(dir).transcript.events.filter((e) => e.event.code === "E-COMP-07"),
    ).toHaveLength(1);
    host.writeArtifact(artifact(3));
    expect(deliverFirstQueued(dir, { rung: "hooks", promptLimit: 10 })).toMatchObject({
      delivered: 0,
    });
    expect(
      viewConversation(dir)
        .transcript.events.filter((e) => e.event.code === "E-COMP-07")
        .at(-1)?.event.message,
    ).toContain("too large");
    const fresh = openWriter(dir, { presence: () => true });
    fresh.handleFrame(
      JSON.stringify({ kind: "detach", epoch: fresh.state().epoch, reason: "yield" }),
    );
    fresh.handleFrame(
      JSON.stringify(attach({ conversationId: "comparison", secret, profile: "interactive" })),
    );
    expect(deliverFirstQueued(dir, { promptLimit: 100_000 })).toMatchObject({ delivered: 1 });
    const sent = JSON.parse(output.at(-1) ?? "{}").reason as string;
    expect(sent).toContain("[lucid artifact protocol]");
    expect(sent).toContain("Dispatch version: 3");
    expect(sent).toContain(JSON.stringify(artifact(3).bytes));
    expect(viewConversation(dir).transcript.inputs.find((i) => i.id === "historical")?.status).toBe(
      "applied",
    );
    fresh.close();
  } finally {
    capture.mockRestore();
    host.close();
  }
});

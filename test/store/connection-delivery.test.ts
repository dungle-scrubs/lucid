import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../../src/cli/dispatch.js";
import { conversations } from "../../src/cli/record-addressing.js";
import { readProcessOwner } from "../../src/process-owner.js";
import type { ConnectionFact, NativeBinding } from "../../src/protocol/connection.js";
import type { ProcessOwner } from "../../src/protocol/process-owner.js";
import { observeConnection, readConnection } from "../../src/store/connection-view.js";
import {
  createConversationHost,
  openWriter,
  viewConversation,
} from "../../src/store/conversation-host.js";
import { registerNativeSession } from "../../src/store/native-registration.js";
import { acquirePresence, type PresenceHandle } from "../../src/store/presence.js";
import { createConversationRecord } from "../../src/store/store.js";
import { attach } from "../protocol/helpers.js";

interface BoundFixture {
  readonly acquire: () => void;
  readonly close: () => void;
  readonly controls: {
    lease: PresenceHandle | undefined;
    now: number;
    probe: (owner: ProcessOwner) => boolean | undefined;
    registration: NativeBinding;
  };
  readonly enableFact: () => Extract<ConnectionFact, { kind: "listener-enabled" }>;
  readonly host: ReturnType<typeof createConversationHost>;
  readonly paths: ReturnType<typeof createConversationRecord>["paths"];
  readonly status: () => ReturnType<typeof readConnection>;
}

function prepareOffer(
  host: BoundFixture["host"],
  participationId: string,
  inputId: string,
): Extract<ConnectionFact, { kind: "offer-started" }> {
  const snapshot = host.captureDispatch(inputId, 0);
  return {
    actionId: crypto.randomUUID(),
    kind: "offer-started",
    offer: {
      attempt: 1,
      context: {
        digest: snapshot.context.digest,
        from: snapshot.context.from,
        through: snapshot.context.through,
      },
      epoch: snapshot.epoch,
      id: crypto.randomUUID(),
      inputId,
      participationId,
      turnId: crypto.randomUUID(),
    },
    stamp: snapshot.stamp,
  };
}

function returningRegistration(binding: NativeBinding): NativeBinding {
  return {
    ...binding,
    generation: crypto.randomUUID(),
    registrationId: crypto.randomUUID(),
    owner: { ...binding.owner, pid: 456 },
  };
}

function boundFixture(bind = true): BoundFixture {
  const executorOwner = readProcessOwner(process.pid);
  if (!executorOwner) throw new Error("Cannot verify this test process");
  const root = mkdtempSync(join(tmpdir(), "lucid-listener-"));
  const { paths } = createConversationRecord(root, "feedback", { workingDirectory: root });
  const controls: {
    lease: PresenceHandle | undefined;
    now: number;
    probe: (owner: ProcessOwner) => boolean | undefined;
    registration: NativeBinding;
  } = {
    lease: undefined,
    now: 1000,
    probe: () => true,
    registration: {
      generation: crypto.randomUUID(),
      harness: "codex",
      interface: "codex-cli",
      nativeSessionId: "native-one",
      owner: { executable: "/native/codex", pid: 123, startedAt: "123:456" },
      registrationId: crypto.randomUUID(),
      workingDirectory: root,
    },
  };
  const host = createConversationHost(paths.dir, {
    connectionAuthority: () => controls.registration,
    executorLease: () => controls.lease?.held() ?? false,
    now: () => controls.now,
    onEffect: () => {},
    onRecord: () => {},
    ownerPresence: (owner) => controls.probe(owner),
    presence: () => undefined,
  });
  const close = (): void => {
    try {
      host.close();
    } finally {
      try {
        controls.lease?.release();
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    }
  };
  try {
    if (bind)
      expect(
        host.writeConnection({
          actionId: crypto.randomUUID(),
          binding: controls.registration,
          kind: "bound",
        }).verdict,
      ).toBe("accepted");
  } catch (cause) {
    close();
    throw cause;
  }
  return {
    acquire: () => {
      controls.lease = acquirePresence(paths.dir, "feedback");
    },
    close,
    controls,
    enableFact: () => ({
      actionId: crypto.randomUUID(),
      kind: "listener-enabled" as const,
      source: "explicit",
      participation: {
        epoch: host.state().epoch + 1,
        executorOwner,
        expiresAt: controls.now + 45_000,
        id: crypto.randomUUID(),
        registration: controls.registration,
      },
    }),
    host,
    paths,
    status: () =>
      readConnection(paths.dir, { now: () => controls.now, ownerPresence: controls.probe }),
  };
}

test("listening requires an executor lease and expires without implying native departure", () => {
  const f = boundFixture();
  try {
    const fact = f.enableFact();
    const refused = f.host.writeConnection(fact);
    expect(refused.verdict).toBe("refused");
    if (refused.verdict === "refused") expect(refused.issue).toBe("executor-required");
    f.acquire();
    expect(f.host.writeConnection(fact).verdict).toBe("accepted");
    expect(f.status().state).toBe("listening");
    f.controls.now = 46000;
    expect(f.status()).toMatchObject({
      message: "Your interactive session is still open. Tell it to resume listening.",
      reason: "listener-expired",
      state: "not-listening",
    });
  } finally {
    f.close();
  }
});

test("a lost listener lease stops readiness before its wait deadline while the native owner stays open", () => {
  const f = boundFixture();
  try {
    f.acquire();
    expect(f.host.writeConnection(f.enableFact()).verdict).toBe("accepted");
    expect(f.status().state).toBe("listening");
    f.controls.lease?.release();
    expect(f.status()).toMatchObject({ state: "not-listening", reason: "listener-not-ready" });
  } finally {
    f.close();
  }
});

test("a returning listener waits until every other native owner is confirmed gone", () => {
  const f = boundFixture();
  try {
    const binding = f.controls.registration;
    f.controls.registration = returningRegistration(binding);
    let previousOwner: boolean | undefined = true;
    f.controls.probe = (owner) => (owner.pid === 123 ? previousOwner : true);
    f.acquire();
    const fact = f.enableFact();
    const conflict = f.host.writeConnection(fact);
    expect(conflict.verdict).toBe("refused");
    if (conflict.verdict === "refused") expect(conflict.issue).toBe("connection-conflict");
    previousOwner = undefined;
    const unknown = f.host.writeConnection(fact);
    expect(unknown.verdict).toBe("refused");
    if (unknown.verdict === "refused") expect(unknown.issue).toBe("connection-unverified");
    previousOwner = false;
    expect(f.host.writeConnection(fact).verdict).toBe("accepted");
  } finally {
    f.close();
  }
});

test("a prepared offer selects saved inputs in order without implying receipt and fences another listener", () => {
  const f = boundFixture();
  try {
    f.acquire();
    const listener = f.enableFact();
    expect(f.host.writeConnection(listener).verdict).toBe("accepted");
    expect(
      f.host.acceptInput({ id: "ordinary", mode: "queue", text: "First feedback" }).verdict,
    ).toBe("accepted");
    expect(
      f.host.acceptInput(
        { id: "managed", mode: "queue", text: "Second feedback" },
        { managed: true },
      ).verdict,
    ).toBe("accepted");
    const prepare = (inputId: string) => prepareOffer(f.host, listener.participation.id, inputId);
    const later = f.host.writeConnection(prepare("managed"));
    expect(later.verdict).toBe("refused");
    if (later.verdict === "refused") expect(later.issue).toBe("execution-ineligible");
    const first = prepare("ordinary");
    expect(f.host.writeConnection(first).verdict).toBe("accepted");
    f.controls.lease?.release();
    expect(f.host.state().connection?.offers[first.offer.id]?.kind).toBe("sending");
    expect(Object.hasOwn(f.host.state().appliedInputs, "ordinary")).toBe(false);
    f.acquire();
    const blocked = f.host.writeConnection(f.enableFact());
    expect(blocked.verdict).toBe("refused");
    if (blocked.verdict === "refused") expect(blocked.issue).toBe("execution-blocked");
  } finally {
    f.close();
  }
});

test("a legacy interactive attachment cannot bypass connection admission on a bound record", () => {
  const f = boundFixture();
  try {
    f.acquire();
    const result = f.host.handleFrame(
      JSON.stringify(
        attach({
          conversationId: "feedback",
          profile: "interactive",
          secret: f.host.state().secret,
        }),
      ),
    );
    expect(result.verdict).toBe("refused");
    if (result.verdict === "refused") expect(result.issue).toBe("connection-not-admitted");
    expect(f.host.state().attachment).toBeNull();
  } finally {
    f.close();
  }
});

test("receipt requires the offered native generation, needs no executor lease, and is idempotent", () => {
  const f = boundFixture();
  try {
    f.acquire();
    const listener = f.enableFact();
    expect(f.host.writeConnection(listener).verdict).toBe("accepted");
    expect(
      f.host.acceptInput(
        { id: "feedback-one", mode: "queue", text: "Handle this feedback" },
        { managed: true },
      ).verdict,
    ).toBe("accepted");
    const prepared = prepareOffer(f.host, listener.participation.id, "feedback-one");
    const { offer } = prepared;
    expect(f.host.writeConnection(prepared).verdict).toBe("accepted");
    f.controls.lease?.release();
    const receipt = {
      actionId: crypto.randomUUID(),
      kind: "receipt-confirmed",
      epoch: offer.epoch,
      offerId: offer.id,
      participationId: offer.participationId,
    };
    const current = f.controls.registration;
    f.controls.registration = { ...current, generation: crypto.randomUUID() };
    const wrong = f.host.writeConnection(receipt);
    expect(wrong.verdict).toBe("refused");
    if (wrong.verdict === "refused") expect(wrong.issue).toBe("connection-unverified");
    f.controls.registration = current;
    expect(f.host.writeConnection(receipt).verdict).toBe("accepted");
    expect(f.host.state().connection?.offers[offer.id]?.kind).toBe("received");
    expect(Object.hasOwn(f.host.state().appliedInputs, offer.inputId)).toBe(true);
    const seq = f.host.state().seq;
    expect(f.host.writeConnection(receipt).verdict).toBe("accepted");
    expect(f.host.state().seq).toBe(seq);
    const stale = f.host.writeConnection({
      ...receipt,
      actionId: crypto.randomUUID(),
      epoch: offer.epoch + 1,
    });
    expect(stale.verdict).toBe("refused");
    if (stale.verdict === "refused") expect(stale.issue).toBe("receipt-stale");
  } finally {
    f.close();
  }
});

test("a correlated question requires receipt and records one outcome before listening resumes", () => {
  const f = boundFixture();
  try {
    f.acquire();
    const listener = f.enableFact();
    expect(f.host.writeConnection(listener).verdict).toBe("accepted");
    expect(
      f.host.acceptInput(
        { id: "feedback-one", mode: "queue", text: "Review the flow" },
        { managed: true },
      ).verdict,
    ).toBe("accepted");
    const prepared = prepareOffer(f.host, listener.participation.id, "feedback-one");
    const { offer } = prepared;
    expect(f.host.writeConnection(prepared).verdict).toBe("accepted");
    f.controls.lease?.release();
    const outcome = {
      actionId: crypto.randomUUID(),
      kind: "offer-outcome",
      epoch: offer.epoch,
      offerId: offer.id,
      participationId: offer.participationId,
      outcome: { kind: "question", text: "Which part should I revise?" },
    };
    const early = f.host.writeConnection(outcome);
    expect(early.verdict).toBe("refused");
    if (early.verdict === "refused") expect(early.issue).toBe("receipt-required");
    expect(
      f.host.writeConnection({
        actionId: crypto.randomUUID(),
        kind: "receipt-confirmed",
        epoch: offer.epoch,
        offerId: offer.id,
        participationId: offer.participationId,
      }).verdict,
    ).toBe("accepted");
    expect(f.host.writeConnection(outcome).verdict).toBe("accepted");
    expect(f.host.state().connection?.offers[offer.id]).toMatchObject({
      kind: "finished",
      outcome: outcome.outcome,
    });
    expect(f.host.state().inFlightInputs).toBe(0);
    expect(f.host.state().questionOpen?.question).toBe(outcome.outcome.text);
    expect(f.host.writeConnection(outcome).verdict).toBe("accepted");
    expect(
      f.host.transcript().events.filter((event) => event.turnId === offer.turnId),
    ).toHaveLength(1);
    f.acquire();
    expect(f.host.writeConnection(f.enableFact()).verdict).toBe("accepted");
  } finally {
    f.close();
  }
});

test("lost ownership preserves delivery and outcome uncertainty instead of reporting a closed connection", () => {
  const f = boundFixture();
  try {
    f.acquire();
    const listener = f.enableFact();
    expect(f.host.writeConnection(listener).verdict).toBe("accepted");
    expect(
      f.host.acceptInput({ id: "feedback-one", mode: "queue", text: "Keep this feedback" }).verdict,
    ).toBe("accepted");
    const prepared = prepareOffer(f.host, listener.participation.id, "feedback-one");
    const { offer } = prepared;
    expect(f.host.writeConnection(prepared).verdict).toBe("accepted");
    f.controls.lease?.release();
    f.controls.probe = () => undefined;
    expect(f.status()).toMatchObject({
      actions: [],
      nativeSessionId: "native-one",
      state: "delivery-uncertain",
    });
    f.controls.probe = () => true;
    expect(
      f.host.writeConnection({
        actionId: crypto.randomUUID(),
        kind: "receipt-confirmed",
        epoch: offer.epoch,
        offerId: offer.id,
        participationId: offer.participationId,
      }).verdict,
    ).toBe("accepted");
    f.controls.probe = () => false;
    expect(f.status()).toMatchObject({
      actions: [],
      nativeSessionId: "native-one",
      state: "outcome-unknown",
    });
    expect(f.host.state().connection?.offers[offer.id]?.kind).toBe("received");
  } finally {
    f.close();
  }
});

test("an artifact revision invalidates a prepared offer without consuming its input", async () => {
  const f = boundFixture();
  try {
    f.acquire();
    const listener = f.enableFact();
    expect(f.host.writeConnection(listener).verdict).toBe("accepted");
    const document = {
      artifactId: "flow",
      author: "agent",
      bytes: "<h1>Before</h1>",
      contentType: "text/html",
      version: 1,
    };
    expect((await f.host.writeArtifact(document)).verdict).toBe("accepted");
    expect(
      f.host.acceptInput({ id: "feedback-one", mode: "queue", text: "Review this document" })
        .verdict,
    ).toBe("accepted");
    const prepared = f.host.captureDispatch("feedback-one", 0);
    const offer = {
      attempt: 1,
      context: prepared.context,
      epoch: prepared.epoch,
      id: crypto.randomUUID(),
      inputId: "feedback-one",
      participationId: listener.participation.id,
      turnId: crypto.randomUUID(),
    };
    expect(
      (await f.host.writeArtifact({ ...document, bytes: "<h1>Current document</h1>", version: 2 }))
        .verdict,
    ).toBe("accepted");
    const stale = f.host.writeConnection({
      actionId: crypto.randomUUID(),
      kind: "offer-started",
      offer,
      stamp: prepared.stamp,
    });
    expect(stale.verdict).toBe("refused");
    if (stale.verdict === "refused") expect(stale.issue).toBe("execution-stale");
    expect(f.host.state().connection?.offers[offer.id]).toBeUndefined();
    expect(f.host.state().inputs.some((input) => input.id === offer.inputId)).toBe(true);
    const current = f.host.captureDispatch(offer.inputId, 0);
    expect(current.artifacts.find((artifact) => artifact.artifactId === "flow")?.bytes).toBe(
      "<h1>Current document</h1>",
    );
    expect(
      f.host.writeConnection({
        actionId: crypto.randomUUID(),
        kind: "offer-started",
        offer: { ...offer, context: current.context },
        stamp: current.stamp,
      }).verdict,
    ).toBe("accepted");
  } finally {
    f.close();
  }
});

test("a control writer can cancel only unsent feedback without taking the listener lease", () => {
  const f = boundFixture();
  const writer = openWriter(f.paths.dir);
  try {
    expect(
      writer.acceptInput({ id: "cancel-first", mode: "queue", text: "Withdraw this" }).verdict,
    ).toBe("accepted");
    expect(
      writer.acceptInput({ id: "send-second", mode: "queue", text: "Keep this" }).verdict,
    ).toBe("accepted");
    const cancel = {
      actionId: crypto.randomUUID(),
      inputId: "cancel-first",
      kind: "input-cancelled",
    };
    expect(writer.writeConnection(cancel).verdict).toBe("accepted");
    expect(writer.transcript().inputs.find((input) => input.id === "cancel-first")?.status).toBe(
      "cancelled",
    );
    const seq = writer.state().seq;
    expect(writer.writeConnection(cancel).verdict).toBe("accepted");
    expect(writer.state().seq).toBe(seq);
    const reused = writer.enqueueInput({
      id: "cancel-first",
      mode: "queue",
      text: "A different request",
    });
    expect(reused.verdict).toBe("refused");
    if (reused.verdict === "refused") expect(reused.issue).toBe("input-id-reused");
    f.acquire();
    const listener = f.enableFact();
    expect(f.host.writeConnection(listener).verdict).toBe("accepted");
    const prepared = prepareOffer(f.host, listener.participation.id, "send-second");
    expect(f.host.writeConnection(prepared).verdict).toBe("accepted");
    const dispatched = writer.writeConnection({
      actionId: crypto.randomUUID(),
      inputId: "send-second",
      kind: "input-cancelled",
    });
    expect(dispatched.verdict).toBe("refused");
    if (dispatched.verdict === "refused") expect(dispatched.issue).toBe("input-already-dispatched");
    expect(f.controls.lease?.held()).toBe(true);
  } finally {
    writer.close();
    f.close();
  }
});

test("status probes every native owner once and cannot hide uncertainty or competing owners behind a live listener", () => {
  const f = boundFixture();
  try {
    const original = f.controls.registration;
    f.controls.registration = returningRegistration(original);
    let previous: boolean | undefined = false;
    const observed: number[] = [];
    f.controls.probe = (owner) => {
      observed.push(owner.pid);
      return owner.pid === original.owner.pid ? previous : true;
    };
    f.acquire();
    expect(f.host.writeConnection(f.enableFact()).verdict).toBe("accepted");
    expect(f.status().state).toBe("listening");
    previous = undefined;
    observed.length = 0;
    expect(f.status().state).toBe("owner-unknown");
    expect(observed.sort()).toEqual([123, 456]);
    previous = true;
    observed.length = 0;
    expect(f.status().state).toBe("owner-conflict");
    expect(observed.sort()).toEqual([123, 456]);
  } finally {
    f.close();
  }
});

test("an interrupted listener stays disabled across later callbacks until explicit resume", () => {
  const f = boundFixture();
  try {
    f.acquire();
    const listener = f.enableFact();
    expect(f.host.writeConnection(listener).verdict).toBe("accepted");
    const disabled = {
      actionId: crypto.randomUUID(),
      epoch: listener.participation.epoch,
      kind: "listener-disabled",
      participationId: listener.participation.id,
      reason: "interrupted",
    };
    expect(f.host.writeConnection(disabled).verdict).toBe("accepted");
    expect(f.status()).toMatchObject({ reason: "listener-disabled", state: "not-listening" });
    f.controls.lease?.release();
    const reader = openWriter(f.paths.dir);
    try {
      expect(reader.state().connection?.listenerId).toBeNull();
    } finally {
      reader.close();
    }
    f.acquire();
    const automatic = f.host.writeConnection({ ...f.enableFact(), source: "continuation" });
    expect(automatic.verdict).toBe("refused");
    if (automatic.verdict === "refused") expect(automatic.issue).toBe("connection-not-admitted");
    expect(f.host.writeConnection({ ...f.enableFact(), source: "explicit" }).verdict).toBe(
      "accepted",
    );
    expect(f.status().state).toBe("listening");
    const stale = f.host.writeConnection({ ...disabled, actionId: crypto.randomUUID() });
    expect(stale.verdict).toBe("refused");
    expect(f.status().state).toBe("listening");
  } finally {
    f.close();
  }
});

test("a failed native ownership probe returns an unverified connection without granting readiness", () => {
  const f = boundFixture();
  try {
    f.acquire();
    const before = f.host.state().seq;
    f.controls.probe = () => {
      throw new Error("Process inspection unavailable");
    };
    const result = f.host.writeConnection(f.enableFact());
    expect(result.verdict).toBe("refused");
    if (result.verdict === "refused") expect(result.issue).toBe("connection-unverified");
    expect(f.host.state().seq).toBe(before);
    expect(f.status().state).toBe("owner-unknown");
  } finally {
    f.close();
  }
});

test("publication cannot bind a record while a legacy driver is attached", () => {
  const f = boundFixture(false);
  try {
    f.acquire();
    expect(
      f.host.handleFrame(
        JSON.stringify(
          attach({
            conversationId: "feedback",
            harness: "codex",
            profile: "headless-turn",
            secret: f.host.state().secret,
          }),
        ),
      ).verdict,
    ).toBe("accepted");
    const result = f.host.writeConnection({
      actionId: crypto.randomUUID(),
      binding: f.controls.registration,
      kind: "bound",
    });
    expect(result.verdict).toBe("refused");
    if (result.verdict === "refused") expect(result.issue).toBe("connection-conflict");
    expect(f.host.state().connection).toBeNull();
    expect(f.host.state().attachment?.profile).toBe("headless-turn");
  } finally {
    f.close();
  }
});

test("first binding preserves a record's known native identity after the legacy driver detaches", () => {
  const f = boundFixture(false);
  try {
    f.acquire();
    expect(
      f.host.handleFrame(
        JSON.stringify(
          attach({
            conversationId: "feedback",
            harness: "codex",
            profile: "headless-turn",
            secret: f.host.state().secret,
          }),
        ),
      ).verdict,
    ).toBe("accepted");
    expect(
      f.host.handleFrame(
        JSON.stringify({
          kind: "event",
          epoch: 1,
          n: 1,
          turnId: "legacy-turn",
          event: { kind: "identity", sessionId: "original-native", authority: "harness-minted" },
        }),
      ).verdict,
    ).toBe("accepted");
    expect(
      f.host.handleFrame(JSON.stringify({ kind: "detach", epoch: 1, reason: "shutdown" })).verdict,
    ).toBe("accepted");
    const different = f.host.writeConnection({
      actionId: crypto.randomUUID(),
      binding: f.controls.registration,
      kind: "bound",
    });
    expect(different.verdict).toBe("refused");
    if (different.verdict === "refused") expect(different.issue).toBe("connection-conflict");
    expect(f.host.state().connection).toBeNull();
    f.controls.registration = { ...f.controls.registration, nativeSessionId: "original-native" };
    expect(
      f.host.writeConnection({
        actionId: crypto.randomUUID(),
        binding: f.controls.registration,
        kind: "bound",
      }).verdict,
    ).toBe("accepted");
    expect(f.host.state().nativeSessions.codex?.sessionId).toBe("original-native");
  } finally {
    f.close();
  }
});

test("a live historical owner cannot stand in for the owner of the current listener or offer", () => {
  const f = boundFixture();
  try {
    const original = f.controls.registration;
    f.controls.registration = returningRegistration(original);
    let originalAlive = false;
    let currentAlive = true;
    f.controls.probe = (owner) => (owner.pid === original.owner.pid ? originalAlive : currentAlive);
    f.acquire();
    const listener = f.enableFact();
    expect(f.host.writeConnection(listener).verdict).toBe("accepted");
    originalAlive = true;
    currentAlive = false;
    expect(f.status().state).toBe("not-listening");
    originalAlive = false;
    currentAlive = true;
    expect(
      f.host.acceptInput({ id: "owned-feedback", text: "Review this", mode: "queue" }).verdict,
    ).toBe("accepted");
    const prepared = prepareOffer(f.host, listener.participation.id, "owned-feedback");
    expect(f.host.writeConnection(prepared).verdict).toBe("accepted");
    f.controls.lease?.release();
    originalAlive = true;
    currentAlive = false;
    expect(f.status().state).toBe("delivery-uncertain");
  } finally {
    f.close();
  }
});

test("an unreadable executor lock reports unknown readiness without assuming the session closed", () => {
  const f = boundFixture();
  try {
    f.acquire();
    expect(f.host.writeConnection(f.enableFact()).verdict).toBe("accepted");
    expect(
      observeConnection(f.host.state(), {
        executorPresent: undefined,
        now: f.controls.now,
        ownerPresence: f.controls.probe,
      }),
    ).toMatchObject({ reason: "executor-unverified", state: "owner-unknown" });
    expect(f.host.state().connection?.listenerId).not.toBeNull();
  } finally {
    f.close();
  }
});

test("listener readiness requires the admitted listener process, not only a live native owner and any held lock", () => {
  const f = boundFixture();
  try {
    f.acquire();
    const ownProcess = readProcessOwner(process.pid);
    if (!ownProcess) throw new Error("Cannot verify this test process");
    const fact = f.enableFact();
    const forged = f.host.writeConnection({
      ...fact,
      participation: { ...fact.participation, executorOwner: f.controls.registration.owner },
    });
    expect(forged.verdict).toBe("refused");
    if (forged.verdict === "refused") expect(forged.issue).toBe("connection-unverified");
    expect(
      f.host.writeConnection({
        ...fact,
        participation: { ...fact.participation, executorOwner: ownProcess },
      }).verdict,
    ).toBe("accepted");
    expect(f.status().state).toBe("listening");
    f.controls.probe = (owner) => owner.pid === f.controls.registration.owner.pid;
    expect(f.status()).toMatchObject({ reason: "listener-process-gone", state: "not-listening" });
    expect(f.controls.lease?.held()).toBe(true);
  } finally {
    f.close();
  }
});

test("first binding cannot bypass an unsettled managed attempt after its attachment ends", () => {
  const f = boundFixture(false);
  try {
    f.acquire();
    expect(
      f.host.acceptInput(
        { id: "legacy-work", text: "Finish this", mode: "queue" },
        { managed: true },
      ).verdict,
    ).toBe("accepted");
    expect(
      f.host.handleFrame(
        JSON.stringify(
          attach({
            conversationId: "feedback",
            harness: "codex",
            profile: "headless-turn",
            attachmentOrigin: "automatic",
            capabilities: ["managed-input-v1"],
            secret: f.host.state().secret,
          }),
        ),
      ).verdict,
    ).toBe("accepted");
    expect(
      f.host.writeExecution({
        epoch: f.host.state().epoch,
        kind: "attempt-started",
        inputId: "legacy-work",
        attempt: 1,
        turnId: "legacy-turn",
        driver: { harness: "codex", model: "test-model", effort: "high", profile: "headless-turn" },
        native: { kind: "fresh" },
        context: { digest: "a".repeat(64), from: 0, through: 1 },
      }).verdict,
    ).toBe("accepted");
    expect(
      f.host.handleFrame(
        JSON.stringify({ kind: "detach", epoch: f.host.state().epoch, reason: "shutdown" }),
      ).verdict,
    ).toBe("accepted");
    const binding = {
      actionId: crypto.randomUUID(),
      binding: f.controls.registration,
      kind: "bound",
    };
    const refusal1 = f.host.writeConnection(binding);
    expect(refusal1.verdict).toBe("refused");
    if (refusal1.verdict === "refused") expect(refusal1.issue).toBe("execution-blocked");
    expect(
      f.host.writeExecution({
        kind: "attempt-ended",
        inputId: "legacy-work",
        attempt: 1,
        turnId: "legacy-turn",
        outcome: {
          kind: "uncertain",
          failure: {
            code: "E-HUB-07",
            evidence: "process-lost",
            reason: "The native process outcome is unknown.",
          },
        },
      }).verdict,
    ).toBe("accepted");
    const refusal2 = f.host.writeConnection(binding);
    expect(refusal2.verdict).toBe("refused");
    if (refusal2.verdict === "refused") expect(refusal2.issue).toBe("execution-blocked");
    expect(f.host.state().connection).toBeNull();
  } finally {
    f.close();
  }
});

test("receipt and response controls resolve their action identities atomically for repeated command writers", () => {
  const f = boundFixture();
  const writer = openWriter(f.paths.dir, {
    connectionAuthority: () => f.controls.registration,
    ownerPresence: (owner) => f.controls.probe(owner),
  });
  try {
    f.acquire();
    const listener = f.enableFact();
    expect(f.host.writeConnection(listener).verdict).toBe("accepted");
    expect(
      f.host.acceptInput({ id: "command-feedback", mode: "queue", text: "Reply once" }).verdict,
    ).toBe("accepted");
    const prepared = prepareOffer(f.host, listener.participation.id, "command-feedback");
    expect(f.host.writeConnection(prepared).verdict).toBe("accepted");
    f.controls.lease?.release();
    const receipt = { kind: "receipt" as const, offerId: prepared.offer.id };
    expect(f.host.controlConnection(receipt).verdict).toBe("accepted");
    const seq = f.host.state().seq;
    expect(writer.controlConnection(receipt).verdict).toBe("accepted");
    expect(writer.state().seq).toBe(seq);
    const outcome = {
      kind: "respond" as const,
      offerId: prepared.offer.id,
      outcome: { kind: "answer", text: "Here is the result." },
    };
    expect(writer.controlConnection(outcome).verdict).toBe("accepted");
    const finishedSeq = writer.state().seq;
    expect(f.host.controlConnection(outcome).verdict).toBe("accepted");
    expect(f.host.state().seq).toBe(finishedSeq);
    expect(
      f.host.transcript().events.filter((entry) => entry.turnId === prepared.offer.turnId),
    ).toHaveLength(1);
    const changed = f.host.controlConnection({
      ...outcome,
      outcome: { kind: "answer", text: "A different result" },
    });
    expect(changed.verdict).toBe("refused");
    if (changed.verdict === "refused") expect(changed.issue).toBe("connection-conflict");
  } finally {
    writer.close();
    f.close();
  }
});

test("native control commands preserve one offer and require current registered ancestry and lifecycle", async () => {
  const f = boundFixture(false);
  try {
    const root = f.controls.registration.workingDirectory;
    const authority = { callerOwns: () => true, ownerPresence: () => true };
    const registered = registerNativeSession(root, f.controls.registration, authority);
    if (!registered.ok) throw new Error(registered.reason);
    f.controls.registration = registered.registration;
    expect(
      f.host.writeConnection({
        actionId: crypto.randomUUID(),
        binding: registered.registration,
        kind: "bound",
      }).verdict,
    ).toBe("accepted");
    f.acquire();
    const listener = f.enableFact();
    expect(f.host.writeConnection(listener).verdict).toBe("accepted");
    expect(
      f.host.acceptInput({ id: "cli-feedback", mode: "queue", text: "Reply from this session" })
        .verdict,
    ).toBe("accepted");
    const prepared = prepareOffer(f.host, listener.participation.id, "cli-feedback");
    expect(f.host.writeConnection(prepared).verdict).toBe("accepted");
    f.controls.lease?.release();
    const output: { verdict: string; reason?: string }[] = [];
    const deps = {
      rootDir: root,
      nativeAuthority: authority,
      onOutput: (line: string) => output.push(JSON.parse(line)),
    };
    const responsePath = join(root, "response.json");
    writeFileSync(
      responsePath,
      JSON.stringify({ kind: "answer", text: "The session recorded its response." }),
    );
    const respond = [
      "connection",
      "respond",
      "feedback",
      "--offer",
      prepared.offer.id,
      "--request",
      responsePath,
      "--json",
    ];
    expect((await dispatch(respond, deps)).kind).toBe("connection-control");
    expect(output.at(-1)).toMatchObject({ verdict: "refused", reason: "receipt-required" });
    const receipt = ["connection", "receipt", "feedback", "--offer", prepared.offer.id, "--json"];
    await dispatch(receipt, deps);
    expect(output.at(-1)?.verdict).toBe("accepted");
    await dispatch(receipt, deps);
    await dispatch(respond, deps);
    expect(output.at(-1)?.verdict).toBe("accepted");
    const seq = viewConversation(f.paths.dir).state.seq;
    await dispatch(respond, deps);
    expect(viewConversation(f.paths.dir).state.seq).toBe(seq);
    expect(
      viewConversation(f.paths.dir).transcript.events.filter(
        (entry) => entry.turnId === prepared.offer.turnId,
      ),
    ).toHaveLength(1);
    expect(registerNativeSession(root, f.controls.registration, authority).ok).toBe(true);
    await dispatch(receipt, deps);
    expect(output.at(-1)).toMatchObject({ verdict: "refused", reason: "connection-unverified" });
    expect(conversations(root).list().identities.size).toBe(1);
  } finally {
    f.close();
  }
});

test("control commands report failed caller verification without appending or claiming publication", async () => {
  const f = boundFixture();
  try {
    const root = f.controls.registration.workingDirectory;
    const ownerPresence = () => true;
    expect(
      registerNativeSession(root, f.controls.registration, {
        callerOwns: () => true,
        ownerPresence,
      }).ok,
    ).toBe(true);
    const output: { message: string; verdict: string; reason: string }[] = [];
    const argv = ["connection", "receipt", "feedback", "--offer", crypto.randomUUID(), "--json"];
    const nativeAuthority = { callerOwns: (): boolean | undefined => false, ownerPresence };
    const deps = {
      rootDir: root,
      nativeAuthority,
      onOutput: (line: string) => output.push(JSON.parse(line)),
    };
    const seq = f.host.state().seq;
    await dispatch(argv, deps);
    expect(output.at(-1)).toMatchObject({ verdict: "refused", reason: "registration-missing" });
    expect(output.at(-1)?.message.toLowerCase()).not.toContain("artifact published");
    nativeAuthority.callerOwns = () => {
      throw new Error("Ancestry inspection unavailable");
    };
    await dispatch(argv, deps);
    expect(output.at(-1)).toMatchObject({ verdict: "refused", reason: "owner-unknown" });
    expect(viewConversation(f.paths.dir).state.seq).toBe(seq);
  } finally {
    f.close();
  }
});

test("the cancellation command needs no native authority and remains limited to unsent inputs", async () => {
  const f = boundFixture();
  try {
    expect(f.host.acceptInput({ id: "withdraw", text: "Cancel this", mode: "queue" }).verdict).toBe(
      "accepted",
    );
    expect(f.host.acceptInput({ id: "offered", text: "Keep this", mode: "queue" }).verdict).toBe(
      "accepted",
    );
    f.acquire();
    const listener = f.enableFact();
    expect(f.host.writeConnection(listener).verdict).toBe("accepted");
    const output: { verdict: string; reason: string | null }[] = [];
    const noNativeProbe = () => {
      throw new Error("Cancellation must not require native authority");
    };
    const deps = {
      rootDir: f.controls.registration.workingDirectory,
      nativeAuthority: { callerOwns: noNativeProbe, ownerPresence: noNativeProbe },
      onOutput: (line: string) => output.push(JSON.parse(line)),
    };
    const cancel = ["connection", "cancel-input", "feedback", "--input", "withdraw", "--json"];
    expect((await dispatch(cancel, deps)).kind).toBe("connection-control");
    expect(output.at(-1)?.verdict).toBe("accepted");
    const seq = viewConversation(f.paths.dir).state.seq;
    await dispatch(cancel, deps);
    expect(viewConversation(f.paths.dir).state.seq).toBe(seq);
    expect(
      viewConversation(f.paths.dir).transcript.inputs.find((entry) => entry.id === "withdraw")
        ?.status,
    ).toBe("cancelled");
    const prepared = prepareOffer(f.host, listener.participation.id, "offered");
    expect(f.host.writeConnection(prepared).verdict).toBe("accepted");
    await dispatch(
      ["connection", "cancel-input", "feedback", "--input", "offered", "--json"],
      deps,
    );
    expect(output.at(-1)).toMatchObject({ verdict: "refused", reason: "input-already-dispatched" });
    expect(f.controls.lease?.held()).toBe(true);
  } finally {
    f.close();
  }
});

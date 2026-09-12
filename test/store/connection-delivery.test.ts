import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../../src/cli/dispatch.js";
import { conversations } from "../../src/cli/record-addressing.js";
import { listenNativeFeedback } from "../../src/modes/native-listener.js";
import { prepareNativeFeedback } from "../../src/modes/native-preparation.js";
import { readProcessOwner } from "../../src/process-owner.js";
import { encodeAnnotationBatch } from "../../src/protocol/annotations.js";
import type { ConnectionFact, NativeBinding } from "../../src/protocol/connection.js";
import { parseConnectionFact, reduceConnection } from "../../src/protocol/connection.js";
import { readContentSource } from "../../src/protocol/content-comparison.js";
import { EventKind } from "../../src/protocol/events.js";
import type { AttemptStart } from "../../src/protocol/execution.js";
import type { ProcessOwner } from "../../src/protocol/process-owner.js";
import { putBlob } from "../../src/store/blobs.js";
import { observeConnection, readConnection } from "../../src/store/connection-view.js";
import {
  createConversationHost,
  openWriter,
  viewConversation,
} from "../../src/store/conversation-host.js";
import {
  type RegistrationAuthority,
  registerNativeSession,
  withNativeRegistration,
  withNativeSessionAdmission,
} from "../../src/store/native-registration.js";
import { acquirePresence, type PresenceHandle, presenceHeld } from "../../src/store/presence.js";
import { replaceLocation } from "../../src/store/settings.js";
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

function preparedAttempt(
  f: BoundFixture,
  inputId: string,
  attempt = 1,
): { fact: AttemptStart; stamp: string } {
  const snapshot = f.host.captureDispatch(inputId, 0);
  return {
    fact: {
      attempt,
      context: {
        digest: snapshot.context.digest,
        from: snapshot.context.from,
        through: snapshot.context.through,
      },
      driver: { effort: "high", harness: "codex", model: "gpt-6-astra", profile: "headless-turn" },
      epoch: snapshot.epoch,
      inputId,
      kind: "attempt-started",
      native: { kind: "resume", sessionId: f.controls.registration.nativeSessionId },
      turnId: `prepared-turn-${attempt}`,
    },
    stamp: snapshot.stamp,
  };
}

test("a matching pre-start failure releases its launch for an explicit same-input retry", () => {
  const f = boundFixture();
  try {
    f.acquire();
    expect(
      f.host.enqueueInput({ id: "pre-start", mode: "queue", text: "Keep the same request" })
        .verdict,
    ).toBe("accepted");
    expect(
      f.host.writeExecution({ kind: "legacy-adopted", inputId: "pre-start", attempt: 0 }).verdict,
    ).toBe("accepted");
    f.controls.probe = () => false;
    const prepared = preparedAttempt(f, "pre-start");
    expect(f.host.writePreparedExecution(prepared.fact, prepared.stamp).verdict).toBe("accepted");
    const intent = Object.values(f.host.state().connection?.actions ?? {})
      .map((action) => parseConnectionFact(JSON.parse(action)))
      .find((action) => action?.kind === "launch-intended");
    if (intent?.kind !== "launch-intended") throw new Error("Missing launch intent");
    const refusal = {
      actionId: crypto.randomUUID(),
      kind: "launch-refused",
      launchId: intent.launch.id,
    };
    expect(f.host.writeConnection(refusal)).toMatchObject({
      verdict: "refused",
      issue: "execution-blocked",
    });
    const failure = {
      code: "native-not-found",
      evidence: "harness-refusal" as const,
      reason: "The selected executable could not be started.",
    };
    expect(
      f.host.writeExecution({
        kind: "attempt-ended",
        inputId: "pre-start",
        attempt: 1,
        turnId: prepared.fact.turnId,
        outcome: { kind: "pre-start-failed", failure },
      }).verdict,
    ).toBe("accepted");
    expect(f.host.writeConnection(refusal).verdict).toBe("accepted");
    const settled = f.host.state();
    expect(f.host.writeConnection(refusal).verdict).toBe("accepted");
    expect(f.host.state()).toEqual(settled);
    expect(f.host.transcript().events.at(-1)?.event).toMatchObject({
      kind: EventKind.failure,
      code: failure.code,
      message: failure.reason,
    });
    expect(
      f.host.writeExecution({
        kind: "retry-authorized",
        actionId: crypto.randomUUID(),
        inputId: "pre-start",
        attempt: 1,
        acknowledgeEffects: false,
      }).verdict,
    ).toBe("accepted");
    const repaired = preparedAttempt(f, "pre-start", 2);
    expect(f.host.writePreparedExecution(repaired.fact, repaired.stamp).verdict).toBe("accepted");
    expect(f.host.state().executions["pre-start"]).toMatchObject({
      attempt: 2,
      native: prepared.fact.native,
      inputId: "pre-start",
    });
    expect(f.host.transcript().inputs).toHaveLength(1);
    expect(f.host.transcript().inputs[0]).toMatchObject({
      text: "Keep the same request",
      status: "outstanding",
    });
    expect(
      f.host.transcript().events.filter((entry) => entry.event.kind === EventKind.message),
    ).toHaveLength(2);
    expect(viewConversation(f.paths.dir).state).toEqual(f.host.state());
  } finally {
    f.close();
  }
});

test("an uncertain execution cannot release its native launch as a pre-start refusal", () => {
  const f = boundFixture();
  try {
    f.acquire();
    expect(
      f.host.enqueueInput({ id: "uncertain-launch", mode: "queue", text: "Do not replay" }).verdict,
    ).toBe("accepted");
    expect(
      f.host.writeExecution({ kind: "legacy-adopted", inputId: "uncertain-launch", attempt: 0 })
        .verdict,
    ).toBe("accepted");
    f.controls.probe = () => false;
    const prepared = preparedAttempt(f, "uncertain-launch");
    expect(f.host.writePreparedExecution(prepared.fact, prepared.stamp).verdict).toBe("accepted");
    const intent = Object.values(f.host.state().connection?.actions ?? {})
      .map((action) => parseConnectionFact(JSON.parse(action)))
      .find((action) => action?.kind === "launch-intended");
    if (intent?.kind !== "launch-intended") throw new Error("Missing launch intent");
    expect(
      f.host.writeExecution({
        kind: "attempt-ended",
        inputId: "uncertain-launch",
        attempt: 1,
        turnId: prepared.fact.turnId,
        outcome: {
          kind: "uncertain",
          failure: {
            code: "process-lost",
            evidence: "process-lost",
            reason: "Native outcome is unknown.",
          },
        },
      }).verdict,
    ).toBe("accepted");
    const state = f.host.state();
    expect(
      f.host.writeConnection({
        actionId: crypto.randomUUID(),
        kind: "launch-refused",
        launchId: intent.launch.id,
      }),
    ).toMatchObject({ verdict: "refused", issue: "execution-blocked" });
    expect(f.host.state()).toEqual(state);
    expect(f.status()).toMatchObject({ state: "launch-uncertain" });
    expect(f.host.transcript().inputs[0]).toMatchObject({
      status: "outstanding",
      text: "Do not replay",
    });
  } finally {
    f.close();
  }
});

test.each(["unknown-launch", "different-start", "completed"] as const)(
  "launch refusal rejects %s evidence without changing the reservation",
  (scenario) => {
    const f = boundFixture();
    try {
      f.acquire();
      expect(
        f.host.enqueueInput({ id: "reserved", mode: "queue", text: "Preserve this input" }).verdict,
      ).toBe("accepted");
      expect(
        f.host.writeExecution({ kind: "legacy-adopted", inputId: "reserved", attempt: 0 }).verdict,
      ).toBe("accepted");
      f.controls.probe = () => false;
      const prepared = preparedAttempt(f, "reserved");
      expect(f.host.writePreparedExecution(prepared.fact, prepared.stamp).verdict).toBe("accepted");
      const pending = Object.values(f.host.state().connection?.launches ?? {})[0];
      if (!pending) throw new Error("Missing launch intent");
      expect(
        f.host.writeExecution({
          attempt: 1,
          inputId: "reserved",
          kind: "attempt-ended",
          outcome: {
            failure: {
              code: "dispatch-not-called",
              evidence: "dispatch-not-called",
              reason: "Dispatch was not invoked.",
            },
            kind: "pre-start-failed",
          },
          turnId: prepared.fact.turnId,
        }).verdict,
      ).toBe("accepted");
      const durable = f.host.state();
      const execution = durable.executions.reserved;
      if (execution?.kind !== "attempt-ended") throw new Error("Missing execution outcome");
      // Synthetic protocol states exercise defensive cross-ledger checks. The host
      // does not yet admit a bound process, so no live completion is claimed here.
      const state = {
        ...durable,
        executions: {
          ...durable.executions,
          reserved: {
            ...execution,
            ...(scenario === "different-start"
              ? { start: { ...execution.start, turnId: "another-turn" } }
              : {}),
            ...(scenario === "completed"
              ? { outcome: { kind: "completed" as const, terminalSeq: durable.seq } }
              : {}),
          },
        },
      };
      const refusal = {
        actionId: crypto.randomUUID(),
        kind: "launch-refused" as const,
        launchId: scenario === "unknown-launch" ? crypto.randomUUID() : pending.launch.id,
      };
      expect(reduceConnection(state, refusal, f.controls.now)).toMatchObject({
        issue: scenario === "unknown-launch" ? "connection-conflict" : "execution-blocked",
        state,
        verdict: "refused",
      });
      if (scenario === "unknown-launch")
        expect(f.host.writeConnection(refusal)).toMatchObject({
          issue: "connection-unverified",
          verdict: "refused",
        });
      expect(f.host.state()).toEqual(durable);
      expect(f.status()).toMatchObject({ state: "launch-uncertain" });
    } finally {
      f.close();
    }
  },
);

test("cancelled feedback invalidates a prepared launch before its notice or attempt is saved", () => {
  const f = boundFixture();
  try {
    f.acquire();
    for (const id of ["keep-prepared", "cancel-prepared"])
      expect(f.host.enqueueInput({ id, mode: "queue", text: id }).verdict).toBe("accepted");
    expect(
      f.host.writeExecution({ kind: "legacy-adopted", inputId: "keep-prepared", attempt: 0 })
        .verdict,
    ).toBe("accepted");
    const prepared = preparedAttempt(f, "keep-prepared");
    expect(
      f.host.controlConnection({ kind: "cancel-input", inputId: "cancel-prepared" }).verdict,
    ).toBe("accepted");
    f.controls.probe = () => false;
    expect(f.host.writePreparedExecution(prepared.fact, prepared.stamp)).toMatchObject({
      verdict: "refused",
      issue: "execution-stale",
    });
    expect(f.host.transcript().events).toHaveLength(0);
    expect(f.host.state().executions["keep-prepared"]).toMatchObject({
      kind: "requested",
      attempt: 0,
    });
    expect(f.host.transcript().inputs.find((input) => input.id === "cancel-prepared")?.status).toBe(
      "cancelled",
    );
  } finally {
    f.close();
  }
});

test("a prepared bound attempt and its launch notice are admitted in one durable write", () => {
  const f = boundFixture();
  try {
    f.acquire();
    expect(
      f.host.enqueueInput({
        id: "prepared-native",
        mode: "queue",
        text: "Continue the original review",
      }).verdict,
    ).toBe("accepted");
    expect(
      f.host.writeExecution({ kind: "legacy-adopted", inputId: "prepared-native", attempt: 0 })
        .verdict,
    ).toBe("accepted");
    const { fact, stamp } = preparedAttempt(f, "prepared-native");
    f.controls.probe = () => false;
    const seq = f.host.state().seq;
    expect(f.host.writePreparedExecution(fact, stamp).verdict).toBe("accepted");
    expect(f.host.state().seq).toBe(seq + 1);
    expect(f.host.state().executions["prepared-native"]).toMatchObject(fact);
    expect(Object.values(f.host.state().connection?.launches ?? {})).toHaveLength(1);
    expect(f.host.transcript().events).toHaveLength(1);
    expect(f.host.transcript().events[0]?.event).toMatchObject({
      text: "No interactive session detected. Resuming headlessly with session native-one.",
    });
    expect(viewConversation(f.paths.dir).state).toEqual(f.host.state());
    expect(f.host.transcript().inputs[0]).toMatchObject({
      status: "outstanding",
      text: "Continue the original review",
    });
    const saved = Object.values(f.host.state().connection?.actions ?? {})
      .map((action) => parseConnectionFact(JSON.parse(action)))
      .find((action) => action?.kind === "launch-intended");
    if (!saved) throw new Error("Missing saved launch");
    const admitted = f.host.state();
    expect(f.host.writeConnection(saved).verdict).toBe("accepted");
    expect(f.host.state()).toEqual(admitted);
    expect(f.host.transcript().events).toHaveLength(1);
  } finally {
    f.close();
  }
});

test("headless launch selects the first eligible saved input", () => {
  const f = boundFixture();
  try {
    const requester = readProcessOwner(process.pid);
    if (!requester) throw new Error("Cannot verify this test process");
    for (const id of ["first", "second"])
      expect(f.host.enqueueInput({ id, mode: "queue", text: id }).verdict).toBe("accepted");
    f.controls.probe = () => false;
    f.acquire();
    expect(
      f.host.writeConnection({
        actionId: crypto.randomUUID(),
        kind: "launch-intended",
        launch: {
          epoch: 0,
          id: crypto.randomUUID(),
          inputId: "second",
          registration: f.controls.registration,
          requester,
          role: "headless",
        },
      }),
    ).toMatchObject({ verdict: "refused", issue: "execution-ineligible" });
    expect(f.host.transcript().events).toHaveLength(0);
    expect(f.host.transcript().inputs.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "first", status: "outstanding" },
      { id: "second", status: "outstanding" },
    ]);
  } finally {
    f.close();
  }
});

test("connection replay refuses a native offer while headless creation is unresolved", () => {
  const f = boundFixture();
  try {
    f.acquire();
    const listener = f.enableFact();
    expect(f.host.writeConnection(listener).verdict).toBe("accepted");
    expect(
      f.host.enqueueInput({ id: "replay-offer", mode: "queue", text: "One recipient" }).verdict,
    ).toBe("accepted");
    const offer = prepareOffer(f.host, listener.participation.id, "replay-offer");
    f.controls.probe = () => false;
    expect(
      f.host.writeConnection({
        actionId: crypto.randomUUID(),
        kind: "launch-intended",
        launch: {
          epoch: f.host.state().epoch,
          id: crypto.randomUUID(),
          inputId: "replay-offer",
          registration: f.controls.registration,
          requester: readProcessOwner(process.pid),
          role: "headless",
        },
      }).verdict,
    ).toBe("accepted");
    const state = f.host.state();
    expect(reduceConnection(state, offer, f.controls.now)).toMatchObject({
      verdict: "refused",
      issue: "execution-blocked",
      state,
    });
  } finally {
    f.close();
  }
});

test("a returning native registration blocks launch before it binds or starts listening", () => {
  const f = boundFixture();
  try {
    const requester = readProcessOwner(process.pid);
    if (!requester) throw new Error("Cannot verify this test process");
    const returning = returningRegistration(f.controls.registration);
    expect(
      registerNativeSession(f.controls.registration.workingDirectory, returning, {
        callerOwns: () => true,
        ownerPresence: () => true,
      }),
    ).toMatchObject({ ok: true });
    expect(f.host.enqueueInput({ id: "returning", mode: "queue", text: "Continue" }).verdict).toBe(
      "accepted",
    );
    f.acquire();
    const fact = {
      actionId: crypto.randomUUID(),
      kind: "launch-intended",
      launch: {
        epoch: 0,
        id: crypto.randomUUID(),
        inputId: "returning",
        registration: f.controls.registration,
        requester,
        role: "headless",
      },
    };
    for (const present of [true, undefined]) {
      f.controls.probe = (owner) => (owner.pid === returning.owner.pid ? present : false);
      expect(f.host.writeConnection(fact)).toMatchObject({
        verdict: "refused",
        issue: present ? "connection-conflict" : "connection-unverified",
      });
    }
    expect(f.host.transcript().events).toHaveLength(0);
  } finally {
    f.close();
  }
});

test("headless launch admission rechecks the saved folder and keeps the original native target", () => {
  const f = boundFixture();
  const otherFolder = mkdtempSync(join(tmpdir(), "lucid-other-folder-"));
  try {
    const requester = readProcessOwner(process.pid);
    if (!requester) throw new Error("Cannot verify this test process");
    expect(
      f.host.enqueueInput({ id: "folder-feedback", mode: "queue", text: "Continue" }).verdict,
    ).toBe("accepted");
    f.controls.probe = () => false;
    f.acquire();
    replaceLocation(f.paths.dir, "feedback", 0, otherFolder);
    expect(
      f.host.writeConnection({
        actionId: crypto.randomUUID(),
        kind: "launch-intended",
        launch: {
          epoch: 0,
          id: crypto.randomUUID(),
          inputId: "folder-feedback",
          registration: f.controls.registration,
          requester,
          role: "headless",
        },
      }),
    ).toMatchObject({ verdict: "refused", issue: "connection-folder-mismatch" });
    expect(f.host.transcript().events).toHaveLength(0);
    expect(f.host.state().connection?.binding).toEqual(f.controls.registration);
  } finally {
    f.close();
    rmSync(otherFolder, { force: true, recursive: true });
  }
});

test("an unresolved launch keeps its input reserved after the executor exits", () => {
  const f = boundFixture();
  try {
    const requester = readProcessOwner(process.pid);
    if (!requester) throw new Error("Cannot verify this test process");
    expect(
      f.host.enqueueInput({ id: "reserved", mode: "queue", text: "Keep this input" }).verdict,
    ).toBe("accepted");
    f.controls.probe = () => false;
    f.acquire();
    expect(
      f.host.writeConnection({
        actionId: crypto.randomUUID(),
        kind: "launch-intended",
        launch: {
          epoch: 0,
          id: crypto.randomUUID(),
          inputId: "reserved",
          registration: f.controls.registration,
          requester,
          role: "headless",
        },
      }).verdict,
    ).toBe("accepted");
    f.controls.lease?.release();
    const writer = openWriter(f.paths.dir);
    try {
      expect(writer.controlConnection({ kind: "cancel-input", inputId: "reserved" })).toMatchObject(
        { verdict: "refused", issue: "input-already-dispatched" },
      );
      expect(writer.transcript().inputs[0]).toMatchObject({
        id: "reserved",
        status: "outstanding",
      });
    } finally {
      writer.close();
    }
  } finally {
    f.close();
  }
});

test("two records cannot reserve the same native history even through different interfaces", () => {
  const f = boundFixture();
  const root = f.controls.registration.workingDirectory;
  const { paths } = createConversationRecord(root, "other-feedback", { workingDirectory: root });
  const registration = { ...f.controls.registration, interface: "codex-desktop" as const };
  let departed = false;
  let lease: PresenceHandle | undefined;
  const other = createConversationHost(paths.dir, {
    connectionAuthority: () => registration,
    executorLease: () => lease?.held() ?? false,
    nativeSessionRoot: root,
    now: () => 1000,
    onEffect: () => {},
    onRecord: () => {},
    ownerPresence: () => !departed,
    presence: () => undefined,
  });
  try {
    expect(
      other.writeConnection({ actionId: crypto.randomUUID(), binding: registration, kind: "bound" })
        .verdict,
    ).toBe("accepted");
    const requester = readProcessOwner(process.pid);
    if (!requester) throw new Error("Cannot verify this test process");
    const intent = (binding: NativeBinding) => ({
      actionId: crypto.randomUUID(),
      kind: "launch-intended",
      launch: {
        epoch: 0,
        id: crypto.randomUUID(),
        inputId: "feedback",
        registration: binding,
        requester,
        role: "headless",
      },
    });
    for (const host of [f.host, other])
      expect(
        host.enqueueInput({ id: "feedback", mode: "queue", text: "One response" }).verdict,
      ).toBe("accepted");
    f.controls.probe = () => false;
    departed = true;
    f.acquire();
    expect(f.host.writeConnection(intent(f.controls.registration)).verdict).toBe("accepted");
    // Losing the executor is insufficient evidence that native creation never started.
    f.controls.lease?.release();
    lease = acquirePresence(paths.dir, "other-feedback");
    expect(other.writeConnection(intent(registration))).toMatchObject({
      verdict: "refused",
      issue: "execution-blocked",
    });
    expect(other.transcript().events).toHaveLength(0);
    expect(other.transcript().inputs[0]).toMatchObject({ status: "outstanding" });
  } finally {
    other.close();
    lease?.release();
    f.close();
  }
});

test("departed native launch admission records one notice and fences unresolved creation", () => {
  const f = boundFixture();
  try {
    const requester = readProcessOwner(process.pid);
    if (!requester) throw new Error("Cannot verify this test process");
    expect(
      f.host.enqueueInput({ id: "headless-feedback", mode: "queue", text: "Continue this review" })
        .verdict,
    ).toBe("accepted");
    const fact = {
      actionId: crypto.randomUUID(),
      kind: "launch-intended",
      launch: {
        epoch: f.host.state().epoch,
        id: crypto.randomUUID(),
        inputId: "headless-feedback",
        registration: f.controls.registration,
        requester,
        role: "headless",
      },
    };
    f.acquire();
    expect(f.host.writeConnection(fact)).toMatchObject({
      verdict: "refused",
      issue: "connection-conflict",
    });
    f.controls.probe = () => undefined;
    expect(f.host.writeConnection(fact)).toMatchObject({
      verdict: "refused",
      issue: "connection-unverified",
    });
    expect(f.host.transcript().events).toHaveLength(0);
    f.controls.probe = () => false;
    expect(f.host.writeConnection(fact).verdict).toBe("accepted");
    const seq = f.host.state().seq;
    expect(f.host.writeConnection(fact).verdict).toBe("accepted");
    expect(f.host.state().seq).toBe(seq);
    expect(f.host.transcript().events.map((entry) => entry.event)).toEqual([
      {
        kind: EventKind.message,
        role: "system",
        text: "No interactive session detected. Resuming headlessly with session native-one.",
      },
    ]);
    expect(viewConversation(f.paths.dir).transcript).toEqual(f.host.transcript());
    expect(f.status()).toMatchObject({ state: "launch-uncertain", reason: "launch-unsettled" });
    f.controls.probe = () => true;
    expect(f.status()).toMatchObject({
      state: "owner-conflict",
      reason: "native-identity-conflict",
    });
    f.controls.probe = () => false;
    expect(
      f.host.writeConnection({
        ...fact,
        actionId: crypto.randomUUID(),
        launch: { ...fact.launch, id: crypto.randomUUID() },
      }),
    ).toMatchObject({ verdict: "refused", issue: "execution-blocked" });
    expect(f.host.transcript().events).toHaveLength(1);
    expect(f.host.transcript().inputs[0]).toMatchObject({
      id: "headless-feedback",
      status: "outstanding",
      text: "Continue this review",
    });
  } finally {
    f.close();
  }
});

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
    nativeSessionRoot: root,
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

function registerBinding(f: BoundFixture, authority: RegistrationAuthority): NativeBinding {
  const registered = registerNativeSession(
    f.controls.registration.workingDirectory,
    f.controls.registration,
    authority,
  );
  if (!registered.ok) throw new Error(registered.reason);
  f.controls.registration = registered.registration;
  expect(
    f.host.writeConnection({
      actionId: crypto.randomUUID(),
      binding: registered.registration,
      kind: "bound",
    }).verdict,
  ).toBe("accepted");
  return registered.registration;
}

test("a requested native wait consumes its activation once and refuses stale selection", async () => {
  const f = boundFixture(false);
  const authority = { callerOwns: () => true, ownerPresence: () => true };
  try {
    registerBinding(f, authority);
    const request = { actionId: crypto.randomUUID(), conversationId: "feedback" };
    expect(
      withNativeRegistration(
        f.controls.registration.workingDirectory,
        undefined,
        (_binding, access) => access.writeListenRequest(request),
        authority,
      ),
    ).toMatchObject({ ok: true });
    const options = {
      recordDir: f.paths.dir,
      request,
      root: f.controls.registration.workingDirectory,
      signal: new AbortController().signal,
      source: "explicit" as const,
      transport: { encode: (text: string) => text, maxBytes: 10_000 },
    };
    const deps = {
      authority,
      now: () => f.controls.now,
      wait: async (ms: number) => {
        f.controls.now += ms;
      },
    };
    expect(await listenNativeFeedback(options, deps)).toEqual({
      kind: "stopped",
      reason: "expired",
    });
    const state = viewConversation(f.paths.dir).state;
    expect(Object.hasOwn(state.connection?.actions ?? {}, request.actionId)).toBe(true);
    expect(await listenNativeFeedback(options, deps)).toMatchObject({ kind: "held" });
    expect(
      await listenNativeFeedback(
        { ...options, request: { ...request, actionId: crypto.randomUUID() } },
        deps,
      ),
    ).toMatchObject({ kind: "held" });
    expect(f.controls.now).toBe(46_000);
    expect(viewConversation(f.paths.dir).state.epoch).toBe(state.epoch);
    expect(presenceHeld(f.paths.dir)).toBe(false);
  } finally {
    f.close();
  }
});

test("selection revoked during preparation leaves feedback unsent and disables the old helper", async () => {
  const f = boundFixture(false);
  const authority = { callerOwns: () => true, ownerPresence: () => true };
  try {
    const registration = registerBinding(f, authority);
    const request = { actionId: crypto.randomUUID(), conversationId: "feedback" };
    withNativeRegistration(
      registration.workingDirectory,
      undefined,
      (_binding, access) => access.writeListenRequest(request),
      authority,
    );
    expect(
      f.host.acceptInput({ id: "saved", mode: "queue", text: "Keep the complete input" }).verdict,
    ).toBe("accepted");
    const result = await listenNativeFeedback(
      {
        recordDir: f.paths.dir,
        request,
        root: registration.workingDirectory,
        signal: new AbortController().signal,
        source: "explicit",
        transport: {
          encode: (text) => {
            expect(
              withNativeRegistration(
                registration.workingDirectory,
                undefined,
                (_binding, access) => access.writeListenRequest(null),
                authority,
              ),
            ).toMatchObject({ ok: true });
            return text;
          },
          maxBytes: 100_000,
        },
      },
      { authority, now: () => f.controls.now },
    );
    expect(result).toMatchObject({ kind: "held", reason: "connection-not-admitted" });
    const state = viewConversation(f.paths.dir).state;
    expect(state.connection?.disabledReason).toBe("interrupted");
    expect(Object.keys(state.connection?.offers ?? {})).toHaveLength(0);
    expect(state.inputs.find((input) => input.id === "saved")?.text).toBe(
      "Keep the complete input",
    );
    expect(presenceHeld(f.paths.dir)).toBe(false);
  } finally {
    f.close();
  }
});

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

test("native preparation carries the complete current document and the original comparison annotation", async () => {
  const f = boundFixture();
  try {
    const write = async (version: number, bytes: string) => {
      expect(
        (
          await f.host.writeArtifact({
            artifactId: "flow",
            author: "agent",
            bytes,
            contentType: "text/html",
            version,
          })
        ).verdict,
      ).toBe("accepted");
      const artifact = f.host.readArtifact("flow", version);
      if (!artifact) throw new Error("Missing fixture artifact");
      return artifact;
    };
    const original = await write(1, "<p>The original wording.</p>");
    const reviewed = await write(2, "<p>The reviewed wording.</p>");
    const passage = readContentSource(original.bytes).passages[0];
    if (!passage) throw new Error("Missing fixture passage");
    const note = encodeAnnotationBatch({
      artifactId: "flow",
      version: 1,
      comparison: { earlierVersion: 1, reviewedHash: reviewed.hash, reviewedVersion: 2 },
      notes: [
        {
          note: "Restore the original wording and keep later additions.",
          spots: [
            {
              author: passage.author,
              id: passage.id,
              selectors: passage.selectors,
              snippet: passage.text,
              sourceHash: original.hash,
              sourceVersion: 1,
            },
          ],
        },
      ],
    });
    expect(
      f.host.acceptInput({ id: "context-note", mode: "queue", text: note }, { managed: true })
        .verdict,
    ).toBe("accepted");
    const current = await write(
      3,
      `<p>${"current addition ".repeat(1200)}FINAL-CURRENT-MARKER</p>`,
    );
    f.acquire();
    expect(f.host.writeConnection(f.enableFact()).verdict).toBe("accepted");
    const prepared = prepareNativeFeedback(f.host, "context-note", {
      encode: (prompt: string) => JSON.stringify({ decision: "block", reason: prompt }),
      maxBytes: 500_000,
    });
    expect(prepared.kind).toBe("ready");
    if (prepared.kind !== "ready") throw new Error(prepared.kind);
    const prompt = JSON.parse(prepared.payload).reason;
    expect(prompt).toContain(JSON.stringify(current.bytes));
    expect(prompt).toContain("Historical source: v1. Reviewed: v2.");
    expect(prompt).toContain("Dispatch version: 3.");
    expect(prompt).toContain(note);
    expect(prompt).toContain(`connection receipt 'feedback' --offer '${prepared.fact.offer.id}'`);
    expect(prompt).toContain(`connection respond 'feedback' --offer '${prepared.fact.offer.id}'`);
    expect(prepared.fact.offer.inputId).toBe("context-note");
    expect(Object.values(f.host.state().connection?.offers ?? {})).toHaveLength(0);
    expect(f.host.writeConnection(prepared.fact).verdict).toBe("accepted");
  } finally {
    f.close();
  }
});

test("cancelled feedback remains in the transcript but never enters later native context", () => {
  const f = boundFixture();
  try {
    expect(
      f.host.acceptInput({ id: "withdrawn", mode: "queue", text: "WITHDRAWN_NATIVE_TEXT" }).verdict,
    ).toBe("accepted");
    expect(
      f.host.writeConnection({
        actionId: crypto.randomUUID(),
        inputId: "withdrawn",
        kind: "input-cancelled",
      }).verdict,
    ).toBe("accepted");
    expect(
      f.host.acceptInput({ id: "current", mode: "queue", text: "Keep this current request" })
        .verdict,
    ).toBe("accepted");
    f.acquire();
    expect(f.host.writeConnection(f.enableFact()).verdict).toBe("accepted");
    const prepared = prepareNativeFeedback(f.host, "current", {
      encode: (text) => text,
      maxBytes: 100_000,
    });
    expect(prepared.kind).toBe("ready");
    if (prepared.kind !== "ready") return;
    expect(prepared.payload).not.toContain("WITHDRAWN_NATIVE_TEXT");
    expect(prepared.payload).toContain("Keep this current request");
    expect(f.host.transcript().inputs.find((input) => input.id === "withdrawn")).toMatchObject({
      status: "cancelled",
      text: "WITHDRAWN_NATIVE_TEXT",
    });
    expect(() => f.host.captureDispatch("withdrawn", 0)).toThrow(
      "The accepted prompt was cancelled",
    );
    prepared.discard();
  } finally {
    f.close();
  }
});

test("the bounded native listener waits without inference, offers FIFO feedback once, and resumes only after settlement", async () => {
  const f = boundFixture(false);
  const authority = { callerOwns: () => true, ownerPresence: () => true };
  try {
    const registration = registerBinding(f, authority);
    let waits = 0;
    const options = {
      recordDir: f.paths.dir,
      root: registration.workingDirectory,
      signal: new AbortController().signal,
      source: "explicit" as const,
      transport: {
        encode: (prompt: string) => JSON.stringify({ decision: "block", reason: prompt }),
        maxBytes: 100_000,
      },
    };
    const deps = {
      authority,
      now: () => f.controls.now,
      wait: async (ms: number) => {
        waits += 1;
        f.controls.now += ms;
        expect(f.status().state).toBe("listening");
        expect(
          f.host.acceptInput(
            { id: "managed-first", text: "First browser feedback", mode: "queue" },
            { managed: true },
          ).verdict,
        ).toBe("accepted");
        expect(
          f.host.acceptInput({
            id: "ordinary-second",
            text: "Second browser feedback",
            mode: "queue",
          }).verdict,
        ).toBe("accepted");
      },
    };
    const first = await listenNativeFeedback(options, deps);
    expect(first.kind).toBe("offered");
    if (first.kind !== "offered") throw new Error(first.kind);
    expect(waits).toBe(1);
    expect(JSON.parse(first.payload).reason).toContain("First browser feedback");
    const afterOffer = viewConversation(f.paths.dir);
    expect(afterOffer.state.connection?.offers[first.offerId]).toMatchObject({
      kind: "sending",
      offer: { inputId: "managed-first" },
    });
    expect(afterOffer.state.appliedInputs["managed-first"]).toBeUndefined();
    expect(presenceHeld(f.paths.dir)).toBe(false);
    const blocked = await listenNativeFeedback({ ...options, source: "continuation" }, deps);
    expect(blocked.kind).toBe("held");
    expect(viewConversation(f.paths.dir).state.seq).toBe(afterOffer.state.seq);
    expect(f.host.controlConnection({ kind: "receipt", offerId: first.offerId }).verdict).toBe(
      "accepted",
    );
    expect(
      f.host.controlConnection({
        kind: "respond",
        offerId: first.offerId,
        outcome: { kind: "answer", text: "First feedback answered" },
      }).verdict,
    ).toBe("accepted");
    const second = await listenNativeFeedback({ ...options, source: "continuation" }, deps);
    expect(second.kind).toBe("offered");
    if (second.kind !== "offered") throw new Error(second.kind);
    expect(viewConversation(f.paths.dir).state.connection?.offers[second.offerId]).toMatchObject({
      kind: "sending",
      offer: { inputId: "ordinary-second" },
    });
    expect(waits).toBe(1);
    expect(presenceHeld(f.paths.dir)).toBe(false);
  } finally {
    f.close();
  }
});

test("the verified native parent can durably interrupt its helper without owning the executor lease", async () => {
  const f = boundFixture(false);
  const authority = { callerOwns: () => true, ownerPresence: () => true };
  try {
    const registration = registerBinding(f, authority);
    let verdict: "accepted" | "refused" | undefined;
    const rejected: string[] = [];
    const result = await listenNativeFeedback(
      {
        recordDir: f.paths.dir,
        root: registration.workingDirectory,
        signal: new AbortController().signal,
        source: "explicit",
        transport: { encode: (prompt) => prompt, maxBytes: 100_000 },
      },
      {
        authority,
        now: () => f.controls.now,
        wait: async (ms) => {
          f.controls.now += ms;
          if (verdict !== undefined) return;
          const state = viewConversation(f.paths.dir).state;
          const id = state.connection?.listenerId;
          if (!id) throw new Error("Missing active listener");
          for (const invalid of [
            {
              registration: { ...registration, generation: crypto.randomUUID() },
              presence: true,
              reason: "interrupted" as const,
            },
            { registration, presence: undefined, reason: "interrupted" as const },
            { registration, presence: true, reason: "expired" as const },
          ]) {
            const other = openWriter(f.paths.dir, {
              connectionAuthority: () => invalid.registration,
              ownerPresence: () => invalid.presence,
              now: () => f.controls.now,
            });
            try {
              rejected.push(
                other.writeConnection({
                  actionId: crypto.randomUUID(),
                  epoch: state.epoch,
                  kind: "listener-disabled",
                  participationId: id,
                  reason: invalid.reason,
                }).verdict,
              );
            } finally {
              other.close();
            }
          }
          const callback = openWriter(f.paths.dir, {
            connectionAuthority: () => registration,
            ownerPresence: () => true,
            now: () => f.controls.now,
          });
          try {
            verdict = callback.writeConnection({
              actionId: crypto.randomUUID(),
              epoch: state.epoch,
              kind: "listener-disabled",
              participationId: id,
              reason: "interrupted",
            }).verdict;
          } finally {
            callback.close();
          }
        },
      },
    );
    expect(verdict).toBe("accepted");
    expect(rejected).toEqual(["refused", "refused", "refused"]);
    expect(result).toEqual({ kind: "stopped", reason: "interrupted" });
    expect(viewConversation(f.paths.dir).state.connection?.disabledReason).toBe("interrupted");
    expect(f.controls.now).toBe(1500);
    expect(presenceHeld(f.paths.dir)).toBe(false);
  } finally {
    f.close();
  }
});

test("the idle native listener revokes readiness as soon as its owner becomes unverified", async () => {
  const f = boundFixture(false);
  let owner: boolean | undefined = true;
  const authority = { callerOwns: () => true, ownerPresence: (): boolean | undefined => owner };
  try {
    const registration = registerBinding(f, authority);
    let waits = 0;
    const result = await listenNativeFeedback(
      {
        recordDir: f.paths.dir,
        root: registration.workingDirectory,
        signal: new AbortController().signal,
        source: "explicit",
        transport: { encode: (prompt) => prompt, maxBytes: 100_000 },
      },
      {
        authority,
        now: () => f.controls.now,
        wait: async (ms) => {
          waits += 1;
          f.controls.now += ms;
          owner = undefined;
        },
      },
    );
    expect(result.kind).toBe("held");
    if (result.kind === "held") expect(result.reason).toBe("owner-unknown");
    expect(waits).toBe(1);
    const fresh = viewConversation(f.paths.dir);
    expect(fresh.state.connection?.disabledReason).toBe("owner-lost");
    expect(fresh.state.connection?.listenerId).toBeNull();
    expect(Object.keys(fresh.state.connection?.offers ?? {})).toHaveLength(0);
    expect(presenceHeld(f.paths.dir)).toBe(false);
    expect(
      readConnection(f.paths.dir, {
        now: () => f.controls.now,
        ownerPresence: authority.ownerPresence,
      }).state,
    ).toBe("owner-unknown");
  } finally {
    f.close();
  }
});

test("native interruption during preparation keeps the input unsent and requires explicit listening again", async () => {
  const f = boundFixture(false);
  const authority = { callerOwns: () => true, ownerPresence: () => true };
  try {
    const registration = registerBinding(f, authority);
    expect(
      f.host.acceptInput({ id: "interrupted-feedback", text: "Keep this queued", mode: "queue" })
        .verdict,
    ).toBe("accepted");
    const controller = new AbortController();
    let waits = 0;
    const deps = {
      authority,
      now: () => f.controls.now,
      wait: async () => {
        waits += 1;
      },
    };
    const options = {
      recordDir: f.paths.dir,
      root: registration.workingDirectory,
      signal: controller.signal,
      source: "explicit" as const,
      transport: {
        encode: (prompt: string) => {
          controller.abort();
          return prompt;
        },
        maxBytes: 100_000,
      },
    };
    const interrupted = await listenNativeFeedback(options, deps);
    expect(interrupted).toEqual({ kind: "stopped", reason: "interrupted" });
    const fresh = viewConversation(f.paths.dir);
    expect(fresh.state.connection?.disabledReason).toBe("interrupted");
    expect(Object.keys(fresh.state.connection?.offers ?? {})).toHaveLength(0);
    expect(fresh.state.appliedInputs["interrupted-feedback"]).toBeUndefined();
    expect(fresh.state.inputs.find((input) => input.id === "interrupted-feedback")?.text).toBe(
      "Keep this queued",
    );
    expect(presenceHeld(f.paths.dir)).toBe(false);
    const again = {
      ...options,
      signal: new AbortController().signal,
      transport: { encode: (prompt: string) => prompt, maxBytes: 100_000 },
    };
    const automatic = await listenNativeFeedback({ ...again, source: "continuation" }, deps);
    expect(automatic.kind).toBe("held");
    expect(viewConversation(f.paths.dir).state.seq).toBe(fresh.state.seq);
    const explicit = await listenNativeFeedback(again, deps);
    expect(explicit.kind).toBe("offered");
    expect(waits).toBe(0);
  } finally {
    f.close();
  }
});

test("a native preparation hold survives continuation while other eligible feedback proceeds", async () => {
  const f = boundFixture(false);
  const authority = { callerOwns: () => true, ownerPresence: () => true };
  try {
    const registration = registerBinding(f, authority);
    const note = "Keep this original feedback for a later retry";
    expect(
      f.host.acceptInput({ id: "held-feedback", text: note, mode: "queue" }, { managed: true })
        .verdict,
    ).toBe("accepted");
    expect(
      f.host.acceptInput({
        id: "eligible-feedback",
        text: "Answer this independent question",
        mode: "queue",
      }).verdict,
    ).toBe("accepted");
    let encodes = 0;
    const options = {
      recordDir: f.paths.dir,
      root: registration.workingDirectory,
      signal: new AbortController().signal,
      source: "explicit" as const,
      transport: {
        encode: (prompt: string) => {
          encodes += 1;
          if (encodes === 1) throw new Error("Transport encoding failed for this input");
          return prompt;
        },
        maxBytes: 100_000,
      },
    };
    const deps = {
      authority,
      now: () => f.controls.now,
      wait: async (ms: number) => {
        f.controls.now += ms;
      },
    };
    const first = await listenNativeFeedback(options, deps);
    expect(first.kind).toBe("offered");
    if (first.kind !== "offered") throw new Error(first.kind);
    const fresh = viewConversation(f.paths.dir);
    expect(fresh.state.connection?.offers[first.offerId]?.offer.inputId).toBe("eligible-feedback");
    const hold = fresh.state.connection?.heldInputs["held-feedback"];
    expect(hold?.reason).toBe("transport-encoding-failed");
    expect(fresh.state.inputs.find((input) => input.id === "held-feedback")?.text).toBe(note);
    expect(fresh.state.appliedInputs["held-feedback"]).toBeUndefined();
    expect(f.host.controlConnection({ kind: "receipt", offerId: first.offerId }).verdict).toBe(
      "accepted",
    );
    expect(
      f.host.controlConnection({
        kind: "respond",
        offerId: first.offerId,
        outcome: { kind: "answer", text: "Independent answer" },
      }).verdict,
    ).toBe("accepted");
    expect(
      f.host.acceptInput({
        id: "later-feedback",
        text: "Another independent question",
        mode: "queue",
      }).verdict,
    ).toBe("accepted");
    const continued = await listenNativeFeedback({ ...options, source: "continuation" }, deps);
    expect(continued.kind).toBe("offered");
    if (continued.kind !== "offered") throw new Error(continued.kind);
    const after = viewConversation(f.paths.dir);
    expect(after.state.connection?.offers[continued.offerId]?.offer.inputId).toBe("later-feedback");
    expect(after.state.connection?.heldInputs["held-feedback"]).toEqual(hold);
    expect(encodes).toBe(3);
    expect(presenceHeld(f.paths.dir)).toBe(false);
  } finally {
    f.close();
  }
});

test("explicit native listening rechecks a comparison hold recorded by the prior execution path", async () => {
  const f = boundFixture(false);
  const authority = { callerOwns: () => true, ownerPresence: () => true };
  try {
    f.acquire();
    expect(
      (
        await f.host.writeArtifact({
          artifactId: "flow",
          author: "agent",
          bytes: "<p>Current saved document.</p>",
          contentType: "text/html",
          version: 1,
        })
      ).verdict,
    ).toBe("accepted");
    expect(
      f.host.acceptInput(
        { id: "legacy-held", text: "Recheck the saved document", mode: "queue" },
        { managed: true },
      ).verdict,
    ).toBe("accepted");
    // Synthetic prior worker failure composed through the public execution seam.
    expect(
      f.host.writeExecution({
        kind: "held",
        inputId: "legacy-held",
        attempt: 0,
        hold: {
          code: "E-COMP-07",
          reason: "The prior session could not prepare the current document",
          actions: ["save-newer-version", "attach-session"],
          prerequisite: "comparison-content",
          comparison: { artifactId: "flow", explicitEpoch: 0, failedHead: 1 },
        },
      }).verdict,
    ).toBe("accepted");
    const registration = registerBinding(f, authority);
    f.controls.lease?.release();
    const result = await listenNativeFeedback(
      {
        recordDir: f.paths.dir,
        root: registration.workingDirectory,
        signal: new AbortController().signal,
        source: "explicit",
        transport: { encode: (prompt) => prompt, maxBytes: 100_000 },
      },
      {
        authority,
        now: () => f.controls.now,
        wait: async (ms) => {
          f.controls.now += ms;
        },
      },
    );
    expect(result.kind).toBe("offered");
    if (result.kind !== "offered") throw new Error(result.kind);
    expect(result.payload).toContain("Current saved document.");
    expect(
      viewConversation(f.paths.dir).state.connection?.offers[result.offerId]?.offer.inputId,
    ).toBe("legacy-held");
    expect(presenceHeld(f.paths.dir)).toBe(false);
  } finally {
    f.close();
  }
});

test("a newer document or explicit listening releases the original held native input", async () => {
  for (const recovery of ["new-document", "explicit-listen"] as const) {
    const f = boundFixture(false);
    const authority = { callerOwns: () => true, ownerPresence: () => true };
    try {
      const registration = registerBinding(f, authority);
      for (const [id, text] of [
        ["held-original", "Keep this exact original feedback"],
        ["independent", "Answer independently"],
      ] as const)
        expect(f.host.acceptInput({ id, text, mode: "queue" }, { managed: true }).verdict).toBe(
          "accepted",
        );
      let encodes = 0;
      const options = {
        recordDir: f.paths.dir,
        root: registration.workingDirectory,
        signal: new AbortController().signal,
        source: "explicit" as const,
        transport: {
          encode: (prompt: string) => {
            if (++encodes === 1) throw new Error("Synthetic transport failure");
            return prompt;
          },
          maxBytes: 100_000,
        },
      };
      const deps = {
        authority,
        now: () => f.controls.now,
        wait: async (ms: number) => {
          f.controls.now += ms;
        },
      };
      const first = await listenNativeFeedback(options, deps);
      expect(first.kind).toBe("offered");
      if (first.kind !== "offered") throw new Error(first.kind);
      expect(
        viewConversation(f.paths.dir).state.connection?.heldInputs["held-original"],
      ).toBeDefined();
      expect(f.host.controlConnection({ kind: "receipt", offerId: first.offerId }).verdict).toBe(
        "accepted",
      );
      expect(
        f.host.controlConnection({
          kind: "respond",
          offerId: first.offerId,
          outcome: { kind: "answer", text: "Independent response" },
        }).verdict,
      ).toBe("accepted");
      if (recovery === "new-document")
        expect(
          (
            await f.host.writeArtifact({
              artifactId: "changed",
              author: "human",
              bytes: "<p>New current reference</p>",
              contentType: "text/html",
              version: 1,
            })
          ).verdict,
        ).toBe("accepted");
      const next = await listenNativeFeedback(
        { ...options, source: recovery === "new-document" ? "continuation" : "explicit" },
        deps,
      );
      expect(next.kind).toBe("offered");
      if (next.kind !== "offered") throw new Error(next.kind);
      expect(next.payload).toContain("Keep this exact original feedback");
      const fresh = viewConversation(f.paths.dir);
      expect(fresh.state.connection?.offers[next.offerId]?.offer.inputId).toBe("held-original");
      expect(fresh.state.connection?.heldInputs["held-original"]).toBeUndefined();
      expect(fresh.state.appliedInputs["held-original"]).toBeUndefined();
      expect(fresh.transcript.inputs.map((input) => input.id)).toEqual([
        "held-original",
        "independent",
      ]);
      expect(encodes).toBe(3);
    } finally {
      f.close();
    }
  }
});

test("native preparation holds unsupported historical content without dropping it or dispatching feedback", async () => {
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
          turnId: "previous-native-turn",
          event: { kind: "future-native-result", content: "Retain this unclassified evidence" },
        }),
      ).verdict,
    ).toBe("accepted");
    expect(
      f.host.handleFrame(JSON.stringify({ kind: "detach", epoch: 1, reason: "shutdown" })).verdict,
    ).toBe("accepted");
    expect(
      f.host.writeConnection({
        actionId: crypto.randomUUID(),
        binding: f.controls.registration,
        kind: "bound",
      }).verdict,
    ).toBe("accepted");
    expect(f.host.writeConnection(f.enableFact()).verdict).toBe("accepted");
    expect(
      f.host.acceptInput({
        id: "unclassified-context",
        text: "Continue with all evidence",
        mode: "queue",
      }).verdict,
    ).toBe("accepted");
    const seq = f.host.state().seq;
    let encodes = 0;
    const prepared = prepareNativeFeedback(f.host, "unclassified-context", {
      encode: (prompt) => {
        encodes += 1;
        return prompt;
      },
      maxBytes: 100_000,
    });
    expect(prepared.kind).toBe("held");
    if (prepared.kind === "held") expect(prepared.reason).toBe("context-unavailable");
    expect(encodes).toBe(0);
    const fresh = viewConversation(f.paths.dir);
    expect(fresh.state.seq).toBe(seq);
    expect(Object.keys(fresh.state.connection?.offers ?? {})).toHaveLength(0);
    expect(fresh.transcript.events[0]?.event.content).toBe("Retain this unclassified evidence");
    expect(fresh.state.inputs.find((input) => input.id === "unclassified-context")?.text).toBe(
      "Continue with all evidence",
    );
  } finally {
    f.close();
  }
});

test("native encoding failure leaves feedback intact and permits a later preparation", async () => {
  const f = boundFixture();
  try {
    f.acquire();
    expect(f.host.writeConnection(f.enableFact()).verdict).toBe("accepted");
    expect(
      f.host.acceptInput({
        id: "encoding-failure",
        text: "Keep the original request",
        mode: "queue",
      }).verdict,
    ).toBe("accepted");
    const seq = f.host.state().seq;
    const failed = prepareNativeFeedback(f.host, "encoding-failure", {
      encode: () => {
        throw new Error("Native output encoder unavailable");
      },
      maxBytes: 100_000,
    });
    expect(failed.kind).toBe("held");
    if (failed.kind === "held") expect(failed.reason).toBe("transport-encoding-failed");
    expect(f.host.state().seq).toBe(seq);
    expect(Object.keys(f.host.state().connection?.offers ?? {})).toHaveLength(0);
    const prepared = prepareNativeFeedback(f.host, "encoding-failure", {
      encode: (prompt) => JSON.stringify({ decision: "block", reason: prompt }),
      maxBytes: 100_000,
    });
    expect(prepared.kind).toBe("ready");
    if (prepared.kind !== "ready") throw new Error(prepared.kind);
    expect(JSON.parse(prepared.payload).reason).toContain("Keep the original request");
    expect(f.host.writeConnection(prepared.fact).verdict).toBe("accepted");
  } finally {
    f.close();
  }
});

test("native preparation holds feedback when the transport has no verified finite output limit", async () => {
  const f = boundFixture();
  try {
    f.acquire();
    expect(f.host.writeConnection(f.enableFact()).verdict).toBe("accepted");
    expect(
      f.host.acceptInput({ id: "unverified-limit", text: "Keep this feedback", mode: "queue" })
        .verdict,
    ).toBe("accepted");
    const seq = f.host.state().seq;
    let encodes = 0;
    for (const maxBytes of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5]) {
      const result = prepareNativeFeedback(f.host, "unverified-limit", {
        encode: (prompt) => {
          encodes += 1;
          return prompt;
        },
        maxBytes,
      });
      expect(result.kind).toBe("held");
      if (result.kind === "held") expect(result.reason).toBe("transport-unverified");
    }
    expect(encodes).toBe(0);
    expect(f.host.state().seq).toBe(seq);
    expect(f.host.state().inputs.find((input) => input.id === "unverified-limit")?.text).toBe(
      "Keep this feedback",
    );
    expect(Object.keys(f.host.state().connection?.offers ?? {})).toHaveLength(0);
  } finally {
    f.close();
  }
});

test("native preparation measures the complete encoded payload and holds oversized feedback intact", async () => {
  const f = boundFixture();
  try {
    f.acquire();
    expect(f.host.writeConnection(f.enableFact()).verdict).toBe("accepted");
    const text = `${'Quoted "words" and emoji 🎯. '.repeat(100)}END-OF-FEEDBACK`;
    expect(f.host.acceptInput({ id: "large-feedback", text, mode: "queue" }).verdict).toBe(
      "accepted",
    );
    const encode = (prompt: string) => JSON.stringify({ decision: "block", reason: prompt });
    const full = prepareNativeFeedback(f.host, "large-feedback", { encode, maxBytes: 1_000_000 });
    expect(full.kind).toBe("ready");
    if (full.kind !== "ready") throw new Error(full.kind);
    const bytes = Buffer.byteLength(full.payload);
    const seq = f.host.state().seq;
    const held = prepareNativeFeedback(f.host, "large-feedback", { encode, maxBytes: bytes - 1 });
    expect(held.kind).toBe("held");
    if (held.kind === "held") expect(held.reason).toBe("context-too-large");
    expect(f.host.state().seq).toBe(seq);
    expect(f.host.state().inputs.find((input) => input.id === "large-feedback")?.text).toBe(text);
    expect(Object.values(f.host.state().connection?.offers ?? {})).toHaveLength(0);
    const fits = prepareNativeFeedback(f.host, "large-feedback", { encode, maxBytes: bytes });
    expect(fits.kind).toBe("ready");
    if (fits.kind !== "ready") throw new Error(fits.kind);
    expect(JSON.parse(fits.payload).reason).toContain(text);
    expect(f.host.writeConnection(fits.fact).verdict).toBe("accepted");
  } finally {
    f.close();
  }
});

test("native feedback with an attachment stays held before encoding or dispatch", () => {
  const f = boundFixture();
  try {
    f.acquire();
    expect(f.host.writeConnection(f.enableFact()).verdict).toBe("accepted");
    const text = encodeAnnotationBatch({
      artifactId: "flow",
      version: 1,
      notes: [
        {
          note: "Use the attached screenshot, including its labels.",
          spots: [],
          files: [
            {
              bytes: 4,
              contentType: "image/png",
              hash: "a".repeat(64),
              name: "flow.png",
              path: "/expired-copy/flow.png",
            },
          ],
        },
      ],
    });
    expect(
      f.host.acceptInput({ id: "file-feedback", mode: "queue", text }, { managed: true }).verdict,
    ).toBe("accepted");
    const seq = f.host.state().seq;
    let encodes = 0;
    const result = prepareNativeFeedback(f.host, "file-feedback", {
      encode: (prompt) => {
        encodes += 1;
        return prompt;
      },
      maxBytes: 100_000,
    });
    expect(result.kind).toBe("held");
    if (result.kind === "held") {
      expect(result.reason).toBe("transport-unverified");
      expect(result.message).toContain("attached files");
    }
    expect(encodes).toBe(0);
    const fresh = viewConversation(f.paths.dir);
    expect(fresh.state.seq).toBe(seq);
    expect(fresh.state.inputs.find((input) => input.id === "file-feedback")?.text).toBe(text);
    expect(Object.values(fresh.state.connection?.offers ?? {})).toHaveLength(0);
  } finally {
    f.close();
  }
});

test("uninterpretable native attachment references cannot bypass complete-context admission", () => {
  const f = boundFixture();
  try {
    f.acquire();
    expect(f.host.writeConnection(f.enableFact()).verdict).toBe("accepted");
    const text = encodeAnnotationBatch({
      artifactId: "flow",
      version: 1,
      notes: [
        {
          note: "Use the file",
          spots: [],
          files: [
            {
              bytes: 4,
              contentType: "image/png",
              hash: "invalid",
              name: "flow.png",
              path: "/unverified/flow.png",
            },
          ],
        },
      ],
    });
    expect(f.host.acceptInput({ id: "malformed-file", mode: "queue", text }).verdict).toBe(
      "accepted",
    );
    let encodes = 0;
    const result = prepareNativeFeedback(f.host, "malformed-file", {
      encode: (prompt) => {
        encodes += 1;
        return prompt;
      },
      maxBytes: 100_000,
    });
    expect(result.kind).toBe("held");
    expect(encodes).toBe(0);
    expect(f.host.state().inputs.find((input) => input.id === "malformed-file")?.text).toBe(text);
    expect(Object.values(f.host.state().connection?.offers ?? {})).toHaveLength(0);
  } finally {
    f.close();
  }
});

test("verified native file transport offers complete copies with current locations", () => {
  const f = boundFixture(false);
  const owner = readProcessOwner(process.pid);
  if (!owner) throw new Error("Missing native fixture owner");
  let discard: (() => void) | undefined;
  try {
    f.controls.registration = { ...f.controls.registration, owner };
    expect(
      f.host.writeConnection({
        actionId: crypto.randomUUID(),
        binding: f.controls.registration,
        kind: "bound",
      }).verdict,
    ).toBe("accepted");
    f.acquire();
    expect(f.host.writeConnection(f.enableFact()).verdict).toBe("accepted");
    const bytes = Buffer.from([137, 80, 78, 71, 0, 255, 10]);
    const hash = putBlob(f.paths.dir, bytes);
    const text = encodeAnnotationBatch({
      artifactId: "flow",
      version: 1,
      notes: [
        {
          note: "Inspect every pixel",
          spots: [],
          files: [
            {
              bytes: bytes.length,
              contentType: "image/png",
              hash,
              name: "flow.png",
              path: "/expired/flow.png",
            },
          ],
        },
      ],
    });
    expect(f.host.acceptInput({ id: "complete-file", mode: "queue", text }).verdict).toBe(
      "accepted",
    );
    const result = prepareNativeFeedback(f.host, "complete-file", {
      encode: (prompt) => prompt,
      files: "local",
      maxBytes: 100_000,
    });
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error(result.kind);
    discard = result.discard;
    const manifest = JSON.parse(
      result.payload.split("\n\n").find((part) => part.startsWith('[{"entryId"')) ?? "null",
    ) as { entryId: string; hash: string; path: string }[];
    expect(manifest).toHaveLength(1);
    const file = manifest[0];
    if (!file) throw new Error("Missing file manifest");
    expect(file.entryId).toBe("input:complete-file");
    expect(file.hash).toBe(hash);
    expect(file.path).not.toBe("/expired/flow.png");
    expect(file.path.startsWith(f.paths.dir)).toBe(false);
    expect(readFileSync(file.path)).toEqual(bytes);
    expect(result.payload).toContain(text);
    expect(result.payload).toContain("Use these locations instead of recorded historical paths");
    expect(f.host.writeConnection(result.fact).verdict).toBe("accepted");
  } finally {
    discard?.();
    f.close();
  }
});

// Confirm that already implemented pre-dispatch failures dispose prepared file copies.
test("native file copies are removed when final transport encoding exceeds its limit", () => {
  const f = boundFixture(false);
  const owner = readProcessOwner(process.pid);
  if (!owner) throw new Error("Missing native fixture owner");
  let copiedPath = "";
  try {
    f.controls.registration = { ...f.controls.registration, owner };
    expect(
      f.host.writeConnection({
        actionId: crypto.randomUUID(),
        binding: f.controls.registration,
        kind: "bound",
      }).verdict,
    ).toBe("accepted");
    f.acquire();
    expect(f.host.writeConnection(f.enableFact()).verdict).toBe("accepted");
    const bytes = Buffer.from("all attachment bytes");
    const text = encodeAnnotationBatch({
      artifactId: "flow",
      version: 1,
      notes: [
        {
          note: "Read all bytes",
          spots: [],
          files: [
            {
              bytes: bytes.length,
              contentType: "text/plain",
              hash: putBlob(f.paths.dir, bytes),
              name: "notes.txt",
            },
          ],
        },
      ],
    });
    expect(f.host.acceptInput({ id: "oversized-file-offer", mode: "queue", text }).verdict).toBe(
      "accepted",
    );
    const result = prepareNativeFeedback(f.host, "oversized-file-offer", {
      encode: (prompt) => {
        const manifest = JSON.parse(
          prompt.split("\n\n").find((part) => part.startsWith('[{"entryId"')) ?? "null",
        ) as { path: string }[];
        copiedPath = manifest[0]?.path ?? "";
        expect(readFileSync(copiedPath)).toEqual(bytes);
        return prompt;
      },
      files: "local",
      maxBytes: 1,
    });
    expect(result.kind).toBe("held");
    if (result.kind === "held") expect(result.reason).toBe("context-too-large");
    expect(copiedPath).not.toBe("");
    expect(existsSync(copiedPath)).toBe(false);
    expect(f.host.state().inputs.find((input) => input.id === "oversized-file-offer")?.text).toBe(
      text,
    );
    expect(Object.values(f.host.state().connection?.offers ?? {})).toHaveLength(0);
  } finally {
    f.close();
  }
});

function preparedNativeFileFixture(): {
  readonly bytes: Buffer<ArrayBuffer>;
  readonly close: () => void;
  readonly f: BoundFixture;
  readonly offerId: string;
  readonly path: string;
} {
  const f = boundFixture(false);
  const owner = readProcessOwner(process.pid);
  if (!owner) throw new Error("Missing native fixture owner");
  let discard: (() => void) | undefined;
  try {
    f.controls.registration = { ...f.controls.registration, owner };
    expect(
      f.host.writeConnection({
        actionId: crypto.randomUUID(),
        binding: f.controls.registration,
        kind: "bound",
      }).verdict,
    ).toBe("accepted");
    f.acquire();
    expect(f.host.writeConnection(f.enableFact()).verdict).toBe("accepted");
    const bytes = Buffer.from("complete attachment");
    const text = encodeAnnotationBatch({
      artifactId: "flow",
      version: 1,
      notes: [
        {
          note: "Read before responding",
          spots: [],
          files: [
            {
              bytes: bytes.length,
              contentType: "text/plain",
              hash: putBlob(f.paths.dir, bytes),
              name: "notes.txt",
            },
          ],
        },
      ],
    });
    expect(f.host.acceptInput({ id: "settled-file", mode: "queue", text }).verdict).toBe(
      "accepted",
    );
    const result = prepareNativeFeedback(f.host, "settled-file", {
      encode: (prompt) => prompt,
      files: "local",
      maxBytes: 100_000,
    });
    if (result.kind !== "ready") throw new Error(result.kind);
    discard = result.discard;
    const manifest = JSON.parse(
      result.payload.split("\n\n").find((part) => part.startsWith('[{"entryId"')) ?? "null",
    ) as { path: string }[];
    const path = manifest[0]?.path ?? "";
    expect(f.host.writeConnection(result.fact).verdict).toBe("accepted");
    const offerId = result.fact.offer.id;
    return {
      f,
      bytes,
      path,
      offerId,
      close: () => {
        discard?.();
        f.close();
      },
    };
  } catch (cause) {
    discard?.();
    f.close();
    throw cause;
  }
}

test("binding during executor acquisition refuses authority and releases the acquired lock", () => {
  const f = boundFixture(false);
  let kernelLease: PresenceHandle | undefined;
  try {
    const admitted = f.host.acquireExecutor({ kind: "headless" }, () => {
      kernelLease = acquirePresence(f.paths.dir, "feedback", { timeoutMs: 0 });
      expect(
        f.host.writeConnection({
          actionId: crypto.randomUUID(),
          binding: f.controls.registration,
          kind: "bound",
        }).verdict,
      ).toBe("accepted");
      return kernelLease;
    });
    expect(admitted).toEqual({ verdict: "refused", issue: "connection-not-admitted" });
    expect(kernelLease?.held()).toBe(false);
    expect(presenceHeld(f.paths.dir)).toBe(false);
    expect(viewConversation(f.paths.dir).state.connection?.binding).toEqual(
      f.controls.registration,
    );
    expect(viewConversation(f.paths.dir).state.attachment).toBeNull();
  } finally {
    kernelLease?.release();
    f.close();
  }
});

test("a departed bound owner admits an explicit native worker without recording a launch", () => {
  const f = boundFixture();
  let lease: PresenceHandle | undefined;
  try {
    expect(
      f.host.acceptInput(
        { id: "native-work", mode: "queue", text: "Continue the same session" },
        { managed: true },
      ).verdict,
    ).toBe("accepted");
    f.controls.probe = () => false;
    const before = f.host.state().seq;
    const admission = f.host.acquireExecutor(
      {
        kind: "native-headless",
        binding: f.controls.registration,
        inputId: "native-work",
      },
      () => {
        lease = acquirePresence(f.paths.dir, "feedback", { timeoutMs: 0 });
        return lease;
      },
    );
    expect(admission.verdict).toBe("accepted");
    if (admission.verdict !== "accepted") throw new Error(admission.issue);
    f.controls.lease = admission.lease;
    expect(admission.lease.held()).toBe(true);
    expect(f.host.state().seq).toBe(before);
    expect(f.host.state().attachment).toBeNull();
    expect(f.host.state().connection?.launches).toEqual({});
  } finally {
    lease?.release();
    f.close();
  }
});

test("an admitted native worker attaches once on its acquired lease and preserves the bound session", () => {
  const f = boundFixture();
  try {
    expect(
      f.host.acceptInput(
        { id: "native-attach", mode: "queue", text: "Continue here" },
        { managed: true },
      ).verdict,
    ).toBe("accepted");
    f.controls.probe = () => false;
    const admission = f.host.acquireExecutor(
      { binding: f.controls.registration, inputId: "native-attach", kind: "native-headless" },
      () => acquirePresence(f.paths.dir, "feedback", { timeoutMs: 0 }),
    );
    if (admission.verdict !== "accepted") throw new Error(admission.issue);
    f.controls.lease = admission.lease;
    const frame = JSON.stringify(
      attach({
        attachmentOrigin: "automatic",
        capabilities: ["managed-input-v1"],
        conversationId: "feedback",
        harness: "codex",
        profile: "headless-turn",
        secret: readFileSync(f.paths.secretPath, "utf8").trim(),
      }),
    );
    const attachedResult = f.host.handleFrame(frame);
    if (attachedResult.verdict === "refused") throw new Error(attachedResult.issue);
    expect(attachedResult.verdict).toBe("accepted");
    expect(f.host.state().attachment).toMatchObject({ harness: "codex", profile: "headless-turn" });
    expect(f.host.state().connection?.binding).toEqual(f.controls.registration);
    expect(f.host.state().connection?.launches).toEqual({});
    const attached = f.host.state();
    expect(f.host.handleFrame(frame)).toMatchObject({
      issue: "connection-not-admitted",
      verdict: "refused",
    });
    expect(viewConversation(f.paths.dir).state).toEqual(attached);
  } finally {
    f.close();
  }
});

test("cancelling the admitted input prevents native attachment and keeps later feedback queued", () => {
  const f = boundFixture();
  try {
    for (const id of ["withdraw", "keep"])
      expect(f.host.acceptInput({ id, mode: "queue", text: id }, { managed: true }).verdict).toBe(
        "accepted",
      );
    f.controls.probe = () => false;
    const admission = f.host.acquireExecutor(
      { binding: f.controls.registration, inputId: "withdraw", kind: "native-headless" },
      () => acquirePresence(f.paths.dir, "feedback", { timeoutMs: 0 }),
    );
    if (admission.verdict !== "accepted") throw new Error(admission.issue);
    f.controls.lease = admission.lease;
    const writer = openWriter(f.paths.dir);
    try {
      expect(writer.controlConnection({ inputId: "withdraw", kind: "cancel-input" }).verdict).toBe(
        "accepted",
      );
    } finally {
      writer.close();
    }
    expect(
      f.host.handleFrame(
        JSON.stringify(
          attach({
            attachmentOrigin: "automatic",
            capabilities: ["managed-input-v1"],
            conversationId: "feedback",
            harness: "codex",
            profile: "headless-turn",
            secret: f.host.state().secret,
          }),
        ),
      ),
    ).toMatchObject({ issue: "execution-ineligible", verdict: "refused" });
    expect(f.host.state().attachment).toBeNull();
    expect(f.host.state().connection?.launches).toEqual({});
    expect(f.host.transcript().inputs.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "withdraw", status: "cancelled" },
      { id: "keep", status: "outstanding" },
    ]);
  } finally {
    f.close();
  }
});

test("a replacement raw lease cannot reuse a native worker's released admission", () => {
  const f = boundFixture();
  try {
    expect(
      f.host.acceptInput({ id: "native-lock", mode: "queue", text: "Keep this" }, { managed: true })
        .verdict,
    ).toBe("accepted");
    f.controls.probe = () => false;
    const admission = f.host.acquireExecutor(
      { binding: f.controls.registration, inputId: "native-lock", kind: "native-headless" },
      () => acquirePresence(f.paths.dir, "feedback", { timeoutMs: 0 }),
    );
    if (admission.verdict !== "accepted") throw new Error(admission.issue);
    admission.lease.release();
    f.acquire();
    const before = f.host.state();
    expect(
      f.host.handleFrame(
        JSON.stringify(
          attach({
            attachmentOrigin: "automatic",
            capabilities: ["managed-input-v1"],
            conversationId: "feedback",
            harness: "codex",
            profile: "headless-turn",
            secret: f.host.state().secret,
          }),
        ),
      ),
    ).toMatchObject({ issue: "connection-not-admitted", verdict: "refused" });
    expect(f.controls.lease?.held()).toBe(true);
    expect(viewConversation(f.paths.dir).state).toEqual(before);
  } finally {
    f.close();
  }
});

test("native attachment reports unknown ownership after admission without changing the record", () => {
  const f = boundFixture();
  try {
    expect(
      f.host.acceptInput(
        { id: "native-probe", mode: "queue", text: "Keep this" },
        { managed: true },
      ).verdict,
    ).toBe("accepted");
    f.controls.probe = () => false;
    const admission = f.host.acquireExecutor(
      { binding: f.controls.registration, inputId: "native-probe", kind: "native-headless" },
      () => acquirePresence(f.paths.dir, "feedback", { timeoutMs: 0 }),
    );
    if (admission.verdict !== "accepted") throw new Error(admission.issue);
    f.controls.lease = admission.lease;
    f.controls.probe = () => undefined;
    const before = f.host.state();
    expect(
      f.host.handleFrame(
        JSON.stringify(
          attach({
            attachmentOrigin: "automatic",
            capabilities: ["managed-input-v1"],
            conversationId: "feedback",
            harness: "codex",
            profile: "headless-turn",
            secret: f.host.state().secret,
          }),
        ),
      ),
    ).toMatchObject({ issue: "connection-unverified", verdict: "refused" });
    expect(viewConversation(f.paths.dir).state).toEqual(before);
  } finally {
    f.close();
  }
});

test("a returning registration during native admission releases the lock and prevents a later attach", () => {
  const f = boundFixture();
  let lease: PresenceHandle | undefined;
  try {
    expect(
      f.host.acceptInput(
        { id: "registry-race", mode: "queue", text: "Wait for me" },
        { managed: true },
      ).verdict,
    ).toBe("accepted");
    const returning = returningRegistration(f.controls.registration);
    let present: boolean | undefined = false;
    f.controls.probe = (owner) => (owner.pid === returning.owner.pid ? present : false);
    const request = {
      binding: f.controls.registration,
      inputId: "registry-race",
      kind: "native-headless" as const,
    };
    const before = f.host.state();
    expect(
      f.host.acquireExecutor(request, () => {
        lease = acquirePresence(f.paths.dir, "feedback", { timeoutMs: 0 });
        expect(
          registerNativeSession(returning.workingDirectory, returning, {
            callerOwns: () => true,
            ownerPresence: () => true,
          }),
        ).toMatchObject({ ok: true });
        present = true;
        return lease;
      }),
    ).toEqual({ issue: "connection-conflict", verdict: "refused" });
    expect(lease?.held()).toBe(false);
    present = undefined;
    expect(
      f.host.acquireExecutor(request, () => {
        throw new Error("Unknown registered owner must prevent lock acquisition");
      }),
    ).toEqual({ issue: "connection-unverified", verdict: "refused" });
    present = false;
    const admitted = f.host.acquireExecutor(request, () =>
      acquirePresence(f.paths.dir, "feedback", { timeoutMs: 0 }),
    );
    if (admitted.verdict !== "accepted") throw new Error(admitted.issue);
    f.controls.lease = admitted.lease;
    present = true;
    expect(
      f.host.handleFrame(
        JSON.stringify(
          attach({
            attachmentOrigin: "automatic",
            capabilities: ["managed-input-v1"],
            conversationId: "feedback",
            harness: "codex",
            profile: "headless-turn",
            secret: f.host.state().secret,
          }),
        ),
      ),
    ).toMatchObject({ issue: "connection-conflict", verdict: "refused" });
    expect(viewConversation(f.paths.dir).state).toEqual(before);
  } finally {
    lease?.release();
    f.close();
  }
});

test("native admission cannot attach a different harness", () => {
  const f = boundFixture();
  try {
    expect(
      f.host.acceptInput(
        { id: "wrong-harness", mode: "queue", text: "Keep Codex" },
        { managed: true },
      ).verdict,
    ).toBe("accepted");
    f.controls.probe = () => false;
    const admitted = f.host.acquireExecutor(
      { binding: f.controls.registration, inputId: "wrong-harness", kind: "native-headless" },
      () => acquirePresence(f.paths.dir, "feedback", { timeoutMs: 0 }),
    );
    if (admitted.verdict !== "accepted") throw new Error(admitted.issue);
    f.controls.lease = admitted.lease;
    const before = f.host.state();
    expect(
      f.host.handleFrame(
        JSON.stringify(
          attach({
            attachmentOrigin: "automatic",
            capabilities: ["managed-input-v1"],
            conversationId: "feedback",
            harness: "muse",
            profile: "headless-turn",
            secret: f.host.state().secret,
          }),
        ),
      ),
    ).toMatchObject({ issue: "connection-not-admitted", verdict: "refused" });
    expect(viewConversation(f.paths.dir).state).toEqual(before);
  } finally {
    f.close();
  }
});

test("native dispatch rechecks a returning owner after preparation and invokes the admitted attempt once", () => {
  const f = boundFixture();
  try {
    expect(
      f.host.acceptInput(
        { id: "dispatch-race", mode: "queue", text: "Continue" },
        { managed: true },
      ).verdict,
    ).toBe("accepted");
    f.controls.probe = () => false;
    const admitted = f.host.acquireExecutor(
      { binding: f.controls.registration, inputId: "dispatch-race", kind: "native-headless" },
      () => acquirePresence(f.paths.dir, "feedback", { timeoutMs: 0 }),
    );
    if (admitted.verdict !== "accepted") throw new Error(admitted.issue);
    f.controls.lease = admitted.lease;
    expect(
      f.host.handleFrame(
        JSON.stringify(
          attach({
            attachmentOrigin: "automatic",
            capabilities: ["managed-input-v1"],
            conversationId: "feedback",
            harness: "codex",
            profile: "headless-turn",
            secret: f.host.state().secret,
          }),
        ),
      ).verdict,
    ).toBe("accepted");
    const prepared = preparedAttempt(f, "dispatch-race");
    expect(f.host.writePreparedExecution(prepared.fact, prepared.stamp).verdict).toBe("accepted");
    const before = f.host.state();
    let invocations = 0;
    const invoke = (): undefined => {
      invocations++;
    };
    f.controls.probe = () => true;
    expect(f.host.dispatchNativeExecution(prepared.fact.turnId, invoke)).toEqual({
      issue: "connection-conflict",
      verdict: "refused",
    });
    expect(invocations).toBe(0);
    expect(viewConversation(f.paths.dir).state).toEqual(before);
    f.controls.probe = () => false;
    expect(f.host.dispatchNativeExecution(prepared.fact.turnId, invoke)).toEqual({
      verdict: "accepted",
    });
    expect(invocations).toBe(1);
    expect(f.host.dispatchNativeExecution(prepared.fact.turnId, invoke)).toEqual({
      issue: "connection-not-admitted",
      verdict: "refused",
    });
    expect(invocations).toBe(1);
    expect(
      f.host.transcript().events.filter(({ event }) => event.kind === EventKind.message),
    ).toHaveLength(1);
  } finally {
    f.close();
  }
});

test("native launch start requires its recorded session identity and retains the launch reservation", () => {
  const f = boundFixture();
  try {
    expect(
      f.host.acceptInput({ id: "native-start", mode: "queue", text: "Continue" }, { managed: true })
        .verdict,
    ).toBe("accepted");
    f.controls.probe = () => false;
    const admitted = f.host.acquireExecutor(
      { binding: f.controls.registration, inputId: "native-start", kind: "native-headless" },
      () => acquirePresence(f.paths.dir, "feedback", { timeoutMs: 0 }),
    );
    if (admitted.verdict !== "accepted") throw new Error(admitted.issue);
    f.controls.lease = admitted.lease;
    expect(
      f.host.handleFrame(
        JSON.stringify(
          attach({
            attachmentOrigin: "automatic",
            capabilities: ["managed-input-v1"],
            conversationId: "feedback",
            harness: "codex",
            profile: "headless-turn",
            secret: f.host.state().secret,
          }),
        ),
      ).verdict,
    ).toBe("accepted");
    const prepared = preparedAttempt(f, "native-start");
    expect(f.host.writePreparedExecution(prepared.fact, prepared.stamp).verdict).toBe("accepted");
    const launch = Object.values(f.host.state().connection?.launches ?? {})[0]?.launch;
    if (!launch) throw new Error("Missing prepared launch");
    const started = { actionId: crypto.randomUUID(), kind: "launch-started", launchId: launch.id };
    expect(f.host.writeConnection(started).verdict).toBe("refused");
    expect(f.host.dispatchNativeExecution(prepared.fact.turnId, () => undefined).verdict).toBe(
      "accepted",
    );
    expect(
      f.host.handleFrame(
        JSON.stringify({
          kind: "event",
          epoch: f.host.state().epoch,
          n: 1,
          turnId: prepared.fact.turnId,
          event: {
            kind: EventKind.identity,
            authority: "harness-minted",
            sessionId: f.controls.registration.nativeSessionId,
          },
        }),
      ).verdict,
    ).toBe("accepted");
    expect(f.host.writeConnection(started).verdict).toBe("accepted");
    expect(f.host.state().connection?.launches[launch.id]).toMatchObject({
      kind: "started",
      launch,
    });
    const before = f.host.state();
    expect(f.host.writeConnection(started).verdict).toBe("accepted");
    expect(viewConversation(f.paths.dir).state).toEqual(before);
    expect(
      f.host.transcript().events.filter(({ event }) => event.kind === EventKind.message),
    ).toHaveLength(1);
    expect(
      f.host.writeConnection({
        actionId: crypto.randomUUID(),
        kind: "launch-intended",
        launch: { ...launch, id: crypto.randomUUID() },
      }).verdict,
    ).toBe("refused");
    const cleanup = { kind: "settled" as const, turnId: prepared.fact.turnId };
    expect(f.host.recordNativeExecution(cleanup).verdict).toBe("refused");
    expect(
      f.host.handleFrame(
        JSON.stringify({
          kind: "event",
          epoch: f.host.state().epoch,
          n: 2,
          turnId: prepared.fact.turnId,
          event: { kind: EventKind.done, cause: "clean", exitCode: 0 },
        }),
      ).verdict,
    ).toBe("accepted");
    expect(
      f.host.writeExecution({
        kind: "attempt-ended",
        inputId: prepared.fact.inputId,
        attempt: prepared.fact.attempt,
        turnId: prepared.fact.turnId,
        outcome: {
          kind: "completed",
          terminalSeq: f.host.state().completedTurns[prepared.fact.turnId],
        },
      }).verdict,
    ).toBe("accepted");
    expect(
      f.host.writeConnection({
        actionId: crypto.randomUUID(),
        kind: "launch-settled",
        launchId: launch.id,
      }).verdict,
    ).toBe("refused");
    expect(f.host.recordNativeExecution(cleanup).verdict).toBe("accepted");
    expect(f.host.state().connection?.launches[launch.id]).toMatchObject({
      kind: "settled",
      launch,
      outcome: { kind: "completed" },
      start: { identitySeq: expect.any(Number), actionId: started.actionId },
    });
    const cleaned = f.host.state();
    expect(f.host.recordNativeExecution(cleanup).verdict).toBe("accepted");
    expect(viewConversation(f.paths.dir).state).toEqual(cleaned);
  } finally {
    f.close();
  }
});

test("a reconnect reservation survives replay and fences native executor acquisition without taking its lease", () => {
  const f = boundFixture();
  try {
    expect(
      f.host.acceptInput(
        { id: "reconnect-input", mode: "queue", text: "Saved feedback" },
        { managed: true },
      ).verdict,
    ).toBe("accepted");
    f.controls.probe = () => false;
    const requester = readProcessOwner(process.pid);
    if (!requester) throw new Error("Missing requester provenance");
    const request = {
      id: crypto.randomUUID(),
      requester: {
        executable: requester.executable,
        pid: requester.pid,
        startedAt: requester.startedAt,
      },
    };
    const fact = { actionId: crypto.randomUUID(), kind: "reconnect-requested", request };
    expect(f.host.writeConnection(fact).verdict).toBe("accepted");
    expect(presenceHeld(f.paths.dir)).toBe(false);
    const reserved = f.host.state();
    expect(f.host.writeConnection(fact).verdict).toBe("accepted");
    expect(viewConversation(f.paths.dir).state).toEqual(reserved);
    expect(reserved.connection?.reconnects[request.id]).toMatchObject({
      kind: "requested",
      request,
    });
    let acquired = false;
    expect(
      f.host.acquireExecutor(
        { kind: "native-headless", binding: f.controls.registration, inputId: "reconnect-input" },
        () => {
          acquired = true;
          return acquirePresence(f.paths.dir, "feedback", { timeoutMs: 0 });
        },
      ).verdict,
    ).toBe("refused");
    expect(acquired).toBe(false);
    expect(f.host.state().inputs).toHaveLength(1);
    expect(
      f.host.writeConnection({
        actionId: crypto.randomUUID(),
        kind: "reconnect-withdrawn",
        requestId: crypto.randomUUID(),
      }).verdict,
    ).toBe("refused");
    const withdrawal = {
      actionId: crypto.randomUUID(),
      kind: "reconnect-withdrawn",
      requestId: request.id,
    };
    expect(f.host.writeConnection(withdrawal).verdict).toBe("accepted");
    const cancelled = f.host.state();
    expect(cancelled.connection?.reconnectId).toBeNull();
    expect(cancelled.connection?.reconnects[request.id]).toMatchObject({
      kind: "withdrawn",
      request,
    });
    expect(f.host.writeConnection(withdrawal).verdict).toBe("accepted");
    expect(f.host.writeConnection(fact).verdict).toBe("accepted");
    expect(viewConversation(f.paths.dir).state).toEqual(cancelled);
    expect(f.host.state().inputs).toHaveLength(1);
    const admitted = f.host.acquireExecutor(
      { kind: "native-headless", binding: f.controls.registration, inputId: "reconnect-input" },
      () => acquirePresence(f.paths.dir, "feedback", { timeoutMs: 0 }),
    );
    if (admitted.verdict !== "accepted") throw new Error(admitted.issue);
    f.controls.lease = admitted.lease;
    expect(admitted.lease.held()).toBe(true);
  } finally {
    f.close();
  }
});

test("reconnect controls report one existing request and cancel only its named wait", () => {
  const f = boundFixture();
  try {
    expect(f.host.controlReconnect({ kind: "request" }).verdict).toBe("refused");
    f.controls.probe = () => undefined;
    expect(f.host.controlReconnect({ kind: "request" }).verdict).toBe("refused");
    f.controls.probe = () => false;
    expect(f.host.controlReconnect({ kind: "request" }).verdict).toBe("accepted");
    const reserved = f.host.state();
    const requestId = reserved.connection?.reconnectId;
    if (!requestId) throw new Error("Missing reconnect request");
    const pending = reserved.connection?.reconnects[requestId];
    if (!pending) throw new Error("Missing request history");
    expect(presenceHeld(f.paths.dir)).toBe(false);
    const statusBefore = f.host.state();
    expect(f.status()).toMatchObject({
      state: "reconnect-waiting",
      reason: "reconnect-pending",
      message: "Waiting to reconnect to the same native session. Saved feedback is held.",
      actions: [],
    });
    expect(f.host.state()).toEqual(statusBefore);
    const repeated = withNativeSessionAdmission(
      f.controls.registration.workingDirectory,
      f.controls.registration,
      () => false,
      () => [
        f.host.controlReconnect({ kind: "request" }).verdict,
        f.host.writeConnection({
          actionId: pending.requestedActionId,
          kind: "reconnect-requested",
          request: pending.request,
        }).verdict,
      ],
    );
    expect(repeated).toEqual({ ok: true, value: ["accepted", "accepted"] });
    expect(f.host.state()).toEqual(reserved);
    expect(
      f.host.controlReconnect({ kind: "cancel", requestId: crypto.randomUUID() }).verdict,
    ).toBe("refused");
    expect(f.host.controlReconnect({ kind: "cancel", requestId }).verdict).toBe("accepted");
    expect(f.host.controlReconnect({ kind: "request" }).verdict).toBe("accepted");
    const next = f.host.state();
    expect(next.connection?.reconnectId).not.toBe(requestId);
    expect(f.host.controlReconnect({ kind: "cancel", requestId }).verdict).toBe("accepted");
    expect(viewConversation(f.paths.dir).state).toEqual(next);
  } finally {
    f.close();
  }
});

test("a reconnect reservation arriving during raw lease acquisition prevents executor authority", () => {
  const f = boundFixture();
  let lease: PresenceHandle | undefined;
  try {
    expect(
      f.host.acceptInput(
        { id: "reconnect-race", mode: "queue", text: "Preserve this feedback" },
        { managed: true },
      ).verdict,
    ).toBe("accepted");
    f.controls.probe = () => false;
    const admitted = f.host.acquireExecutor(
      { kind: "native-headless", binding: f.controls.registration, inputId: "reconnect-race" },
      () => {
        lease = acquirePresence(f.paths.dir, "feedback", { timeoutMs: 0 });
        expect(f.host.controlReconnect({ kind: "request" }).verdict).toBe("accepted");
        return lease;
      },
    );
    expect(admitted.verdict).toBe("refused");
    expect(lease?.held()).toBe(false);
    expect(presenceHeld(f.paths.dir)).toBe(false);
    expect(f.host.state().connection?.reconnectId).toBeString();
    expect(f.host.state().inputs).toHaveLength(1);
  } finally {
    lease?.release();
    f.close();
  }
});

test("native admission releases its lock when the departed owner returns during acquisition", () => {
  const f = boundFixture();
  let lease: PresenceHandle | undefined;
  try {
    expect(
      f.host.acceptInput(
        { id: "native-race", mode: "queue", text: "Keep this queued" },
        { managed: true },
      ).verdict,
    ).toBe("accepted");
    f.controls.probe = () => false;
    const before = f.host.state();
    const admission = f.host.acquireExecutor(
      { binding: f.controls.registration, inputId: "native-race", kind: "native-headless" },
      () => {
        lease = acquirePresence(f.paths.dir, "feedback", { timeoutMs: 0 });
        f.controls.probe = () => true;
        return lease;
      },
    );
    expect(admission).toEqual({ issue: "connection-conflict", verdict: "refused" });
    expect(lease?.held()).toBe(false);
    expect(presenceHeld(f.paths.dir)).toBe(false);
    expect(viewConversation(f.paths.dir).state).toEqual(before);
  } finally {
    lease?.release();
    f.close();
  }
});

test("terminal ownership appearing during admission prevents executor authority", () => {
  const f = boundFixture(false);
  let kernelLease: PresenceHandle | undefined;
  try {
    const admitted = f.host.acquireExecutor({ kind: "headless" }, () => {
      kernelLease = acquirePresence(f.paths.dir, "feedback", { timeoutMs: 0 });
      const writer = openWriter(f.paths.dir, { ownerPresence: () => true });
      try {
        expect(
          writer.handleFrame(
            JSON.stringify({
              kind: "attach",
              conversationId: "feedback",
              secret: readFileSync(f.paths.secretPath, "utf8").trim(),
              version: 1,
              profile: "interactive",
              harness: "codex",
              owner: f.controls.registration.owner,
            }),
          ).verdict,
        ).toBe("accepted");
        expect(
          writer.handleFrame(JSON.stringify({ kind: "detach", epoch: 1, reason: "yield" })).verdict,
        ).toBe("accepted");
      } finally {
        writer.close();
      }
      return kernelLease;
    });
    expect(admitted).toEqual({ verdict: "refused", issue: "connection-conflict" });
    expect(kernelLease?.held()).toBe(false);
    expect(presenceHeld(f.paths.dir)).toBe(false);
  } finally {
    kernelLease?.release();
    f.close();
  }
});

test("a verified listener acquires authority without recording readiness until its enable write", () => {
  const f = boundFixture();
  try {
    const fact = f.enableFact();
    const before = f.host.state().seq;
    const admission = f.host.acquireExecutor({ kind: "listener", fact }, () =>
      acquirePresence(f.paths.dir, "feedback", { timeoutMs: 0 }),
    );
    expect(admission.verdict).toBe("accepted");
    if (admission.verdict !== "accepted") throw new Error(admission.issue);
    f.controls.lease = admission.lease;
    expect(admission.lease.held()).toBe(true);
    expect(f.host.state().seq).toBe(before);
    expect(f.status().state).toBe("not-listening");
    expect(f.host.writeConnection(fact).verdict).toBe("accepted");
    expect(f.status().state).toBe("listening");
  } finally {
    f.close();
  }
});

test("repeating a saved listener enable cannot grant a new executor during unresolved delivery", () => {
  const f = boundFixture();
  let acquired = false;
  let unexpectedLease: PresenceHandle | undefined;
  try {
    f.acquire();
    const fact = f.enableFact();
    expect(f.host.writeConnection(fact).verdict).toBe("accepted");
    expect(
      f.host.acceptInput({ id: "unsettled", mode: "queue", text: "Keep this delivery singular" })
        .verdict,
    ).toBe("accepted");
    expect(
      f.host.writeConnection(prepareOffer(f.host, fact.participation.id, "unsettled")).verdict,
    ).toBe("accepted");
    f.controls.lease?.release();
    const admission = f.host.acquireExecutor({ kind: "listener", fact }, () => {
      acquired = true;
      unexpectedLease = acquirePresence(f.paths.dir, "feedback", { timeoutMs: 0 });
      return unexpectedLease;
    });
    expect(admission).toEqual({ verdict: "refused", issue: "connection-not-admitted" });
    expect(acquired).toBe(false);
    // The control command still supports historical readback; it grants no lease.
    f.acquire();
    const before = f.host.state().seq;
    expect(f.host.writeConnection(fact).verdict).toBe("accepted");
    expect(f.host.state().seq).toBe(before);
  } finally {
    unexpectedLease?.release();
    f.close();
  }
});

test.each([false, undefined])(
  "native presence changing to %s during acquisition releases the lock",
  (present) => {
    const f = boundFixture();
    let kernelLease: PresenceHandle | undefined;
    try {
      const fact = f.enableFact();
      const before = f.host.state().seq;
      const admission = f.host.acquireExecutor({ kind: "listener", fact }, () => {
        kernelLease = acquirePresence(f.paths.dir, "feedback", { timeoutMs: 0 });
        f.controls.probe = () => present;
        return kernelLease;
      });
      expect(admission).toEqual({ verdict: "refused", issue: "connection-unverified" });
      expect(kernelLease?.held()).toBe(false);
      expect(presenceHeld(f.paths.dir)).toBe(false);
      expect(viewConversation(f.paths.dir).state.seq).toBe(before);
    } finally {
      kernelLease?.release();
      f.close();
    }
  },
);

test("native file copies survive receipt and are removed only after their response is recorded", () => {
  const { f, bytes, path, offerId, close } = preparedNativeFileFixture();
  try {
    const response = {
      kind: "respond" as const,
      offerId,
      outcome: { kind: "answer" as const, text: "Read the complete attachment." },
    };
    expect(f.host.controlConnection(response).verdict).toBe("refused");
    expect(existsSync(path)).toBe(true);
    expect(f.host.controlConnection({ kind: "receipt", offerId }).verdict).toBe("accepted");
    expect(readFileSync(path)).toEqual(bytes);
    expect(f.host.controlConnection(response).verdict).toBe("accepted");
    expect(existsSync(path)).toBe(false);
    expect(f.host.controlConnection(response).verdict).toBe("accepted");
    expect(viewConversation(f.paths.dir).state.connection?.offers[offerId]?.kind).toBe("finished");
  } finally {
    close();
  }
});

test("a new host cleans native copies after a response was saved but post-append publication failed", () => {
  const { f, path, offerId, close } = preparedNativeFileFixture();
  try {
    const response = {
      kind: "respond" as const,
      offerId,
      outcome: { kind: "answer" as const, text: "Saved response" },
    };
    expect(f.host.controlConnection({ kind: "receipt", offerId }).verdict).toBe("accepted");
    let failPublication = false;
    const writer = createConversationHost(f.paths.dir, {
      connectionAuthority: () => f.controls.registration,
      executorLease: () => false,
      now: () => f.controls.now,
      onEffect: () => {},
      onRecord: () => {
        if (failPublication) throw new Error("Stopped after durable append");
      },
      ownerPresence: () => true,
      presence: () => undefined,
    });
    try {
      failPublication = true;
      expect(() => writer.controlConnection(response)).toThrow("Stopped after durable append");
      expect(viewConversation(f.paths.dir).state.connection?.offers[offerId]?.kind).toBe(
        "finished",
      );
      expect(existsSync(path)).toBe(true);
    } finally {
      writer.close();
    }
    const recovery = openWriter(f.paths.dir);
    recovery.close();
    expect(existsSync(path)).toBe(false);
  } finally {
    close();
  }
});

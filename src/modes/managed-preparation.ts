import { verifiedExecutable } from "../harness/inspection-facts.js";
import type { HarnessRunner } from "../harness/runner.js";
import { composeAnnotationPrompt } from "../protocol/annotations.js";
import { composeArtifactPrompt } from "../protocol/artifacts.js";
import { confirmedContextThrough } from "../protocol/context-coverage.js";
import type { ExecutionDriver, ExecutionHold, NativeIntent } from "../protocol/execution.js";
import type { ProtocolIssue } from "../protocol/frames.js";
import { HubError } from "../protocol/hub-errors.js";
import type { ChannelState } from "../protocol/reducer.js";
import type { OfferedContext } from "../store/context-offer.js";
import { offerProjectedContext, renderAttachmentReferences } from "../store/context-offer.js";
import {
  ContextPreparationError,
  renderConversationContext,
} from "../store/conversation-context.js";
import type { ConversationHost } from "../store/conversation-host.js";
import { preferenceState } from "../store/driver-preference.js";
import { readRecordMetadata } from "../store/record-identity.js";
import { locationProjection } from "../store/settings.js";
import type { PreparedContext } from "./context-preparation.js";
import { createContextPreparer } from "./context-preparation.js";
import type { HeadlessDeps } from "./host.js";

type PrepareInput = Parameters<NonNullable<HeadlessDeps["prepareTurn"]>>[0];
type ManagedPrepared =
  | { readonly kind: "held"; readonly issue?: ProtocolIssue }
  | (PreparedContext & { readonly kind: "ready"; readonly native: NativeIntent });
interface ManagedPreparationDeps {
  readonly cwd: string;
  readonly driver: ExecutionDriver;
  readonly host: ConversationHost;
  readonly runner: HarnessRunner;
  readonly offerContext?: typeof offerProjectedContext;
}
export interface ManagedPreparation {
  close(): void;
  offeredPath(turnId: string): string | undefined;
  readonly prepare: (input: PrepareInput) => Promise<ManagedPrepared>;
  release(turnId: string): void;
}

/** The working driver owns this scope until its native process has settled.
 * Preparation creates no task process and derives no execution authority. */
export function createManagedPreparation(deps: ManagedPreparationDeps): ManagedPreparation {
  const { cwd, driver, host, runner } = deps;
  const prepareContext = createContextPreparer(runner);
  const offers = new Map<string, Pick<OfferedContext, "path" | "close">>();
  const preparing = new Map<string, AbortController>();
  let closed = false;
  const scope = new AbortController();
  const release = (turnId: string): void => {
    preparing.get(turnId)?.abort();
    try {
      offers.get(turnId)?.close();
      offers.delete(turnId);
    } catch {
      process.emitWarning("An offered context copy could not be removed; cleanup will retry", {
        code: "LUCID_CONTEXT_CLEANUP",
      });
    }
  };
  const prepare: ManagedPreparation["prepare"] = async (request) => {
    if (preparing.has(request.turnId) || offers.has(request.turnId))
      return { kind: "held", issue: "execution-ineligible" };
    const reservation = new AbortController();
    const input = {
      ...request,
      signal: AbortSignal.any([request.signal, scope.signal, reservation.signal]),
    };
    if (closed || input.signal.aborted) return { kind: "held" };
    preparing.set(input.turnId, reservation);
    let prerequisite = "context-unavailable";
    let offered: ReturnType<typeof offerProjectedContext> | undefined;
    const hold = (
      code: ExecutionHold["code"],
      reason: string,
      actions?: readonly string[],
    ): ManagedPrepared => {
      const result = host.writeExecution({
        kind: "held",
        inputId: input.inputId,
        attempt: host.state().executions[input.inputId]?.attempt ?? 0,
        hold: {
          code,
          reason: reason.slice(0, 4096),
          prerequisite,
          actions:
            actions ??
            (code === "E-HUB-04"
              ? ["choose-folder"]
              : code === "E-HUB-03"
                ? ["change-settings"]
                : ["retry"]),
        },
      });
      return result.verdict === "accepted"
        ? { kind: "held" }
        : { kind: "held", issue: result.issue };
    };
    try {
      const nativeFor = (state: ChannelState): NativeIntent => {
        const execution = state.executions[input.inputId];
        const authorization =
          execution?.kind === "held" ? execution.authorization : execution?.kind;
        return authorization === "fresh-authorized" ? { kind: "fresh" } : input.native;
      };
      const captured = host.captureDispatch(input.inputId, (state) => {
        const native = nativeFor(state);
        return native.kind === "resume"
          ? confirmedContextThrough(state, driver.harness, native.sessionId)
          : 0;
      });
      const state = captured.state;
      const execution = state.executions[input.inputId];
      if (!execution || execution.kind === "attempt-started" || execution.kind === "attempt-ended")
        return { kind: "held" };
      if (execution.kind === "held" && execution.hold.code === "E-COMP-07") return { kind: "held" };
      const authorization = execution.kind === "held" ? execution.authorization : execution.kind;
      const native = nativeFor(state);
      prerequisite = captured.stamp;
      const location = locationProjection(readRecordMetadata(host.dir));
      if (location.status !== "available" || location.workingDirectory !== cwd)
        throw new HubError("Choose an available working folder before continuing.", "E-HUB-04");
      const saved = preferenceState(host.dir).preference;
      if (
        !saved ||
        saved.harness !== driver.harness ||
        saved.model !== driver.model ||
        saved.effort !== driver.effort ||
        saved.provider !== driver.provider ||
        saved.profile !== driver.profile ||
        input.profile !== driver.profile
      )
        throw new HubError(
          "The saved driver differs from this worker. Reconcile the selected settings.",
          "E-HUB-03",
        );
      const identity = host.state().nativeSessions[driver.harness];
      const latest = host.state().harnessSessions[driver.harness];
      if (
        native.kind === "resume"
          ? !identity?.current ||
            identity.sessionId !== native.sessionId ||
            latest !== native.sessionId
          : latest !== undefined && authorization !== "fresh-authorized"
      )
        throw new HubError(
          "The requested native session is unverified or changed. Keep this input pending.",
          "E-HUB-03",
          409,
          ["continue-fresh", "change-settings"],
        );
      const resume = native.kind === "resume" ? native.sessionId : undefined;
      const facts = await runner
        .inspect(driver.harness, {
          signal: input.signal,
          model: driver.model,
          effort: driver.effort,
          provider: driver.provider,
          runtime: { cwd, profile: driver.profile, resume },
        })
        .catch(() => {
          throw new HubError(
            "The selected harness could not be inspected. Review its settings and installed executable.",
            "E-HUB-03",
          );
        });
      if (!verifiedExecutable(facts.runtime?.executable, facts.verifiedAgainst))
        throw new HubError("The selected executable is unverified.", "E-HUB-03");
      if (resume !== undefined && facts.runtime?.resume.status !== "supported")
        throw new HubError(
          "Native resume compatibility is unverified for this selection.",
          "E-HUB-03",
          409,
          ["continue-fresh", "change-settings"],
        );
      if (closed || input.signal.aborted) return { kind: "held" };
      offered = (deps.offerContext ?? offerProjectedContext)(host.dir, captured.context);
      const reference = [
        `Read the complete quoted source with lucid2 context ${JSON.stringify(offered.path)} --offset 0 --bytes 65536 --json. Follow nextOffset to read later slices.`,
        renderAttachmentReferences(offered.attachments),
      ].join("\n\n");
      const result = await prepareContext({
        context: captured.context,
        render: (context) =>
          composeArtifactPrompt(
            renderConversationContext(
              {
                ...context,
                pending: {
                  ...context.pending,
                  text: composeAnnotationPrompt(context.pending.text),
                },
              },
              reference,
            ),
            driver.profile,
          ),
        route: { ...driver, cwd, resume, signal: input.signal },
      });
      if (closed || input.signal.aborted) return { kind: "held" };
      const currentLocation = locationProjection(readRecordMetadata(host.dir));
      if (currentLocation.status !== "available" || currentLocation.workingDirectory !== cwd)
        throw new HubError("Choose an available working folder before continuing.", "E-HUB-04");
      const started = host.writePreparedExecution(
        {
          kind: "attempt-started",
          inputId: input.inputId,
          attempt: execution.attempt + 1,
          epoch: captured.epoch,
          turnId: input.turnId,
          driver,
          native,
          context: {
            digest: captured.context.digest,
            from: captured.context.from,
            through: captured.context.through,
          },
        },
        captured.stamp,
      );
      if (started.verdict !== "accepted") {
        if (started.issue === "execution-stale")
          return hold(
            "E-HUB-06",
            "The prepared context or its prerequisites changed. Recheck them before dispatch.",
          );
        return { kind: "held", issue: started.issue };
      }
      if (closed || input.signal.aborted) {
        const ended = host.writeExecution({
          kind: "attempt-ended",
          inputId: input.inputId,
          attempt: execution.attempt + 1,
          turnId: input.turnId,
          outcome: {
            kind: "pre-start-failed",
            failure: {
              code: "E-HUB-07",
              evidence: "dispatch-not-called",
              reason: "Preparation was cancelled before task dispatch.",
            },
          },
        });
        return ended.verdict === "accepted"
          ? { kind: "held" }
          : { kind: "held", issue: ended.issue };
      }
      offers.set(input.turnId, { path: offered.path, close: offered.close });
      offered = undefined;
      return { ...result, kind: "ready", native };
    } catch (cause) {
      if (input.signal.aborted || closed) return { kind: "held" };
      if (cause instanceof HubError && (cause.code === "E-HUB-03" || cause.code === "E-HUB-04")) {
        return hold(
          cause.code,
          cause.message,
          cause.actions.includes("continue-fresh") ? cause.actions : undefined,
        );
      }
      if (cause instanceof ContextPreparationError) {
        return hold("E-HUB-06", cause.message);
      }
      throw cause;
    } finally {
      if (offered) {
        offers.set(input.turnId, { path: offered.path, close: offered.close });
        release(input.turnId);
      }
      preparing.delete(input.turnId);
    }
  };
  return {
    prepare,
    release,
    offeredPath: (turnId) => offers.get(turnId)?.path,
    close: () => {
      closed = true;
      scope.abort();
      for (const turnId of offers.keys()) release(turnId);
    },
  };
}

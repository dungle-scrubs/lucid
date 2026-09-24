import { HubError } from "../protocol/hub-errors.js";
import { atomicSidecar } from "../store/atomic-file.js";
import { openWriter } from "../store/conversation-host.js";
import { createWithReceipt } from "../store/creation.js";
import { pathsForDir } from "../store/errors.js";
import { LockError } from "../store/flock.js";
import { acquirePresence } from "../store/presence.js";
import { WorkingFolderError } from "../store/project-directory.js";
import { readRecordMetadata, withRecordLock } from "../store/record-identity.js";
import type { HandoffRequest } from "./handoff-request.js";
import type { Conversations } from "./record-addressing.js";
import { commandRecordDir, conversations } from "./record-addressing.js";

export interface HandoffResult {
  readonly artifactUrl: string;
  readonly continuation: {
    readonly idempotent: boolean;
    readonly inputId: string;
    readonly seq: number;
  };
  readonly conversationId: string;
  readonly publication: { readonly status: "published"; readonly version: number };
}

/** Create the record shell, append the artifact and continuation, return the URL.
 * Presence is held across the appends, then released. No native-publication
 * requirement is recorded: the continuation is an ordinary candidate. */
export async function runHandoff(
  request: HandoffRequest,
  rootDir?: string,
): Promise<HandoffResult> {
  const records: Conversations = conversations(rootDir);
  let id: string;
  // A receipt hit means retry: the full equality rule below applies.
  // A fresh creation accepts anything the parser allows.
  let isRetry = request.conversationId !== undefined;
  if (request.conversationId !== undefined) {
    id = request.conversationId;
  } else {
    // Defaults resolve once, in the parser. This function takes shaped settings as-is.
    const settings = request.settings;
    try {
      // A missing root means no receipt exists yet. createWithReceipt
      // creates the root; this probe must not fail first.
      try {
        isRetry = (await records.discoveryIndex.receipts(String(request.creationId))).length > 0;
      } catch {
        isRetry = false;
      }
      const created = await createWithReceipt(
        records.rootDir,
        String(request.creationId),
        { settings, workingDirectory: request.workingDirectory },
        async () => settings,
        records.discoveryIndex,
      );
      id = created.conversationId;
    } catch (cause) {
      if (cause instanceof WorkingFolderError)
        throw new HubError(cause.message, "E-HUB-04", 400, ["Choose a working folder"]);
      throw cause;
    }
  }
  const dir = commandRecordDir(records, id);
  // Fresh handoff creations carry the marker the worker reads to engage
  // the review hold. Retries and existing-record handoffs keep whatever
  // marker (or none) the record already holds.
  if (!isRetry)
    withRecordLock(pathsForDir(dir), id, () => {
      const meta = readRecordMetadata(dir);
      if (meta.handoff !== true)
        atomicSidecar(pathsForDir(dir).metaPath, { ...meta, handoff: true });
    });
  // Presence is the race guard across the appends below. Both acquisitions
  // sit inside the try so every throw path releases exactly what it holds:
  // a failed acquire holds nothing, a failed open releases presence.
  let presence: { release(): void } | undefined;
  const host = (() => {
    try {
      presence = acquirePresence(dir, id, { timeoutMs: 0 });
    } catch (cause) {
      if (cause instanceof LockError && cause.code === "lock-timeout")
        throw new HubError(
          "The conversation is busy. Retry the handoff after the current holder detaches.",
          "E-HUB-03",
          409,
        );
      throw cause;
    }
    try {
      return openWriter(dir, {});
    } catch (cause) {
      presence.release();
      presence = undefined;
      throw cause;
    }
  })();
  let closed = false;
  try {
    // Retry equality (RFC Design 1): a retry must be byte-identical in
    // artifact bytes, continuation id and text. Any difference is E-HUB-02.
    // Fresh creations skip this: nothing exists to differ from.
    if (isRetry) {
      const priorArtifact = host.readArtifact(
        request.artifact.artifactId,
        request.artifact.version,
      );
      if (priorArtifact && priorArtifact.bytes !== request.artifact.bytes)
        throw new HubError(
          "This handoff was retried with different artifact bytes. Reconcile the request and retry with a fresh creation ID.",
          "E-HUB-02",
          409,
        );
      const priorInput = host
        .snapshot()
        .transcript.inputs.find((input) => input.id === request.continuation.inputId);
      if (!priorInput) {
        const others = host.snapshot().transcript.inputs;
        if (others.length > 0)
          throw new HubError(
            "This handoff was retried with a different continuation. Reconcile the request and retry with a fresh creation ID.",
            "E-HUB-02",
            409,
          );
      } else if (priorInput.text !== request.continuation.text)
        throw new HubError(
          "This continuation ID was used with different text. Use a new input ID.",
          "E-HUB-02",
          409,
        );
      else {
        // Byte-identical retry, or an existing record already holding this
        // exact input: nothing to append. Report the existing receipt as
        // already present rather than queued.
        host.close();
        closed = true;
        presence.release();
        return {
          artifactUrl: artifactUrl(request.serverUrl, id, request.artifact.artifactId),
          continuation: { idempotent: true, inputId: priorInput.id, seq: priorInput.seq },
          conversationId: id,
          publication: { status: "published", version: request.artifact.version },
        };
      }
    }
    const written = await host.writeArtifact({
      artifactId: request.artifact.artifactId,
      author: "agent",
      bytes: request.artifact.bytes,
      contentType: "text/html",
      version: request.artifact.version,
    });
    if (written.verdict === "refused") {
      const previous = host.readArtifact(request.artifact.artifactId, request.artifact.version);
      if (
        written.issue !== "artifact-version-exists" ||
        previous?.bytes !== request.artifact.bytes ||
        previous?.author !== "agent" ||
        previous?.contentType !== "text/html"
      )
        throw new HubError(
          "This handoff conflicts with an existing artifact version. Reconcile the request and retry with a fresh creation ID.",
          "E-HUB-02",
          409,
        );
    }
    const accepted = host.acceptInput(
      { id: request.continuation.inputId, text: request.continuation.text, mode: "queue" },
      { completeSettings: request.settings, managed: true },
    );
    if (accepted.verdict === "refused") {
      if (accepted.issue === "E-COMP-06") {
        const receipt = host
          .snapshot()
          .transcript.inputs.find((input) => input.id === request.continuation.inputId);
        if (!receipt || receipt.text !== request.continuation.text)
          throw new HubError(
            "This continuation ID was used with different text. Use a new input ID.",
            "E-HUB-02",
            409,
          );
        host.close();
        closed = true;
        presence.release();
        return {
          artifactUrl: artifactUrl(request.serverUrl, id, request.artifact.artifactId),
          continuation: { idempotent: true, inputId: receipt.id, seq: receipt.seq },
          conversationId: id,
          publication: { status: "published", version: request.artifact.version },
        };
      }
      throw new HubError(`Continuation input refused: ${accepted.issue}.`, "E-HUB-03", 409);
    }
    host.close();
    closed = true;
    presence.release();
    return {
      artifactUrl: artifactUrl(request.serverUrl, id, request.artifact.artifactId),
      continuation: {
        idempotent: false,
        inputId: accepted.receipt.inputId,
        seq: accepted.receipt.seq,
      },
      conversationId: id,
      publication: { status: "published", version: request.artifact.version },
    };
  } finally {
    if (!closed) {
      host.close();
      presence.release();
    }
  }
}

const artifactUrl = (serverUrl: string, conversationId: string, artifactId: string): string =>
  `${new URL(serverUrl).origin}/c/${encodeURIComponent(conversationId)}/${encodeURIComponent(artifactId)}`;

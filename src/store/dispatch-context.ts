import type { ContextBoundary } from "../protocol/execution.js";
import type { ChannelState } from "../protocol/reducer.js";
import { hashBlob } from "./blobs.js";
import { type ConversationContext, projectConversationContext } from "./conversation-context.js";
import { preferenceState } from "./driver-preference.js";
import type { LockedRecordSnapshot } from "./log.js";
import { readRecordMetadata } from "./record-identity.js";

export interface DispatchSnapshot {
  readonly artifacts: LockedRecordSnapshot["artifacts"];
  readonly context: ConversationContext;
  readonly epoch: number;
  readonly stamp: string;
  readonly state: ChannelState;
}

/** Called only under the record's append lock. Sidecar writers use that
 * same lock. Artifact heads catch document writes that do not move seq. */
export function captureDispatchContext(
  dir: string,
  inputId: string,
  from: number | ((state: ChannelState) => number),
  snapshot: LockedRecordSnapshot,
): DispatchSnapshot {
  const context = projectConversationContext({
    artifacts: snapshot.artifacts,
    from: typeof from === "number" ? from : from(snapshot.state),
    pendingInputId: inputId,
    through: snapshot.state.seq + 1,
    transcript: snapshot.transcript,
  });
  return {
    artifacts: snapshot.artifacts,
    context,
    state: snapshot.state,
    epoch: snapshot.state.epoch,
    stamp: dispatchStamp(
      dir,
      inputId,
      context,
      snapshot.state.epoch,
      new Map(snapshot.artifacts.map((artifact) => [artifact.artifactId, artifact.version])),
    ),
  };
}

/** Revalidate immutable log coverage without decoding artifact bytes again. */
export function dispatchStamp(
  dir: string,
  inputId: string,
  context: ContextBoundary,
  epoch: number,
  artifacts: ReadonlyMap<string, number>,
): string {
  const metadata = readRecordMetadata(dir);
  return hashBlob(
    Buffer.from(
      JSON.stringify({
        context: { digest: context.digest, from: context.from, through: context.through },
        epoch,
        artifacts: [...artifacts].sort(([a], [b]) => a.localeCompare(b)),
        inputId,
        location: {
          workingDirectory: metadata.workingDirectory ?? null,
          projectDirectory: metadata.projectDirectory ?? null,
          revision: metadata.locationRevision ?? 0,
        },
        preference: preferenceState(dir),
      }),
    ),
  );
}

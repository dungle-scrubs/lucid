import { isAbsolute } from "node:path";
import { readUserConfig } from "../config/user-config.js";
import { declaredTheme, refuseUnmanaged } from "../protocol/artifact-theme.js";
import type { NativeBinding } from "../protocol/connection.js";
import { PUBLICATION_MESSAGE_MAX } from "../protocol/connection.js";
import { settingsShape } from "../protocol/driver-settings.js";
import { ARTIFACT_BYTES_MAX, isWireId } from "../protocol/frames.js";
import { HubError } from "../protocol/hub-errors.js";
import type { ConnectionStatus } from "../store/connection-view.js";
import { connectionFailure, observeConnection } from "../store/connection-view.js";
import { openWriter } from "../store/conversation-host.js";
import { createWithReceipt } from "../store/creation.js";
import { validArtifactId } from "../store/log.js";
import type { RegistrationAuthority } from "../store/native-registration.js";
import { withNativeRegistration } from "../store/native-registration.js";
import { presenceHeld } from "../store/presence.js";
import { WorkingFolderError } from "../store/project-directory.js";
import { nativeCommandAuthority } from "./native-context.js";
import type { Conversations } from "./record-addressing.js";
import { commandRecordDir, conversations, validConversationId } from "./record-addressing.js";

export interface PublicationConnection extends ConnectionStatus {
  readonly attempt?: { readonly message: string; readonly reason: string };
  readonly persistence: "saved" | "unverified";
  readonly nativeSessionId?: string;
  /** Claude Code commits the connection from the parent callback that reports this marker. */
  readonly proposal?: string;
}

export interface PublicationResult {
  readonly artifactUrl: string;
  readonly connection: PublicationConnection;
  readonly conversationId: string;
  readonly publication: { readonly status: "published"; readonly version: number };
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export async function readPublicationRequest(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    throw new HubError(
      "The publication request file is missing or unreadable.",
      "E-HUB-03",
      400,
      [],
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HubError(
      "The publication request file must contain valid JSON.",
      "E-HUB-03",
      400,
      [],
    );
  }
}

export type PublicationConnector = (
  records: Conversations,
  conversationId: string,
) => PublicationConnection;

/** The flag supplies the marker only when the field is absent. An invalid
 * field value stays invalid; the flag MUST NOT conceal it. */
export function withUnmanagedMarker(value: unknown, allow: boolean): unknown {
  if (!allow || !object(value) || value.theme !== undefined) return value;
  return { ...value, theme: "unmanaged" };
}

/** Publication and connection have separate results. A connection failure cannot undo a document. */
export async function publishArtifact(
  value: unknown,
  rootDir?: string,
  authority: RegistrationAuthority = nativeCommandAuthority(),
  connector?: PublicationConnector,
): Promise<PublicationResult> {
  if (!object(value) || !object(value.artifact))
    throw new HubError("Expected a publication request with an artifact.", "E-HUB-03");
  const { artifact, creationId, conversationId, workingDirectory, serverUrl } = value;
  // The unmanaged marker is an exact string or nothing. An invalid value
  // is malformed input, and no flag may conceal it.
  if (value.theme !== undefined && value.theme !== "unmanaged")
    throw new HubError('The theme field accepts only "unmanaged".', "E-HUB-03", 400, [
      "Remove the theme field",
    ]);
  if (
    (typeof creationId !== "string" || !isWireId(creationId)) &&
    (typeof conversationId !== "string" || !validConversationId(conversationId))
  )
    throw new HubError("Provide a creationId or an existing conversationId.", "E-HUB-03");
  if (creationId !== undefined && conversationId !== undefined)
    throw new HubError("Use either creationId or conversationId, not both.", "E-HUB-03");
  if (
    typeof artifact.artifactId !== "string" ||
    !validArtifactId(artifact.artifactId) ||
    typeof artifact.bytes !== "string" ||
    artifact.contentType !== "text/html" ||
    typeof artifact.version !== "number" ||
    !Number.isSafeInteger(artifact.version) ||
    artifact.version < 1
  )
    throw new HubError(
      "Provide a bounded HTML artifact, valid artifactId, and positive version.",
      "E-HUB-03",
    );
  if (typeof serverUrl !== "string" || !URL.canParse(serverUrl))
    throw new HubError("Provide the local Lucid serverUrl.", "E-HUB-03");
  // The size bound runs before any parsing or durable writes, so an
  // oversized input never reaches the theme parser or the record.
  if (artifact.bytes.length > ARTIFACT_BYTES_MAX)
    throw new HubError(
      `Artifact exceeds the ${ARTIFACT_BYTES_MAX} unit limit. Shrink it and retry.`,
      "E-HUB-03",
      400,
      ["Shrink the artifact"],
    );
  const url = new URL(serverUrl);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new HubError(
      "serverUrl must be a Lucid server origin at http://127.0.0.1:<port>.",
      "E-HUB-03",
    );
  const records = conversations(rootDir);
  const connect: PublicationConnector =
    connector ??
    ((target, conversationId) =>
      connectPublication(target, conversationId, value.registration, authority));
  // The theme guard runs before any durable write: no record shell, no
  // receipt, no version on refusal. A creationId that resolves to an
  // existing record is a retry; the artifact-exists exemption below
  // decides it after opening, so fresh creations refuse here.
  const markedUnmanaged = value.theme === "unmanaged";
  if (typeof conversationId !== "string") {
    try {
      const prior = await records.discoveryIndex.receipts(String(creationId));
      if (prior.length === 0 && declaredTheme(artifact.bytes) === "unmanaged" && !markedUnmanaged)
        refuseUnmanaged();
    } catch (cause) {
      if (cause instanceof HubError) throw cause;
      // An unreadable receipt index refuses later at creation; the guard
      // stays out of its way.
    }
  }
  let id: string;
  if (typeof conversationId === "string") {
    id = conversationId;
  } else {
    if (
      workingDirectory !== null &&
      (typeof workingDirectory !== "string" ||
        !isAbsolute(workingDirectory) ||
        /\p{Cc}/u.test(workingDirectory))
    )
      throw new HubError("Provide an absolute workingDirectory or null.", "E-HUB-03");
    const settings =
      value.settings === undefined ? readUserConfig().defaults : settingsShape(value.settings);
    try {
      const created = await createWithReceipt(
        records.rootDir,
        String(creationId),
        { settings, workingDirectory },
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
  const host = openWriter(commandRecordDir(records, id), {
    connectionAuthority: () => undefined,
    ownerPresence: authority.ownerPresence,
  });
  // The guard runs before the native-publication bookkeeping, so a refusal
  // stores nothing. An already-held artifact is exempt: its policy was
  // chosen at creation, independent of addressing field and version number.
  // Byte conflicts refuse before theme checks: reconcile bytes first.
  const held = host.readArtifact(artifact.artifactId, artifact.version);
  if (held) {
    if (
      held.bytes !== artifact.bytes ||
      held.author !== "agent" ||
      held.contentType !== "text/html"
    ) {
      host.close();
      throw new HubError(
        "This publication conflicts with an existing artifact version. Reconcile the request and retry.",
        "E-HUB-03",
        409,
      );
    }
  } else if (declaredTheme(artifact.bytes) === "unmanaged" && !markedUnmanaged) {
    host.close();
    refuseUnmanaged();
  }
  let closed = false;
  try {
    const requirement = host.recordNativePublication();
    if (requirement.verdict === "refused")
      throw new HubError(`Native publication refused: ${requirement.issue}.`, "E-HUB-03", 409);
    const params = {
      artifactId: artifact.artifactId,
      author: "agent" as const,
      bytes: artifact.bytes,
      contentType: "text/html",
      version: artifact.version,
    };
    const result = await host.writeArtifact(params);
    if (result.verdict === "refused") {
      const previous = host.readArtifact(params.artifactId, params.version);
      if (
        result.issue !== "artifact-version-exists" ||
        previous?.bytes !== params.bytes ||
        previous.author !== params.author ||
        previous.contentType !== params.contentType
      )
        throw new HubError(`Artifact publication refused: ${result.issue}.`, "E-HUB-03", 409);
    }
    host.close();
    closed = true;
    const connection = connect(records, id);
    return {
      artifactUrl: `${url.origin}/c/${encodeURIComponent(id)}/${encodeURIComponent(params.artifactId)}`,
      connection,
      conversationId: id,
      publication: { status: "published", version: params.version },
    };
  } finally {
    if (!closed) host.close();
  }
}

/** Bind a published conversation to the verified native registration and save any failure. */
export function connectPublication(
  records: Conversations,
  conversationId: string,
  reference: unknown,
  authority: RegistrationAuthority,
): PublicationConnection {
  let registration: NativeBinding | undefined;
  const host = openWriter(commandRecordDir(records, conversationId), {
    connectionAuthority: () =>
      registration && authority.callerOwns(registration) === true ? registration : undefined,
    ownerPresence: authority.ownerPresence,
  });
  try {
    const connection = withNativeRegistration(
      records.rootDir,
      reference,
      (binding) => {
        registration = binding;
        try {
          return host.writeConnection({ actionId: binding.generation, binding, kind: "bound" });
        } finally {
          registration = undefined;
        }
      },
      authority,
    );
    const state = connection.ok ? connection.value.state : host.state();
    const binding = state.connection?.binding;
    const status = !connection.ok
      ? connectionFailure(connection.reason, connection.message)
      : connection.value.verdict === "refused"
        ? connectionFailure(
            connection.value.issue,
            `Artifact published; connection refused: ${connection.value.issue}.`,
          )
        : observeConnection(state, {
            executorPresent: presenceHeld(host.dir),
            now: Date.now(),
            ownerPresence: authority.ownerPresence,
          });
    const publicationConnection: PublicationConnection = {
      ...status,
      persistence: "saved",
      ...(binding ? { nativeSessionId: binding.nativeSessionId } : {}),
    };
    return !connection.ok || connection.value.verdict === "refused"
      ? saveConnectionFailure(host, publicationConnection)
      : publicationConnection;
  } finally {
    host.close();
  }
}

/** A connection failure is saved beside the published document; saving it cannot undo publication. */
function saveConnectionFailure(
  host: ReturnType<typeof openWriter>,
  status: PublicationConnection,
): PublicationConnection {
  const attempt = {
    message: status.message.slice(0, PUBLICATION_MESSAGE_MAX),
    reason: status.reason ?? "connection-setup-required",
  };
  try {
    if (host.recordNativePublication(attempt).verdict === "accepted") return status;
  } catch {
    /* Artifact success is independent of diagnostic persistence. */
  }
  return {
    attempt,
    message:
      "The artifact was saved, but the connection result could not be recorded. Saved feedback remains held.",
    persistence: "unverified",
    reason: "connection-result-unrecorded",
    state: "setup-required",
  };
}

/** Save a connection refusal found before binding was attempted. */
export function refusePublicationConnection(
  records: Conversations,
  conversationId: string,
  reason: string,
  message: string,
): PublicationConnection {
  const host = openWriter(commandRecordDir(records, conversationId), {
    connectionAuthority: () => undefined,
  });
  try {
    return saveConnectionFailure(host, {
      ...connectionFailure(reason, message),
      persistence: "saved",
    });
  } finally {
    host.close();
  }
}

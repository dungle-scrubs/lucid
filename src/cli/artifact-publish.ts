import { isAbsolute } from "node:path";
import { readUserConfig } from "../config/user-config.js";
import type { NativeBinding } from "../protocol/connection.js";
import { settingsShape } from "../protocol/driver-settings.js";
import { isWireId } from "../protocol/frames.js";
import { HubError } from "../protocol/hub-errors.js";
import type { ConnectionStatus } from "../store/connection-view.js";
import { connectionFailure, observeConnection } from "../store/connection-view.js";
import { openWriter } from "../store/conversation-host.js";
import { createWithReceipt } from "../store/creation.js";
import { validArtifactId } from "../store/log.js";
import type { RegistrationAuthority } from "../store/native-registration.js";
import {
  nativeRegistrationAuthority,
  withNativeRegistration,
} from "../store/native-registration.js";
import { presenceHeld } from "../store/presence.js";
import { WorkingFolderError } from "../store/project-directory.js";
import { commandRecordDir, conversations, validConversationId } from "./record-addressing.js";

interface PublicationConnection extends ConnectionStatus {
  readonly nativeSessionId?: string;
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

/** Publication and connection have separate results. A connection failure cannot undo a document. */
export async function publishArtifact(
  value: unknown,
  rootDir?: string,
  authority: RegistrationAuthority = nativeRegistrationAuthority(),
): Promise<PublicationResult> {
  if (!object(value) || !object(value.artifact))
    throw new HubError("Expected a publication request with an artifact.", "E-HUB-03");
  const { artifact, creationId, conversationId, workingDirectory, serverUrl } = value;
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
  let registration: NativeBinding | undefined;
  const host = openWriter(commandRecordDir(records, id), {
    connectionAuthority: () =>
      registration && authority.callerOwns(registration.owner) === true ? registration : undefined,
    ownerPresence: authority.ownerPresence,
  });
  try {
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
    const connection = withNativeRegistration(
      records.rootDir,
      value.registration,
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
    return {
      artifactUrl: `${url.origin}/c/${encodeURIComponent(id)}/${encodeURIComponent(params.artifactId)}`,
      connection: {
        ...status,
        ...(binding ? { nativeSessionId: binding.nativeSessionId } : {}),
      },
      conversationId: id,
      publication: { status: "published", version: params.version },
    };
  } finally {
    host.close();
  }
}

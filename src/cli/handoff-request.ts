import { isAbsolute } from "node:path";
import type { Settings } from "../config/user-config.js";
import { readUserConfig } from "../config/user-config.js";
import { settingsShape } from "../protocol/driver-settings.js";
import { ARTIFACT_BYTES_MAX, isWireId, TEXT_MAX } from "../protocol/frames.js";
import { HubError } from "../protocol/hub-errors.js";
import { validArtifactId } from "../store/log.js";
import { validConversationId } from "./record-addressing.js";

export interface HandoffArtifact {
  readonly artifactId: string;
  readonly bytes: string;
  readonly contentType: "text/html";
  readonly version: number;
}

export interface HandoffContinuation {
  readonly inputId: string;
  readonly text: string;
}

export interface HandoffRequest {
  readonly artifact: HandoffArtifact;
  readonly continuation: HandoffContinuation;
  readonly conversationId?: string;
  readonly creationId?: string;
  readonly serverUrl: string;
  readonly settings: Settings;
  readonly workingDirectory: string | null;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Read and parse the handoff request file. Throws HubError E-HUB-03 on any problem. */
export async function readHandoffRequest(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    throw new HubError("The handoff request file is missing or unreadable.", "E-HUB-03", 400, []);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HubError("The handoff request file must contain valid JSON.", "E-HUB-03", 400, []);
  }
}

/** Validate the parsed handoff request. Lengths are UTF-16 code units, the unit the host compares. */
const KNOWN_FIELDS = new Set([
  "artifact",
  "continuation",
  "creationId",
  "conversationId",
  "serverUrl",
  "settings",
  "workingDirectory",
]);

export function parseHandoffRequest(value: unknown): HandoffRequest {
  if (!object(value)) throw new HubError("Expected a handoff request object.", "E-HUB-03");
  for (const key of Object.keys(value))
    if (!KNOWN_FIELDS.has(key))
      throw new HubError(`Unknown handoff request field: ${key}.`, "E-HUB-03", 400, [
        "Remove the unknown field",
      ]);
  const { artifact, continuation, creationId, conversationId, workingDirectory, serverUrl } = value;
  if (
    (typeof creationId !== "string" || !isWireId(creationId)) &&
    (typeof conversationId !== "string" || !validConversationId(conversationId))
  )
    throw new HubError("Provide a creationId or an existing conversationId.", "E-HUB-03");
  if (creationId !== undefined && conversationId !== undefined)
    throw new HubError("Use either creationId or conversationId, not both.", "E-HUB-03");
  if (!object(artifact))
    throw new HubError("Provide an artifact with id, bytes, and version.", "E-HUB-03");
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
  if (artifact.bytes.length > ARTIFACT_BYTES_MAX)
    throw new HubError(
      `Artifact exceeds the ${ARTIFACT_BYTES_MAX} unit limit. Shrink it and retry.`,
      "E-HUB-03",
      400,
      ["Shrink the artifact"],
    );
  if (!object(continuation))
    throw new HubError("Provide a continuation with inputId and text.", "E-HUB-03");
  if (
    typeof continuation.inputId !== "string" ||
    !isWireId(continuation.inputId) ||
    typeof continuation.text !== "string" ||
    continuation.text.length === 0
  )
    throw new HubError(
      "Provide a continuation with a valid inputId and nonempty text.",
      "E-HUB-03",
    );
  if (continuation.text.length > TEXT_MAX)
    throw new HubError(
      `Continuation exceeds the ${TEXT_MAX} unit limit. Shorten it and retry.`,
      "E-HUB-03",
      400,
      ["Shorten the continuation"],
    );
  if (typeof serverUrl !== "string" || !URL.canParse(serverUrl))
    throw new HubError("Provide the local Lucid serverUrl.", "E-HUB-03");
  const url = new URL(serverUrl);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port === "" ||
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
  if (
    workingDirectory !== null &&
    (typeof workingDirectory !== "string" ||
      !isAbsolute(workingDirectory) ||
      /\p{Cc}/u.test(workingDirectory))
  )
    throw new HubError("Provide an absolute workingDirectory or null.", "E-HUB-03");
  const settings =
    value.settings === undefined ? readUserConfig().defaults : settingsShape(value.settings);
  return {
    artifact: {
      artifactId: artifact.artifactId,
      bytes: artifact.bytes,
      contentType: "text/html",
      version: artifact.version,
    },
    continuation: { inputId: continuation.inputId, text: continuation.text },
    ...(typeof conversationId === "string"
      ? { conversationId }
      : { creationId: creationId as string }),
    serverUrl,
    settings,
    workingDirectory: workingDirectory as string | null,
  };
}

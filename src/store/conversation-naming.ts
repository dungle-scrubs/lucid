import {
  conversationTitle,
  namingInput,
  namingPrompt,
  storedConversationTitle,
  titleState,
} from "../protocol/conversation-title.js";
import { HubError } from "../protocol/hub-errors.js";
import { atomicSidecar } from "./atomic-file.js";
import { pathsForDir } from "./errors.js";
import type { RecordMetadata } from "./record-identity.js";
import { readRecordMetadata, withRecordLock } from "./record-identity.js";

/** Called under the append lock, only after accepted input is durable. */
export function initializeNaming(
  dir: string,
  inputs: readonly { readonly id: string; readonly text: string }[],
): void {
  const meta = readRecordMetadata(dir);
  const previous = namingJob(meta);
  if (
    (meta.titleRevision !== undefined || meta.conversationTitle !== undefined) &&
    !(meta.titleOrigin === "fallback" && previous?.status === "waiting-input")
  )
    return;
  let first: { id: string; text: string; naming: ReturnType<typeof namingInput> } | undefined;
  for (const input of inputs) {
    const naming = namingInput(input.text);
    if (naming.kind === "text") {
      first = { ...input, naming };
      break;
    }
    if (!first && naming.kind === "attachment") first = { ...input, naming };
  }
  if (!first || (previous?.status === "waiting-input" && first.naming.kind !== "text")) return;
  const source = first.naming.kind === "text" ? first.naming.text : "";
  const revision = Number(meta.titleRevision ?? 0) + 1;
  const title = conversationTitle(namingPrompt(first.text));
  if (!storedConversationTitle(title)) return;
  atomicSidecar(pathsForDir(dir).metaPath, {
    ...meta,
    conversationTitle: title,
    titleOrigin: "fallback",
    titleRevision: revision,
    titleGeneration: {
      v: 1,
      inputId: first.id,
      source: [...source.slice(0, 8000)].slice(0, 4000).join(""),
      attempts: 0,
      status: first.naming.kind === "attachment" ? "waiting-input" : "eligible",
      basedOn: revision,
    },
  });
}

interface NamingBase {
  readonly v: 1;
  readonly inputId: string;
  readonly source: string;
  readonly attempts: number;
  readonly basedOn: number;
}
export type NamingJob = NamingBase &
  (
    | { readonly status: "eligible" | "repair" | "waiting-input" }
    | { readonly status: "running"; readonly token: string }
    | { readonly status: "finished" }
    | { readonly status: "failed" | "unavailable"; readonly reason: string }
  );

export function namingJob(meta: RecordMetadata): NamingJob | null {
  const value = meta.titleGeneration;
  if (!value || typeof value !== "object") return null;
  const job = value as Record<string, unknown>;
  if (
    job.v !== 1 ||
    typeof job.inputId !== "string" ||
    typeof job.source !== "string" ||
    (job.source.length > 4000 && (job.source.length > 8000 || [...job.source].length > 4000)) ||
    !Number.isSafeInteger(job.attempts) ||
    Number(job.attempts) < 0 ||
    Number(job.attempts) > 2 ||
    !Number.isSafeInteger(job.basedOn) ||
    Number(job.basedOn) < 1
  )
    return null;
  if (
    ![
      "eligible",
      "repair",
      "waiting-input",
      "running",
      "finished",
      "failed",
      "unavailable",
    ].includes(String(job.status))
  )
    return null;
  if (job.status === "running" && typeof job.token !== "string") return null;
  if ((job.status === "failed" || job.status === "unavailable") && typeof job.reason !== "string")
    return null;
  return value as NamingJob;
}

/** A job belongs to the fallback revision that scheduled it. */
export function pendingNamingJob(meta: RecordMetadata): NamingJob | null {
  const job = namingJob(meta);
  return job &&
    meta.titleOrigin === "fallback" &&
    meta.titleRevision === job.basedOn &&
    ["eligible", "repair", "running", "unavailable"].includes(job.status)
    ? job
    : null;
}

function saveJob(dir: string, meta: RecordMetadata, job: NamingJob): void {
  atomicSidecar(pathsForDir(dir).metaPath, { ...meta, titleGeneration: job });
}

/** Caller holds the naming job lock across launch and completion, never the executor lease. */
export function claimNaming(
  dir: string,
  id: string,
): Extract<NamingJob, { status: "running" }> | null {
  return withRecordLock(pathsForDir(dir), id, () => {
    const meta = readRecordMetadata(dir);
    const job = pendingNamingJob(meta);
    if (!job) return null;
    if (job.status === "running") {
      saveJob(dir, meta, { ...job, status: "failed", reason: "interrupted" });
      return null;
    }
    if (
      (job.status !== "eligible" && job.status !== "repair" && job.status !== "unavailable") ||
      job.attempts >= 2
    )
      return null;
    const claimed = {
      ...job,
      attempts: job.attempts + 1,
      status: "running" as const,
      token: crypto.randomUUID(),
    };
    saveJob(dir, meta, claimed);
    return claimed;
  });
}

export function finishNaming(
  dir: string,
  id: string,
  claim: Extract<NamingJob, { status: "running" }>,
  outcome:
    | { readonly kind: "result"; readonly text: string }
    | { readonly kind: "failed"; readonly reason: string },
): void {
  withRecordLock(pathsForDir(dir), id, () => {
    const meta = readRecordMetadata(dir);
    const current = pendingNamingJob(meta);
    if (
      current?.status !== "running" ||
      current.token !== claim.token ||
      current.basedOn !== claim.basedOn
    )
      return;
    if (outcome.kind === "failed") {
      saveJob(dir, meta, { ...current, status: "failed", reason: outcome.reason });
      return;
    }
    const title = storedConversationTitle(outcome.text);
    if (title === undefined) {
      saveJob(
        dir,
        meta,
        current.attempts < 2
          ? { ...current, status: "repair" }
          : { ...current, status: "failed", reason: "invalid-title" },
      );
      return;
    }
    atomicSidecar(pathsForDir(dir).metaPath, {
      ...meta,
      conversationTitle: title,
      titleOrigin: "generated",
      titleRevision: claim.basedOn + 1,
      titleGeneration: { ...current, status: "finished" },
    });
  });
}

export function renameConversation(
  dir: string,
  id: string,
  expectedRevision: unknown,
  value: unknown,
): { readonly title: string; readonly titleRevision: number; readonly titleOrigin: "manual" } {
  const title = typeof value === "string" ? storedConversationTitle(value) : undefined;
  if (!title)
    throw new HubError(
      "Use one to seven words and at most 128 characters on one line.",
      "E-HUB-08",
      400,
      ["Edit title"],
    );
  if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0)
    throw new HubError("An expected title revision is required.", "E-HUB-08", 400, [
      "Reload title",
    ]);
  return withRecordLock(pathsForDir(dir), id, () => {
    const meta = readRecordMetadata(dir);
    const revision = titleState(meta).titleRevision;
    if (revision !== expectedRevision)
      throw new HubError("The title changed. Reload it before renaming.", "E-HUB-08", 409, [
        "Reload title",
      ]);
    const result = { title, titleRevision: Number(revision) + 1, titleOrigin: "manual" as const };
    atomicSidecar(pathsForDir(dir).metaPath, {
      ...meta,
      conversationTitle: title,
      titleRevision: result.titleRevision,
      titleOrigin: result.titleOrigin,
    });
    return result;
  });
}

export function namingUnavailable(dir: string, id: string, basedOn: number): void {
  withRecordLock(pathsForDir(dir), id, () => {
    const meta = readRecordMetadata(dir);
    const job = pendingNamingJob(meta);
    if (!job || (job.status !== "eligible" && job.status !== "repair") || job.basedOn !== basedOn)
      return;
    saveJob(dir, meta, { ...job, status: "unavailable", reason: "tool-isolation-unavailable" });
  });
}

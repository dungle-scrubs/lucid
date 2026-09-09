import { isWireId, TEXT_MAX } from "../../protocol/frames.js";
import { TOKEN_HEADER } from "../constants.js";
import { tryCatch } from "./try-catch.js";

export interface PendingInput {
  readonly artifactId: string;
  readonly body: string;
  readonly conversationId: string;
  readonly id: string;
  readonly version: 1;
}

export type InputOutcome =
  | { readonly kind: "accepted"; readonly request: PendingInput }
  | { readonly error: string; readonly kind: "refused"; readonly request: PendingInput };

export type InputRecoveryState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "pending";
      readonly message: string;
      readonly phase: "ready" | "sending" | "reload";
      readonly request: PendingInput;
    }
  | { readonly code: "E-COMP-08"; readonly kind: "invalid"; readonly text: string }
  | {
      readonly code: "E-COMP-08";
      readonly kind: "storage-error";
      readonly outcome: InputOutcome | null;
      readonly text: string;
    }
  | { readonly kind: "settled"; readonly outcome: InputOutcome };

export interface InputRecoveryDeps {
  readonly conversationId: string;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly isActive: () => boolean;
  readonly newId: () => string;
  /** A getter also contains browsers which throw on accessing sessionStorage. */
  readonly storage: () => Pick<Storage, "getItem" | "removeItem" | "setItem">;
  readonly token: () => string | null;
}

export interface InputRecovery {
  readonly begin: (artifactId: string, text: string) => Promise<InputRecoveryState>;
  readonly discardInvalid: () => void;
  readonly dismiss: () => void;
  readonly getSnapshot: () => InputRecoveryState;
  readonly refreshStorage: () => void;
  readonly retry: () => Promise<InputRecoveryState>;
  readonly subscribe: (listener: () => void) => () => void;
}

const BODY_MAX = TEXT_MAX * 6 + 1024;
const ENTRY_MAX = BODY_MAX * 2 + 1024;

export const recoveryKey = (conversationId: string): string =>
  `lucid:comparison-input:v1:${encodeURIComponent(conversationId)}`;

const objectOf = (text: string): Record<string, unknown> | null => {
  const [error, value] = tryCatch<unknown>(() => JSON.parse(text));
  return !error && typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
};

export const pendingInputText = (request: PendingInput): string => {
  const text = objectOf(request.body)?.text;
  return typeof text === "string" ? text : "";
};

const decodePending = (raw: string, conversationId: string): PendingInput | null => {
  if (raw.length > ENTRY_MAX) return null;
  const entry = objectOf(raw);
  if (
    entry === null ||
    Object.keys(entry).length !== 5 ||
    entry.version !== 1 ||
    entry.conversationId !== conversationId ||
    typeof entry.artifactId !== "string" ||
    !isWireId(entry.artifactId) ||
    typeof entry.id !== "string" ||
    !isWireId(entry.id) ||
    typeof entry.body !== "string" ||
    entry.body.length > BODY_MAX
  )
    return null;
  const body = objectOf(entry.body);
  if (
    body === null ||
    Object.keys(body).length !== 2 ||
    body.id !== entry.id ||
    typeof body.text !== "string" ||
    body.text.trim() === "" ||
    body.text.length > TEXT_MAX
  )
    return null;
  return {
    artifactId: entry.artifactId,
    body: entry.body,
    conversationId,
    id: entry.id,
    version: 1,
  };
};

const readableText = (raw: string | null): string => {
  if (raw === null || raw.length > ENTRY_MAX) return "";
  const body = objectOf(raw)?.body;
  if (typeof body !== "string" || body.length > BODY_MAX) return "";
  const text = objectOf(body)?.text;
  return typeof text === "string" ? text.slice(0, TEXT_MAX) : "";
};

/** One instance per open conversation. Construction/reload never sends.
 * sessionStorage survives a same-tab reload, not closing the tab:
 * https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage
 */
export const createInputRecovery = (deps: InputRecoveryDeps): InputRecovery => {
  const key = recoveryKey(deps.conversationId);
  const listeners = new Set<() => void>();
  let state: InputRecoveryState = { kind: "idle" };
  let invalidRaw: string | null = null;

  const set = (next: InputRecoveryState): InputRecoveryState => {
    state = next;
    for (const listener of listeners) listener();
    return state;
  };

  const settle = (outcome: InputOutcome): InputRecoveryState => {
    const [error] = tryCatch(() => {
      const storage = deps.storage();
      const raw = storage.getItem(key);
      const current = raw === null ? null : decodePending(raw, deps.conversationId);
      if (
        raw !== null &&
        (current?.id !== outcome.request.id || current.body !== outcome.request.body)
      )
        throw new Error("Recovery entry changed");
      storage.removeItem(key);
      if (storage.getItem(key) !== null) throw new Error("Recovery entry was not cleared");
    });
    return error
      ? set({
          code: "E-COMP-08",
          kind: "storage-error",
          outcome,
          text: pendingInputText(outcome.request),
        })
      : set({ kind: "settled", outcome });
  };

  const refreshStorage = (): void => {
    if (state.kind === "pending" && state.phase === "sending") return;
    if (state.kind === "storage-error" && state.outcome !== null) {
      settle(state.outcome);
      return;
    }
    const [error, raw] = tryCatch(() => deps.storage().getItem(key));
    if (error) {
      set({
        code: "E-COMP-08",
        kind: "storage-error",
        outcome: null,
        text: state.kind === "storage-error" ? state.text : "",
      });
      return;
    }
    if (raw === null) {
      set({ kind: "idle" });
      return;
    }
    const request = decodePending(raw, deps.conversationId);
    if (request === null) {
      invalidRaw = raw;
      set({ code: "E-COMP-08", kind: "invalid", text: readableText(raw) });
    } else {
      set({
        kind: "pending",
        message: "Check whether this note was sent.",
        phase: "ready",
        request,
      });
    }
  };

  const retry = async (): Promise<InputRecoveryState> => {
    if (!deps.isActive() || state.kind !== "pending" || state.phase !== "ready") return state;
    const request = state.request;
    const token = deps.token();
    if (token === null)
      return set({
        kind: "pending",
        message: "Reload to check this note.",
        phase: "reload",
        request,
      });
    set({ kind: "pending", message: "Checking this note…", phase: "sending", request });
    const response = await deps
      .fetch(`/api/conversations/${encodeURIComponent(deps.conversationId)}/input`, {
        body: request.body,
        headers: { "content-type": "application/json", [TOKEN_HEADER]: token },
        method: "POST",
      })
      .catch(() => null);
    if (response?.status === 401)
      return set({
        kind: "pending",
        message: "Reload to check this note.",
        phase: "reload",
        request,
      });
    const body: unknown = response === null ? null : await response.json().catch(() => null);
    if (typeof body === "object" && body !== null) {
      const result = body as Record<string, unknown>;
      if (
        response?.ok &&
        result.verdict === "accepted" &&
        result.inputId === request.id &&
        result.noteIndex === 0
      )
        return settle({ kind: "accepted", request });
      if (
        response !== null &&
        response.status >= 400 &&
        response.status < 500 &&
        result.verdict === "refused" &&
        typeof result.error === "string"
      )
        return settle({ error: result.error.slice(0, 256), kind: "refused", request });
    }
    return set({
      kind: "pending",
      message: "The send result is unknown. Retry to check.",
      phase: "ready",
      request,
    });
  };

  refreshStorage();
  return {
    begin: async (artifactId, text) => {
      if (state.kind === "storage-error" && state.outcome === null && state.text === "")
        return set({ ...state, text });
      if (!deps.isActive() || (state.kind !== "idle" && state.kind !== "settled")) return state;
      // Another controller in this page may already own an unresolved request.
      refreshStorage();
      if (state.kind !== "idle") return state;
      const [error, request] = tryCatch(() => {
        const id = deps.newId();
        const next: PendingInput = {
          artifactId,
          body: JSON.stringify({ id, text }),
          conversationId: deps.conversationId,
          id,
          version: 1,
        };
        const raw = JSON.stringify(next);
        if (decodePending(raw, deps.conversationId) === null)
          throw new Error("Invalid send request");
        const storage = deps.storage();
        storage.setItem(key, raw);
        if (storage.getItem(key) !== raw) throw new Error("Recovery readback differs");
        return next;
      });
      if (error) return set({ code: "E-COMP-08", kind: "storage-error", outcome: null, text });
      set({ kind: "pending", message: "Sending note…", phase: "ready", request });
      return retry();
    },
    discardInvalid: () => {
      if (state.kind !== "invalid") return;
      const [error] = tryCatch(() => {
        const storage = deps.storage();
        if (storage.getItem(key) !== invalidRaw) throw new Error("Recovery entry changed");
        storage.removeItem(key);
        if (storage.getItem(key) !== null) throw new Error("Recovery entry was not cleared");
      });
      if (!error) set({ kind: "idle" });
    },
    dismiss: () => {
      if (state.kind === "settled") set({ kind: "idle" });
    },
    getSnapshot: () => state,
    refreshStorage,
    retry,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

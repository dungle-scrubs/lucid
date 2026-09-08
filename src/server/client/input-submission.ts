import { isWireId, TEXT_MAX } from "../../protocol/frames.js";

interface SavedInput {
  readonly artifactId: string | null;
  readonly body: string;
  readonly conversationId: string;
  readonly inputId: string;
  readonly version: 1;
}

export type InputSubmissionState =
  | { readonly status: "idle" }
  | { readonly status: "unresolved"; readonly request: SavedInput; readonly text: string }
  | { readonly status: "invalid"; readonly reason: string; readonly text: string | null };

export type InputSubmissionResult =
  | { readonly status: "accepted"; readonly inputId: string }
  | {
      readonly status: "refused";
      readonly inputId: string;
      readonly artifactId: string | null;
      readonly text: string;
      readonly reason: string;
    }
  | { readonly status: "uncertain"; readonly reason: string; readonly reload: boolean }
  | { readonly status: "blocked"; readonly reason: string };

interface SubmissionOptions {
  readonly conversationId: string;
  readonly mintId: () => string;
  readonly send: (body: string) => Promise<Response>;
  readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

export interface InputSubmission {
  current(): InputSubmissionState;
  discardInvalid(): boolean;
  retry(): Promise<InputSubmissionResult>;
  submit(text: string, artifactId?: string): Promise<InputSubmissionResult>;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** One tab-local request, persisted before transport. The accepted log remains
 * the receipt authority. Restoring this controller never sends a request. */
export function createInputSubmission(options: SubmissionOptions): InputSubmission {
  const { conversationId, mintId, send, storage } = options;
  const key = `lucid:unresolved-input:v1:${conversationId}`;
  let active = false;
  let state: InputSubmissionState;
  const load = (): InputSubmissionState => {
    let readable: string | null = null;
    try {
      const raw = storage.getItem(key);
      if (raw === null) return { status: "idle" };
      // JSON is serialized twice: a six-character Unicode escape gains a
      // second backslash inside the saved body string.
      if (raw.length > TEXT_MAX * 7 + 4096) throw new Error("Saved request is too large");
      const saved: unknown = JSON.parse(raw);
      const body: unknown =
        object(saved) && typeof saved.body === "string" ? JSON.parse(saved.body) : null;
      if (
        object(saved) &&
        saved.conversationId === conversationId &&
        object(body) &&
        typeof body.text === "string" &&
        body.text.length <= TEXT_MAX
      )
        readable = body.text;
      if (
        !object(saved) ||
        saved.version !== 1 ||
        saved.conversationId !== conversationId ||
        typeof saved.inputId !== "string" ||
        !isWireId(saved.inputId) ||
        typeof saved.body !== "string" ||
        !(
          saved.artifactId === null ||
          (typeof saved.artifactId === "string" && isWireId(saved.artifactId))
        )
      )
        throw new Error("Saved request is invalid");
      if (
        !object(body) ||
        body.id !== saved.inputId ||
        typeof body.text !== "string" ||
        body.text.length > TEXT_MAX ||
        body.text.trim() === "" ||
        Object.keys(body).some((name) => name !== "id" && name !== "text")
      )
        throw new Error("Saved request payload is invalid");
      return {
        status: "unresolved",
        request: {
          artifactId: saved.artifactId,
          body: saved.body,
          conversationId,
          inputId: saved.inputId,
          version: 1,
        },
        text: body.text,
      };
    } catch {
      return {
        status: "invalid",
        text: readable,
        reason:
          "E-COMP-08: Cannot read this tab's saved send. Inspect the transcript before discarding local recovery data.",
      };
    }
  };
  state = load();
  const retry = async (): Promise<InputSubmissionResult> => {
    if (active || state.status !== "unresolved")
      return { status: "blocked", reason: "Resolve the saved send before starting another." };
    const { request, text } = state;
    active = true;
    try {
      const response = await send(request.body);
      if (response.status === 401)
        return { status: "uncertain", reason: "Reload, then retry this saved send.", reload: true };
      const receipt: unknown = await response.json();
      if (
        response.ok &&
        object(receipt) &&
        receipt.verdict === "accepted" &&
        receipt.inputId === request.inputId
      ) {
        storage.removeItem(key);
        if (storage.getItem(key) !== null) throw new Error("Saved send cleanup failed");
        state = { status: "idle" };
        return { status: "accepted", inputId: request.inputId };
      }
      if (
        !response.ok &&
        object(receipt) &&
        receipt.verdict === "refused" &&
        receipt.inputId === request.inputId &&
        typeof receipt.error === "string"
      ) {
        storage.removeItem(key);
        if (storage.getItem(key) !== null) throw new Error("Saved send cleanup failed");
        state = { status: "idle" };
        return {
          status: "refused",
          inputId: request.inputId,
          artifactId: request.artifactId,
          text,
          reason: receipt.error,
        };
      }
      return {
        status: "uncertain",
        reason: "The send result is unknown. Retry the same request to check it.",
        reload: false,
      };
    } catch {
      return {
        status: "uncertain",
        reason: "The send result is unknown. Retry the same request to check it.",
        reload: false,
      };
    } finally {
      active = false;
    }
  };
  return {
    current: () => state,
    discardInvalid: (): boolean => {
      if (active || state.status !== "invalid") return false;
      try {
        storage.removeItem(key);
        if (storage.getItem(key) !== null) return false;
        state = { status: "idle" };
        return true;
      } catch {
        return false;
      }
    },
    retry,
    submit: async (text, artifactId): Promise<InputSubmissionResult> => {
      if (!active && state.status === "idle") state = load();
      if (active || state.status !== "idle")
        return { status: "blocked", reason: "Resolve the saved send before starting another." };
      const inputId = mintId();
      if (
        !isWireId(inputId) ||
        text.trim() === "" ||
        text.length > TEXT_MAX ||
        (artifactId !== undefined && !isWireId(artifactId))
      )
        return { status: "blocked", reason: "The prompt or its identity is invalid." };
      const request: SavedInput = {
        artifactId: artifactId ?? null,
        body: JSON.stringify({ id: inputId, text }),
        conversationId,
        inputId,
        version: 1,
      };
      try {
        const serialized = JSON.stringify(request);
        storage.setItem(key, serialized);
        if (storage.getItem(key) !== serialized) throw new Error("Saved send readback differs");
        state = { status: "unresolved", request, text };
      } catch {
        state = load();
        return {
          status: "blocked",
          reason:
            "E-COMP-08: Cannot save this send for recovery. Nothing was sent. Browser storage may be unavailable or full. Resolve saved sends in other conversations in this tab, or reduce this prompt.",
        };
      }
      return retry();
    },
  };
}

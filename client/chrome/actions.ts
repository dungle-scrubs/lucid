import { api, get, persistSidebarOpen, set, uploadPaste, uuid, warn } from "./store.ts";
import { applyDeferredSwapIfReady, pushHighlights, toOverlay } from "./surface.ts";
import type { AgentQuestion, DiffData, SessionSummary } from "./types.ts";

/** Every mutation the human can make. Kept out of the components so the flow
 *  (and its ordering rules) reads in one place. */

// ---- composer -------------------------------------------------------------

export const addToQueue = (): void => {
  const s = get();
  if (!s.pendingTarget || s.composerNote.trim().length === 0) return;
  set({
    queue: [
      ...s.queue,
      {
        id: uuid(),
        target: s.pendingTarget,
        note: s.composerNote.trim(),
        at: new Date().toISOString(),
        images: s.pastedImages,
      },
    ],
    pendingTarget: null,
    composerNote: "",
    pastedImages: [],
  });
  pushHighlights();
  // Queueing dismounts the note's textarea, which would strand focus on
  // <body>. Hand it to the message composer - the next thing typed is either
  // a message or another pick, and a pick never needed keyboard focus. And a
  // manual submit is an explicit "take me back down", even from a scroll-up.
  requestAnimationFrame(() => {
    document.querySelector<HTMLTextAreaElement>('[data-test="message-input"]')?.focus();
    const vp = document.querySelector('[data-test="thread-viewport"]');
    vp?.scrollTo({ top: vp.scrollHeight, behavior: "smooth" });
  });
};

export const discardPending = (): void => {
  for (const img of get().pastedImages) URL.revokeObjectURL(img.url);
  set({ pendingTarget: null, composerNote: "", pastedImages: [] });
  applyDeferredSwapIfReady();
  pushHighlights();
};

/** Stage a pasted image on the annotation being composed. */
export const addPastedImage = async (file: File): Promise<void> => {
  const img = await uploadPaste(file);
  if (img) set((s) => ({ pastedImages: [...s.pastedImages, img] }));
};

export const removePastedImage = (id: string): void => {
  const img = get().pastedImages.find((i) => i.id === id);
  if (img) URL.revokeObjectURL(img.url);
  set((s) => ({ pastedImages: s.pastedImages.filter((i) => i.id !== id) }));
};

export const removeQueued = (id: string): void => {
  if (get().editingId === id) cancelEdit();
  set((s) => ({ queue: s.queue.filter((q) => q.id !== id) }));
  applyDeferredSwapIfReady();
  pushHighlights();
};

/** Open a queued annotation's note for editing. Only one card edits at a
 *  time, so an already-open edit is folded back in first. */
export const beginEdit = (id: string): void => {
  const item = get().queue.find((q) => q.id === id);
  if (!item) return;
  if (!commitEdit()) return;
  set({ editingId: id, editDraft: item.note });
};

export const cancelEdit = (): void => set({ editingId: null, editDraft: "" });

/** Fold an open edit back into the queue. The note is the whole point of an
 *  annotation, so an empty draft is refused rather than silently dropped;
 *  callers check the result before proceeding. */
export const commitEdit = (): boolean => {
  const s = get();
  if (s.editingId === null) return true;
  const note = s.editDraft.trim();
  if (note.length === 0) return false;
  const id = s.editingId;
  set({
    queue: s.queue.map((q) => (q.id === id ? { ...q, note } : q)),
    editingId: null,
    editDraft: "",
  });
  return true;
};

export const sendQueue = async (): Promise<void> => {
  if (!commitEdit()) {
    warn("Finish editing the queued annotation first - a note can't be empty.");
    return;
  }
  const sent = new Set<string>();
  set({ sending: true }); // freeze the queue: an item edited mid-flight would send its old note
  try {
    for (const q of get().queue) {
      await api("/__lucid/annotation", {
        id: q.id,
        version: get().version,
        target: q.target,
        note: q.note,
        authoredAt: q.at,
        images: q.images.map(({ id, name, file }) => ({ id, name, file })),
      });
      sent.add(q.id); // ids are idempotent, so a retry of a sent one is safe
    }
  } catch {
    warn("Some annotations didn't send - they're kept in the queue, try again.");
  }
  // Reconcile against live state, not a pre-send snapshot: a fresh annotation
  // can still be queued while requests are in flight, so drop exactly what
  // sent and keep the rest.
  for (const q of get().queue) {
    if (sent.has(q.id)) for (const img of q.images) URL.revokeObjectURL(img.url);
  }
  set((s) => ({ sending: false, queue: s.queue.filter((q) => !sent.has(q.id)) }));
  applyDeferredSwapIfReady();
  pushHighlights();
};

// ---- review lifecycle -----------------------------------------------------

export const approveReview = async (): Promise<void> => {
  try {
    await api("/__lucid/resolve", {});
  } catch {
    warn("Approve didn't send - try again.");
  }
};

export const reopenReview = async (): Promise<void> => {
  try {
    await api("/__lucid/reopen", {});
  } catch {
    warn("Reopen didn't send - try again.");
  }
};

// ---- sessions -------------------------------------------------------------

export const loadSessions = async (): Promise<void> => {
  set({ sessionsLoading: true });
  try {
    const res = await api("/__lucid/sessions");
    const data = (await res.json()) as { sessions: SessionSummary[] };
    set({ sessions: data.sessions, sessionsLoading: false });
  } catch {
    set({ sessions: [], sessionsLoading: false });
    warn("Couldn't list this project's sessions.");
  }
};

export const setSidebarTab = (tab: "chat" | "sessions"): void => {
  set({ sidebarTab: tab });
  // Fetch on first look rather than at boot: a review that never opens the tab
  // should never pay for a project-wide directory scan. Refetch on every visit
  // after that, because liveness is exactly the thing that goes stale.
  if (tab === "sessions") void loadSessions();
};

export const setSidebarOpen = (open: boolean): void => {
  set({ sidebarOpen: open });
  persistSidebarOpen(open);
};

/**
 * Switch the viewer to another session. Each session is its own server on its
 * own port, so this is a navigation, not a swap: a full load is correct, since
 * the new session has its own stream, its own folded state and its own origin.
 *
 * The queue lives in this tab's memory, so leaving with unsent work would
 * silently eat it. Refuse instead, and say why.
 */
export const switchToSession = (s: SessionSummary): void => {
  const st = get();
  if (st.queue.length > 0 || (st.pendingTarget !== null && st.composerNote.trim().length > 0)) {
    warn("Send or discard your unsent feedback before switching sessions.");
    return;
  }
  if (!s.viewer) return;
  window.location.href = s.viewer;
};

// ---- agent questions ------------------------------------------------------

export const setAnswerDraft = (id: string, value: string): void =>
  set((s) => ({ answerDrafts: { ...s.answerDrafts, [id]: value } }));

export const sendAnswer = async (q: AgentQuestion): Promise<void> => {
  const text = (get().answerDrafts[q.id] ?? "").trim();
  if (text.length === 0) return;
  try {
    await api("/__lucid/answer", { id: uuid(), questionId: q.id, text });
    const drafts = { ...get().answerDrafts };
    delete drafts[q.id];
    set({ answerDrafts: drafts }); // clear only after the answer is recorded
  } catch {
    warn("Your answer didn't send - it's kept here, try again.");
  }
};

export const focusQuestionRef = (ref?: string): void => {
  if (ref) toOverlay({ source: "lucid-chrome", type: "focus-annotation", id: ref });
};

// ---- change view ----------------------------------------------------------

export const enterDiff = async (base = get().diffBase): Promise<void> => {
  try {
    const res = await api(`/__lucid/diff?base=${base}`);
    const data = (await res.json()) as DiffData;
    set({ diffData: data, diffBase: base, diffMode: true, diffIndex: 0 });
    toOverlay({ source: "lucid-chrome", type: "diff-show", html: data.mergedHtml });
    if (data.hunks.length > 0) requestAnimationFrame(() => gotoHunk(0));
  } catch {
    /* diff unavailable */
  }
};

export const exitDiff = async (): Promise<void> => {
  set({ diffMode: false, revertWhy: "" });
  const html = await api("/__lucid/artifact")
    .then((r) => r.text())
    .catch(() => null);
  if (html !== null) toOverlay({ source: "lucid-chrome", type: "swap", html });
  pushHighlights();
};

export const gotoHunk = (index: number): void => {
  const hunks = get().diffData?.hunks ?? [];
  if (hunks.length === 0) return;
  const i = ((index % hunks.length) + hunks.length) % hunks.length;
  set({ diffIndex: i });
  const hunk = hunks[i];
  if (hunk) toOverlay({ source: "lucid-chrome", type: "diff-goto", hunkId: hunk.id });
};

export const revertCurrentHunk = async (): Promise<void> => {
  const s = get();
  const hunk = s.diffData?.hunks[s.diffIndex];
  const why = s.revertWhy.trim();
  if (!hunk || why.length === 0) return;
  try {
    await api("/__lucid/revert", {
      id: uuid(),
      target: hunk.anchor,
      targetVersion: s.diffBase,
      why,
    });
    set({ revertWhy: "" });
  } catch {
    warn("The revert didn't send - your reason is kept, try again.");
  }
};

import { consumePastes, expandPastes } from "./pastes.ts";
import {
  api,
  forgetOutboxMessage,
  get,
  notice,
  persistOutboxMessage,
  persistShowTargets,
  persistSidebarOpen,
  set,
  uploadPaste,
  uuid,
  warn,
} from "./store.ts";
import { applyDeferredSwapIfReady, pushHighlights, toOverlay } from "./surface.ts";
import type { AgentQuestion, DiffData, OutboxMessage, SessionSummary } from "./types.ts";

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

/** The common annotation asks, offered as one-tap chips on a fresh pick so they
 *  need not be typed. Clicking one queues an annotation for the pending target
 *  with that note - exactly what typing it and pressing Enter does. */
export const QUICK_REPLIES = ["Explain further", "What is this?"] as const;

export const queueQuickReply = (note: string): void => {
  if (!get().pendingTarget) return;
  set({ composerNote: note });
  addToQueue();
};

/** Spin the pending pick off into a new artifact + session instead of annotating
 *  it in place. Unlike an annotation, a fork is a single directive sent on click,
 *  not queued into the review - it asks for a NEW session, not a change to this
 *  one. Lucid only records the request (D-064); the attending agent creates and
 *  `lucid open`s the seeded artifact. The composer note is the directive: what
 *  the new artifact should become. */
/** The directive a fork carries when the composer note is left empty: the region
 *  is the seed, so a fork is meaningful without a typed instruction. */
const DEFAULT_FORK_DIRECTIVE = "Spin this selection off into its own artifact.";

export const forkPending = async (): Promise<void> => {
  const s = get();
  // Re-entrancy guard: a second click while one is in flight would mint a second
  // fork id (a new artifact), which the shared dedupe can't collapse. One at a time.
  // Unlike an annotation, a fork does NOT require a typed note - the selected
  // region is the seed - so an empty composer still forks (with a default directive).
  if (s.forking || !s.pendingTarget) return;
  // Capture the draft; the id is stable across an ambiguous failure so a manual
  // retry reuses it and the server dedupes instead of forking twice.
  const target = s.pendingTarget;
  const rawNote = s.composerNote;
  const note = expandPastes(rawNote).trim() || DEFAULT_FORK_DIRECTIVE;
  const images = s.pastedImages;
  const id = s.forkId ?? uuid();
  set({ forking: true, forkId: id });
  try {
    await api("/__lucid/fork", {
      id,
      version: s.version,
      target,
      note,
      authoredAt: new Date().toISOString(),
      images: images.map(({ id: imgId, name, file }) => ({ id: imgId, name, file })),
    });
  } catch {
    warn("The fork didn't send - the draft is kept, try again.");
    set({ forking: false }); // keep forkId + draft for an idempotent retry
    return;
  }
  consumePastes(rawNote); // the directive's placeholders are spent
  // Clear only if the pick hasn't moved on under us (a mid-flight retarget wins);
  // clearing blind through get() would drop a newer draft and revoke its images.
  if (get().pendingTarget === target) {
    for (const img of images) URL.revokeObjectURL(img.url);
    set({ forking: false, forkId: null, pendingTarget: null, composerNote: "", pastedImages: [] });
  } else {
    set({ forking: false, forkId: null });
  }
  // Confirm it landed - and, since a fork only becomes a new artifact once a
  // consumer acts on it, say what makes that happen.
  notice(
    get().agentsListening > 0
      ? "Forked - the attending agent will spin it into a new session."
      : "Fork recorded. Run `lucid launch <file>` (or attend the session) to spawn it.",
  );
  applyDeferredSwapIfReady();
  pushHighlights();
};

export const discardPending = (): void => {
  for (const img of get().pastedImages) URL.revokeObjectURL(img.url);
  set({ pendingTarget: null, composerNote: "", pastedImages: [], forkId: null });
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
        // The queued card shows the `[Pasted text #N +L lines]` placeholder;
        // what sends is the paste it stands for.
        note: expandPastes(q.note),
        authoredAt: q.at,
        images: q.images.map(({ id, name, file }) => ({ id, name, file })),
      });
      sent.add(q.id); // ids are idempotent, so a retry of a sent one is safe
      consumePastes(q.note); // this note's placeholders are spent
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

/** cmd/ctrl+Enter from anywhere: fold an in-progress composer note into the
 *  queue, then send the whole thing. The composer's plain Enter only queues
 *  the current note; this is the one gesture that flushes the queue without
 *  reaching for the button, even while a text field has focus. */
export const sendAll = async (): Promise<void> => {
  addToQueue(); // no-op unless a note is being composed
  if (get().sending || get().queue.length === 0) return;
  await sendQueue();
};

// ---- message outbox -------------------------------------------------------

/**
 * The message composer's durability layer.
 *
 * assistant-ui empties the composer before `onNew` is called, so from that
 * moment the human's typing exists in exactly one place. It used to be a local
 * variable inside a failing POST - a disconnected server ate long prompts with
 * nothing but a warning left behind. Now every submitted message is written
 * here (and to localStorage) *before* the network is touched, and only leaves
 * once the server has it. A message can therefore be late, but never lost.
 */

export const enqueueMessage = (text: string, images: OutboxMessage["images"]): void => {
  const message: OutboxMessage = {
    id: uuid(),
    text,
    images,
    at: new Date().toISOString(),
    failed: false,
  };
  // Storage first, state second. The gap between them is the only window in
  // which a crash could still eat the message, and this ordering points it the
  // harmless way: a saved-but-unrendered message is recovered on the next load,
  // where a rendered-but-unsaved one would not be.
  persistOutboxMessage(message);
  set((s) => ({ outbox: [...s.outbox, message] }));
};

export const discardOutboxMessage = (id: string): void => {
  forgetOutboxMessage(id);
  set((s) => ({ outbox: s.outbox.filter((m) => m.id !== id) }));
};

/** Surface every entry still held, not just the one that failed. The rest are
 *  equally undelivered, and leaving them `failed: false` hid them behind the
 *  head - blocking approval with no card to retry or discard. */
const markOutboxFailed = (): void => {
  const next = get().outbox.map((m) => (m.failed ? m : { ...m, failed: true }));
  for (const m of next) persistOutboxMessage(m);
  set({ outbox: next });
};

/** Re-entrancy guard for the drain. A reconnect can land while the composer's
 *  own flush is still running; two drains would post the same message twice
 *  (harmless - ids dedupe server-side) and race on the outbox array (not). */
let draining = false;

/**
 * Confirm the server answering at this address is still *our* session's.
 *
 * Ports come from a shared pool (PORT_POOL), so a session that goes away frees
 * an address a different session can later bind. A stale tab's EventSource
 * reconnects to that server perfectly happily - and posting there would hand
 * the human's prompt to the wrong agent, working on the wrong artifact. A
 * message that cannot be delivered is a nuisance; one delivered to the wrong
 * place is worse than the loss this whole mechanism exists to prevent.
 *
 * Only a positive mismatch stops the flush: an unreachable server is the
 * ordinary outage, and it should take the ordinary retry path.
 */
const anotherSessionAnswers = async (): Promise<boolean> => {
  const identity = await api("/__lucid/identity")
    .then((r) => r.json() as Promise<{ session?: unknown }>)
    .catch(() => null);
  return identity !== null && identity.session !== get().session;
};

/**
 * Deliver the outbox, oldest first, stopping at the first failure so the record
 * keeps the order it was written in. `api` has already retried with backoff by
 * the time anything throws here, so a failure means the server is genuinely not
 * answering; the entries stay put and say so.
 */
export const flushOutbox = async (): Promise<void> => {
  if (draining || get().outbox.length === 0) return;
  draining = true;
  set({ outboxSending: true });
  try {
    if (await anotherSessionAnswers()) {
      markOutboxFailed();
      warn(
        "A different session is running at this address now - your message was not sent to it. Copy it and paste it into the right viewer.",
      );
      return;
    }
    // Re-read the head each pass rather than iterate a snapshot: a message
    // submitted *during* a drain (the composer flushing into a reconnect
    // already in flight) appends to the outbox, and a snapshot would leave it
    // sitting there unsent - and invisible, since it has not failed yet.
    for (let m = get().outbox[0]; m !== undefined; m = get().outbox[0]) {
      try {
        // Ids are client-minted and deduped server-side, so re-sending one that
        // actually landed (a lost response) appends nothing.
        await api("/__lucid/message", { id: m.id, text: m.text, refs: [], images: m.images });
      } catch {
        markOutboxFailed();
        warn("Your message didn't send - it's kept below, and you can retry it.");
        return;
      }
      discardOutboxMessage(m.id);
    }
  } finally {
    draining = false;
    set({ outboxSending: false });
  }
};

// ---- review lifecycle -----------------------------------------------------

export const approveReview = async (): Promise<void> => {
  // The button disables itself while work is unsent; the ⌘⇧↵ shortcut bypasses
  // that, so the refusal lives here where both paths pass through it. Approving
  // appends review_resolved, which the agent acts on and never re-reads behind.
  const s = get();
  if (s.reviewResolved) return;
  const hasDraft = s.pendingTarget !== null && s.composerNote.trim().length > 0;
  // The outbox counts: a message the server never took is unsent feedback in
  // exactly the sense this guard exists for.
  if (s.queue.length > 0 || hasDraft || s.outbox.length > 0) {
    warn(
      "Send or discard your unsent feedback before approving - the agent stops reading once you do.",
    );
    return;
  }
  try {
    await api("/__lucid/resolve", {});
  } catch {
    warn("Approve didn't send - try again.");
  }
};

/** Show/hide the annotation marks on the surface (the crosshair toggle, and its
 *  ⌘⇧M shortcut). Read mode lets the artifact be read as a plain document. */
export const toggleTargets = (): void => {
  const next = !get().showTargets;
  set({ showTargets: next });
  persistShowTargets(next);
  pushHighlights();
};

const REOPEN_ENDED_MSG =
  "This session has ended - reopening needs the agent to run `lucid open` again.";

export const reopenReview = async (): Promise<void> => {
  // An ended session has no server to receive the reopen - the POST can only
  // fail, and "try again" would be a lie. Say what the way back actually is.
  if (get().status === "ended") {
    warn(REOPEN_ENDED_MSG);
    return;
  }
  try {
    await api("/__lucid/reopen", {});
    // The reopen landed in the log, but approval already released the agent -
    // if nobody is in a wait loop, feedback sent now sits recorded until an
    // agent checks back in, and the human should know that before writing it.
    if (get().agentsListening === 0) {
      notice(
        "Review reopened - no agent is listening right now. Feedback is recorded and delivered when one checks in.",
      );
    }
  } catch {
    // Re-check after the failure: the click can race the session_ended frame,
    // and by now the state knows which failure this actually was.
    warn(get().status === "ended" ? REOPEN_ENDED_MSG : "Reopen didn't send - try again.");
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

/** Select (single-choice) or toggle (multi) an option on a question's answer. */
export const toggleAnswerOption = (q: AgentQuestion, label: string): void =>
  set((s) => {
    const current = s.answerOptions[q.id] ?? [];
    const has = current.includes(label);
    const next = q.multi
      ? has
        ? current.filter((l) => l !== label)
        : [...current, label]
      : has
        ? []
        : [label];
    return { answerOptions: { ...s.answerOptions, [q.id]: next } };
  });

/** Enter "pin a region for this answer" mode; the next artifact pick attaches
 *  to this question (see Chrome's target-picked handler). Ensures marks are on
 *  so the overlay accepts a pick. */
export const startAnswerPick = (q: AgentQuestion): void => {
  if (!get().showTargets) {
    set({ showTargets: true });
    persistShowTargets(true);
  }
  set({ answerPickFor: q.id });
  pushHighlights();
};

export const cancelAnswerPick = (): void => set({ answerPickFor: null });

export const clearAnswerAnchor = (q: AgentQuestion): void =>
  set((s) => {
    const next = { ...s.answerAnchors };
    delete next[q.id];
    return {
      answerAnchors: next,
      answerPickFor: s.answerPickFor === q.id ? null : s.answerPickFor,
    };
  });

export const addAnswerImage = async (q: AgentQuestion, file: File): Promise<void> => {
  // Track the upload so submission can wait on it: choosing an image and
  // immediately hitting Answer must not drop the image, nor let the send's
  // cleanup race a finishing upload.
  set((s) => ({
    answerUploading: { ...s.answerUploading, [q.id]: (s.answerUploading[q.id] ?? 0) + 1 },
  }));
  try {
    const img = await uploadPaste(file);
    if (!img) return;
    // If the question was cleared while this was uploading (answered or
    // skipped), its uploading counter is gone - don't resurrect state for it;
    // just release the object URL so nothing leaks.
    if ((get().answerUploading[q.id] ?? 0) > 0) {
      set((s) => ({
        answerImages: { ...s.answerImages, [q.id]: [...(s.answerImages[q.id] ?? []), img] },
      }));
    } else {
      URL.revokeObjectURL(img.url);
    }
  } finally {
    set((s) => {
      // The question may have been cleared mid-upload; if so its counter is
      // gone and there is nothing to decrement (recreating it would resurrect it).
      const n = s.answerUploading[q.id];
      if (n === undefined) return {};
      return { answerUploading: { ...s.answerUploading, [q.id]: Math.max(0, n - 1) } };
    });
  }
};

export const removeAnswerImage = (q: AgentQuestion, id: string): void =>
  set((s) => {
    const list = s.answerImages[q.id] ?? [];
    const img = list.find((i) => i.id === id);
    if (img) URL.revokeObjectURL(img.url);
    return { answerImages: { ...s.answerImages, [q.id]: list.filter((i) => i.id !== id) } };
  });

/** Drop all staged answer state for a question (draft, options, anchor, images,
 *  and the upload counter) and exit its pick mode - shared by send and skip.
 *  Clearing the upload counter is also how an in-flight `addAnswerImage` detects
 *  the question was cleared and declines to resurrect it. Object URLs the caller
 *  still holds are revoked by the caller. */
const clearAnswerState = (st: ReturnType<typeof get>, id: string) => {
  const drafts = { ...st.answerDrafts };
  const opts = { ...st.answerOptions };
  const anchors = { ...st.answerAnchors };
  const imgs = { ...st.answerImages };
  const uploading = { ...st.answerUploading };
  delete drafts[id];
  delete opts[id];
  delete anchors[id];
  delete imgs[id];
  delete uploading[id];
  return {
    answerDrafts: drafts,
    answerOptions: opts,
    answerAnchors: anchors,
    answerImages: imgs,
    answerUploading: uploading,
    answerPickFor: st.answerPickFor === id ? null : st.answerPickFor,
  };
};

export const sendAnswer = async (q: AgentQuestion): Promise<void> => {
  const s = get();
  const text = (s.answerDrafts[q.id] ?? "").trim();
  const options = s.answerOptions[q.id] ?? [];
  const anchor = s.answerAnchors[q.id];
  const images = s.answerImages[q.id] ?? [];
  // Never send with an image still uploading: it would be omitted, and the
  // send's cleanup could race the finishing upload. Enter is dropped here; the
  // button is disabled for the same reason.
  if ((s.answerUploading[q.id] ?? 0) > 0) return;
  // A bare submission carries nothing to act on; the button is disabled for this
  // too, but guard here so a stray Enter cannot post an empty answer.
  if (text.length === 0 && options.length === 0 && !anchor && images.length === 0) return;
  try {
    await api("/__lucid/answer", {
      id: uuid(),
      questionId: q.id,
      text,
      ...(options.length > 0 ? { options } : {}),
      ...(anchor ? { anchor } : {}),
      ...(images.length > 0
        ? { images: images.map(({ id, name, file }) => ({ id, name, file })) }
        : {}),
    });
    // Clear this question's staged answer only after it is recorded.
    for (const img of images) URL.revokeObjectURL(img.url);
    set((st) => clearAnswerState(st, q.id));
  } catch {
    warn("Your answer didn't send - it's kept here, try again.");
  }
};

/** Decline a question: it leaves the panel and the agent is told the human
 *  skipped it (so it proceeds without an answer rather than re-asking). Any
 *  staged draft/options/anchor/images for it are discarded. */
export const skipQuestion = async (q: AgentQuestion): Promise<void> => {
  try {
    await api("/__lucid/answer", { id: uuid(), questionId: q.id, text: "", skipped: true });
    // Revoke any already-staged image URLs; a still-in-flight upload sees the
    // cleared counter and revokes its own.
    for (const img of get().answerImages[q.id] ?? []) URL.revokeObjectURL(img.url);
    set((st) => clearAnswerState(st, q.id));
  } catch {
    warn("Couldn't skip that question - try again.");
  }
};

export const focusQuestionRef = (ref?: string): void => {
  if (ref) toOverlay({ source: "lucid-chrome", type: "focus-annotation", id: ref });
};

/** Scroll the artifact to a section by its `data-lucid-id`. The landing for a
 *  chat section permalink (`lucid:section/<id>`). */
export const revealSection = (lucidId: string): void => {
  toOverlay({ source: "lucid-chrome", type: "reveal-section", lucidId });
};

// ---- change view ----------------------------------------------------------

export const enterDiff = async (base = get().diffBase): Promise<void> => {
  if (get().viewingVersion !== null) set({ viewingVersion: null }); // diff and history view are exclusive surfaces
  try {
    const res = await api(`/__lucid/diff?base=${base}`);
    const data = (await res.json()) as DiffData;
    set({ diffData: data, diffBase: base, diffMode: true, diffIndex: 0 });
    toOverlay({ source: "lucid-chrome", type: "diff-show", html: data.mergedHtml });
    if (data.hunks.length > 0) requestAnimationFrame(() => gotoHunk(0));
  } catch {
    // The bare catch here used to swallow a dead server whole, so the button
    // looked inert. Say what likely broke instead.
    warn("Couldn't load the changes - is the Lucid server still running?");
  }
};

/**
 * Load a past version's full artifact into the surface, read-only. Distinct
 * from the diff: this is the whole document as it was at vN, not a comparison.
 * Picking is refused while it is up (Chrome guards target-picked) - a snapshot
 * is not the live DOM, so an anchor captured against it would point at nothing
 * on return.
 */
export const viewVersion = async (v: number): Promise<void> => {
  if (v >= get().version) return exitVersionView(); // "current" in the picker means leave history
  if (get().diffMode) await exitDiff();
  const html = await api(`/__lucid/version?v=${v}`)
    .then((r) => r.text())
    .catch(() => null);
  if (html === null) {
    warn("Couldn't load that version's snapshot.");
    return;
  }
  set({ viewingVersion: v });
  // Clear marks and drop out of targeting first: the current annotations do not
  // belong on a historical snapshot, and read mode is what a snapshot is.
  toOverlay({
    source: "lucid-chrome",
    type: "highlight",
    annotations: [],
    queued: [],
    pending: null,
    showTargets: false,
  });
  toOverlay({ source: "lucid-chrome", type: "swap", html });
};

/** Return the surface to the live current artifact and restore its marks. */
export const exitVersionView = async (): Promise<void> => {
  if (get().viewingVersion === null) return;
  set({ viewingVersion: null });
  const html = await api("/__lucid/artifact")
    .then((r) => r.text())
    .catch(() => null);
  if (html !== null) toOverlay({ source: "lucid-chrome", type: "swap", html });
  pushHighlights();
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

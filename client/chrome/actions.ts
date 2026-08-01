import { visibleEl } from "./dom.ts";
import type { Pastes } from "./pastes.ts";
import {
  buildItems,
  draftIssues,
  type GroupDraft,
  groupOf,
  initialDraft,
  legacyAnswerFields,
} from "./question-draft.ts";
import type { Notify, SessionStorage, SessionStore } from "./store.ts";
import { approveBlockedReason, hasComposerDraft, toWireImages, uuid } from "./store.ts";
import type { DecisionReply } from "../shared/decision.ts";
import type { Surface } from "./surface.ts";
import type { Transport, UploadedAsset } from "./transport.ts";
import type {
  AgentQuestion,
  DiffData,
  MessageImage,
  OutboxMessage,
  PastedImage,
  QueuedAnnotation,
  SessionSummary,
} from "./types.ts";

/** Every mutation the human can make, bound to ONE session. Kept out of the
 *  components so the flow (and its ordering rules) reads in one place - and
 *  out of module scope so two open sessions can never share a queue, an
 *  outbox drain, or a fork guard. */

export interface ActionsCtx {
  readonly store: SessionStore;
  readonly transport: Transport;
  readonly surface: Surface;
  readonly pastes: Pastes;
  readonly storage: SessionStorage;
  readonly notify: Notify;
}

/** The common annotation asks, offered as one-tap chips on a fresh pick so they
 *  need not be typed. Clicking one queues an annotation for the pending target
 *  with that note - exactly what typing it and pressing Enter does. */
export const QUICK_REPLIES = ["Explain further", "What is this?"] as const;

/** The directive a fork carries when the composer note is left empty: the region
 *  is the seed, so a fork is meaningful without a typed instruction. */
const DEFAULT_FORK_DIRECTIVE = "Spin this selection off into its own artifact.";

export type SessionActions = ReturnType<typeof createActions>;

export const createActions = (ctx: ActionsCtx) => {
  const { store, transport, surface, pastes, storage, notify } = ctx;
  const get = store.getState;
  const set = store.setState;
  const { api } = transport;
  const { warn, notice, pushWarning } = notify;
  const { expandPastes, consumePastes } = pastes;
  const { applyDeferredSwapIfReady, pushHighlights, toOverlay } = surface;

  const persistOutbox = (message: OutboxMessage): void =>
    storage.persistOutboxMessage(message, () =>
      pushWarning(
        "DRAFT_AT_RISK",
        "Couldn't save your unsent message to this browser - copy it before reloading.",
      ),
    );

  /** The queue's durability layer, mirroring the outbox's (D-054): written on
   *  queue and on edit, forgotten on send and on remove, restored on load.
   *
   *  Persisted EXPANDED, the way the outbox is (`runtime.tsx` expands before
   *  `enqueueMessage`): the `[Pasted text #N]` placeholder is a pointer into
   *  the in-memory paste store, which dies with the page - a persisted
   *  placeholder came back from a reload as forty lines of nothing and sent
   *  itself to the agent verbatim. Memory keeps the placeholder for display;
   *  storage keeps the words. */
  const persistQueued = (item: QueuedAnnotation): void =>
    storage.persistQueuedItem({ ...item, note: expandPastes(item.note) }, () =>
      pushWarning(
        "DRAFT_AT_RISK",
        "Couldn't save your queued annotation to this browser - it won't survive a reload.",
      ),
    );

  /** Upload a pasted blob and stage it for the annotation composer. */
  const uploadPaste = async (file: File): Promise<PastedImage | null> => {
    try {
      const meta: UploadedAsset = await transport.uploadAsset(file);
      return { ...meta, url: URL.createObjectURL(file) };
    } catch {
      warn("That image didn't upload - try again.");
      return null;
    }
  };

  // ---- composer -------------------------------------------------------------

  const addToQueue = (): void => {
    const s = get();
    if (!s.pendingTarget) return;
    if (s.composerNote.trim().length === 0) {
      // The keyboard route to the same refusal the disabled button makes
      // visible: Enter in a blank composer is an explicit "queue this", and
      // silence here was the original defect wearing a different input device.
      warn("A note is the point of an annotation - type what should change before queueing.");
      return;
    }
    const item: QueuedAnnotation = {
      id: uuid(),
      target: s.pendingTarget,
      // The whole cmd-collected set rides as ONE queued item: one note
      // covering every spot (a singleton for the ordinary pick).
      targets: s.pendingTargets,
      note: s.composerNote.trim(),
      at: new Date().toISOString(),
      images: s.pastedImages,
    };
    // Storage first, state second, like the outbox: the gap between them is
    // the only window a crash could eat the note, and this ordering points it
    // the harmless way.
    persistQueued(item);
    set({
      queue: [...s.queue, item],
      pendingTarget: null,
      pendingTargets: [],
      composerNote: "",
      pastedImages: [],
    });
    pushHighlights();
    // Queueing dismounts the note's textarea, which would strand focus on
    // <body>. Hand it to the message composer - the next thing typed is either
    // a message or another pick, and a pick never needed keyboard focus. And a
    // manual submit is an explicit "take me back down", even from a scroll-up.
    requestAnimationFrame(() => {
      visibleEl<HTMLTextAreaElement>('[data-test="message-input"]')?.focus();
      const vp = visibleEl('[data-test="thread-viewport"]');
      vp?.scrollTo({ top: vp.scrollHeight, behavior: "smooth" });
    });
  };

  const queueQuickReply = (note: string): void => {
    const s = get();
    if (!s.pendingTarget) return;
    // A chip clicked over a half-typed note must not eat the typing: the draft
    // and the canned ask ride as ONE queued note, the draft first (D-053).
    const typed = s.composerNote.trim();
    set({ composerNote: typed ? `${typed}\n\n${note}` : note });
    addToQueue();
  };

  /**
   * Answer a marked decision: Agree or Decline, one tap.
   *
   * The note lands on the DECISION, not on whatever was picked inside it. That
   * is the whole point of the rule - a recommendation contains other pickable
   * things and its boundary is invisible until the overlay draws it, so
   * landing on a phrase inside it must still let you decide, and the decision
   * is what gets answered. A typed note still annotates exactly what was
   * picked; only these two chips retarget.
   *
   * Any draft note rides along, the way a quick reply's does (D-053): typing
   * "the rollback worries me" and then tapping Decline sends both, because
   * throwing away what someone just typed is never the helpful reading.
   */
  const queueDecision = (reply: DecisionReply): void => {
    const s = get();
    const decision = s.pendingDecision;
    if (!decision) return;
    const typed = s.composerNote.trim();
    const item: QueuedAnnotation = {
      id: uuid(),
      target: decision,
      targets: [decision],
      note: typed ? `${reply}\n\n${typed}` : reply,
      at: new Date().toISOString(),
      images: s.pastedImages,
    };
    persistQueued(item);
    set((prev) => ({
      queue: [...prev.queue, item],
      pendingTarget: null,
      pendingTargets: [],
      pendingDecision: null,
      composerNote: "",
      pastedImages: [],
      forkId: null,
    }));
    pushHighlights();
  };

  /** Spin the pending pick off into a new artifact + session instead of
   *  annotating it in place. Unlike an annotation, a fork is a single directive
   *  sent on click, not queued into the review - it asks for a NEW session, not
   *  a change to this one. Lucid only records the request (D-064); the
   *  attending agent creates and `lucid open`s the seeded artifact. The
   *  composer note is the directive: what the new artifact should become. */
  const forkPending = async (): Promise<void> => {
    const s = get();
    // Re-entrancy guard: a second click while one is in flight would mint a
    // second fork id (a new artifact), which the shared dedupe can't collapse.
    // One at a time. Unlike an annotation, a fork does NOT require a typed
    // note - the selected region is the seed - so an empty composer still
    // forks (with a default directive).
    if (s.forking || !s.pendingTarget) return;
    // Capture the draft; the id is stable across an ambiguous failure so a
    // manual retry reuses it and the server dedupes instead of forking twice.
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
        images: toWireImages(images),
      });
    } catch {
      warn("The fork didn't send - the draft is kept, try again.");
      set({ forking: false }); // keep forkId + draft for an idempotent retry
      return;
    }
    consumePastes(rawNote); // the directive's placeholders are spent
    // Clear only if the pick hasn't moved on under us (a mid-flight retarget
    // wins); clearing blind through get() would drop a newer draft and revoke
    // its images.
    if (get().pendingTarget === target) {
      for (const img of images) URL.revokeObjectURL(img.url);
      set({
        forking: false,
        forkId: null,
        pendingTarget: null,
        pendingTargets: [],
        composerNote: "",
        pastedImages: [],
      });
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

  const discardPending = (): void => {
    for (const img of get().pastedImages) URL.revokeObjectURL(img.url);
    // The whole collection goes as one gesture: Escape discards the draft,
    // and a cmd-collected draft IS one draft, however many spots it covers.
    set({
      pendingTarget: null,
      pendingTargets: [],
      pendingDecision: null,
      composerNote: "",
      pastedImages: [],
      forkId: null,
    });
    applyDeferredSwapIfReady();
    pushHighlights();
  };

  /** Drop one collected spot from the draft (a chip's ×). Removing the last
   *  one discards the draft whole - a note with no spot is not an annotation. */
  const removePendingTarget = (index: number): void => {
    const next = get().pendingTargets.filter((_, i) => i !== index);
    if (next.length === 0) {
      discardPending();
      return;
    }
    // An edited collection is a new fork candidate (the pick handler's rule):
    // a kept id would let the server dedupe a retry that now forks a
    // different first spot, silently dropping it.
    set({ pendingTargets: next, pendingTarget: next[0] ?? null, forkId: null });
    pushHighlights();
  };

  const setComposerNote = (note: string): void => set({ composerNote: note });

  /** Stage a pasted image on the annotation being composed. */
  const addPastedImage = async (file: File): Promise<void> => {
    const img = await uploadPaste(file);
    if (img) set((s) => ({ pastedImages: [...s.pastedImages, img] }));
  };

  const removePastedImage = (id: string): void => {
    const img = get().pastedImages.find((i) => i.id === id);
    if (img) URL.revokeObjectURL(img.url);
    set((s) => ({ pastedImages: s.pastedImages.filter((i) => i.id !== id) }));
  };

  const removeQueued = (id: string): void => {
    if (get().editingId === id) cancelEdit();
    // Removing the card drops the last reference to its staged thumbnails.
    // Revoking is safe for restored items too: their `url` is the asset
    // route, and revoking a non-blob URL is a documented no-op.
    const item = get().queue.find((q) => q.id === id);
    if (item) for (const img of item.images) URL.revokeObjectURL(img.url);
    storage.forgetQueuedItem(id);
    set((s) => ({ queue: s.queue.filter((q) => q.id !== id) }));
    applyDeferredSwapIfReady();
    pushHighlights();
  };

  /** Open a queued annotation's note for editing. Only one card edits at a
   *  time, so an already-open edit is folded back in first. */
  const beginEdit = (id: string): void => {
    const item = get().queue.find((q) => q.id === id);
    if (!item) return;
    if (!commitEdit()) return;
    set({ editingId: id, editDraft: item.note });
  };

  const cancelEdit = (): void => set({ editingId: null, editDraft: "" });

  const setEditDraft = (draft: string): void => set({ editDraft: draft });

  /** Fold an open edit back into the queue. The note is the whole point of an
   *  annotation, so an empty draft is refused rather than silently dropped;
   *  callers check the result before proceeding. */
  const commitEdit = (): boolean => {
    const s = get();
    if (s.editingId === null) return true;
    const note = s.editDraft.trim();
    if (note.length === 0) return false;
    const id = s.editingId;
    // An unchanged note commits without writing: `beginEdit` folds the open
    // editor in first, so merely switching between two cards passed through
    // here - and paid a storage write plus a fresh queue array (one no-op
    // render per subscriber) for typing nothing.
    if (s.queue.find((q) => q.id === id)?.note === note) {
      set({ editingId: null, editDraft: "" });
      return true;
    }
    // One construction serves both the persist and the state, so a future
    // field-fixup cannot land in one and miss the other.
    const next = s.queue.map((q) => (q.id === id ? { ...q, note } : q));
    const edited = next.find((q) => q.id === id);
    if (edited) persistQueued(edited);
    set({ queue: next, editingId: null, editDraft: "" });
    return true;
  };

  const sendQueue = async (): Promise<void> => {
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
          // A multi-spot item sends `targets`; the server derives `target` as
          // the first and ignores the one beside it. A singleton stays the
          // canonical single form.
          ...(q.targets.length > 1 ? { targets: q.targets } : {}),
          // The queued card shows the `[Pasted text #N +L lines]` placeholder;
          // what sends is the paste it stands for.
          note: expandPastes(q.note),
          authoredAt: q.at,
          images: toWireImages(q.images),
        });
        sent.add(q.id); // ids are idempotent, so a retry of a sent one is safe
        storage.forgetQueuedItem(q.id); // it reached the log; storage owes nothing
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
    // `awaitingAck` only when something actually landed: a send that delivered
    // nothing (every POST threw) leaves the queue intact and its own warning,
    // and must not claim the agent has feedback to answer.
    set((s) => ({
      sending: false,
      queue: s.queue.filter((q) => !sent.has(q.id)),
      ...(sent.size > 0 ? { awaitingAck: new Set(sent) } : {}),
    }));
    applyDeferredSwapIfReady();
    pushHighlights();
  };

  /** cmd/ctrl+Enter from anywhere: fold an in-progress composer note into the
   *  queue, then send the whole thing. The composer's plain Enter only queues
   *  the current note; this is the one gesture that flushes the queue without
   *  reaching for the button, even while a text field has focus. */
  const sendAll = async (): Promise<void> => {
    // Fold an in-progress note in only when one EXISTS: this gesture means
    // "send the queue", and the blank-note refusal - which a plain Enter
    // earns - would be noise on a batch send that queues nothing.
    if (hasComposerDraft(get())) addToQueue();
    if (get().sending || get().queue.length === 0) return;
    await sendQueue();
  };

  // ---- message outbox -------------------------------------------------------

  /**
   * The message composer's durability layer.
   *
   * assistant-ui empties the composer before `onNew` is called, so from that
   * moment the human's typing exists in exactly one place. It used to be a
   * local variable inside a failing POST - a disconnected server ate long
   * prompts with nothing but a warning left behind. Now every submitted
   * message is written here (and to localStorage) *before* the network is
   * touched, and only leaves once the server has it. A message can therefore
   * be late, but never lost.
   */

  const enqueueMessage = (text: string, images: OutboxMessage["images"]): void => {
    const message: OutboxMessage = {
      id: uuid(),
      text,
      images,
      at: new Date().toISOString(),
      failed: false,
    };
    // Storage first, state second. The gap between them is the only window in
    // which a crash could still eat the message, and this ordering points it
    // the harmless way: a saved-but-unrendered message is recovered on the
    // next load, where a rendered-but-unsaved one would not be.
    persistOutbox(message);
    set((s) => ({ outbox: [...s.outbox, message] }));
  };

  const discardOutboxMessage = (id: string): void => {
    storage.forgetOutboxMessage(id);
    set((s) => ({ outbox: s.outbox.filter((m) => m.id !== id) }));
  };

  /** Surface every entry still held, not just the one that failed. The rest are
   *  equally undelivered, and leaving them `failed: false` hid them behind the
   *  head - blocking approval with no card to retry or discard. */
  const markOutboxFailed = (): void => {
    const next = get().outbox.map((m) => (m.failed ? m : { ...m, failed: true }));
    for (const m of next) persistOutbox(m);
    set({ outbox: next });
  };

  /** Re-entrancy guard for the drain. A reconnect can land while the composer's
   *  own flush is still running; two drains would post the same message twice
   *  (harmless - ids dedupe server-side) and race on the outbox array (not). */
  let draining = false;

  /**
   * Confirm the server answering at this address is still *our* session's.
   *
   * Ports come from a shared pool (PORT_POOL), so a session that goes away
   * frees an address a different session can later bind. A stale tab's
   * EventSource reconnects to that server perfectly happily - and posting
   * there would hand the human's prompt to the wrong agent, working on the
   * wrong artifact. A message that cannot be delivered is a nuisance; one
   * delivered to the wrong place is worse than the loss this whole mechanism
   * exists to prevent.
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
   * Deliver the outbox, oldest first, stopping at the first failure so the
   * record keeps the order it was written in. `api` has already retried with
   * backoff by the time anything throws here, so a failure means the server is
   * genuinely not answering; the entries stay put and say so.
   */
  const flushOutbox = async (): Promise<void> => {
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
      // already in flight) appends to the outbox, and a snapshot would leave
      // it sitting there unsent - and invisible, since it has not failed yet.
      for (let m = get().outbox[0]; m !== undefined; m = get().outbox[0]) {
        set({ outboxSendingId: m.id });
        try {
          // Ids are client-minted and deduped server-side, so re-sending one
          // that actually landed (a lost response) appends nothing.
          await api("/__lucid/message", {
            id: m.id,
            text: m.text,
            refs: [],
            images: m.images,
            // Addressed, not just posted: the server rejects it if this address
            // now belongs to another artifact.
            session: get().session,
          });
        } catch (e) {
          markOutboxFailed();
          // The reason, not just the fact. "It didn't send" gave nothing to act
          // on - the difference between a busy log (retry works) and a hub that
          // is gone (retry never will) is the whole decision.
          const reason = e instanceof Error ? e.message : "";
          if (/different session/i.test(reason)) {
            warn(
              "A different session is running at this address now - your message was not sent to it. Copy it and paste it into the right viewer.",
            );
            return;
          }
          const why = reason === "" ? "" : ` (${reason})`;
          warn(`Your message didn't send${why} - it's kept below, and you can retry it.`);
          return;
        }
        discardOutboxMessage(m.id);
        // The message really landed, so open the delivered-waiting window
        // (D-054 / finding #19). A headless turn takes 3-4s to ack - attend's
        // quiet window plus a poll - and without this the composer showed
        // NOTHING for that whole gap: the annotation path set this and the
        // message path did not, so marking up text said "Delivered - starting
        // a turn…" while typing said nothing at all. Not in the catch: a post
        // that threw keeps its text and its own warning, and must not claim
        // the agent has feedback to answer.
        set((s2) => ({ awaitingAck: new Set([...(s2.awaitingAck ?? []), m.id]) }));
      }
    } finally {
      draining = false;
      set({ outboxSending: false, outboxSendingId: null });
    }
  };

  // ---- review lifecycle -----------------------------------------------------

  const approveReview = async (): Promise<void> => {
    // The button disables itself while work is unsent; the ⌘⇧↵ shortcut
    // bypasses that, so the refusal lives here where both paths pass through
    // it. Approving appends review_resolved, which the agent acts on and never
    // re-reads behind.
    const s = get();
    if (s.reviewResolved) return;
    // The outbox counts: a message the server never took is unsent feedback in
    // exactly the sense this guard exists for. The reason is the SAME sentence
    // the button's tooltip shows - one definition, so a click cannot say less
    // than a hover.
    const reason = approveBlockedReason({
      queued: s.queue.length,
      hasDraft: s.pendingTarget !== null && s.composerNote.trim().length > 0,
      undelivered: s.outbox.length,
    });
    if (reason !== null) {
      warn(`${reason} - the agent stops reading once you approve.`);
      return;
    }
    try {
      await api("/__lucid/resolve", {});
    } catch {
      warn("Approve didn't send - try again.");
    }
  };

  /** Show/hide the annotation marks on the surface (the crosshair toggle, and
   *  its ⌘. shortcut). Read mode lets the artifact be read as a plain document. */
  const toggleTargets = (): void => {
    const next = !get().showTargets;
    set({ showTargets: next });
    storage.persistShowTargets(next);
    pushHighlights();
  };

  /** Focus every sent annotation at once, or none (the header's highlighter
   *  toggle). It drops the single focus either way: "all" and "one" are the
   *  same setting at different scopes, and nothing scrolls - with many marks
   *  lit there is no one place to go. */
  const toggleFocusAll = (): void => {
    const next = !get().focusAll;
    set({ focusAll: next, focusedId: null });
    storage.persistFocusAll(next);
    pushHighlights();
  };

  /** One card's focus/unfocus link. Focus is exclusive: taking it releases
   *  whatever held it, including the header's all-at-once. Focusing also
   *  reveals - the human just asked "where is this?" and the mark may be far
   *  off-screen, so painting it without going there answers only half the
   *  question. Unfocusing leaves the artifact where it is. */
  const toggleFocus = (id: string): void => {
    const unfocus = get().focusedId === id;
    set({ focusedId: unfocus ? null : id, focusAll: false });
    storage.persistFocusAll(false);
    pushHighlights();
    if (!unfocus) toOverlay({ source: "lucid-chrome", type: "reveal-annotation", id });
  };

  const REOPEN_ENDED_MSG =
    "This session has ended - reopening needs the agent to run `lucid open` again.";

  const reopenReview = async (): Promise<void> => {
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

  const loadSessions = async (): Promise<void> => {
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

  /**
   * Switch the viewer to another session. Each session is its own server on
   * its own port, so this is a navigation, not a swap: a full load is correct,
   * since the new session has its own stream, its own folded state and its own
   * origin.
   *
   * The queue lives in this tab's memory, so leaving with unsent work would
   * silently eat it. Refuse instead, and say why.
   */
  const switchToSession = (s: SessionSummary): void => {
    const st = get();
    if (st.queue.length > 0 || (st.pendingTarget !== null && st.composerNote.trim().length > 0)) {
      warn("Send or discard your unsent feedback before switching sessions.");
      return;
    }
    if (!s.viewer) return;
    window.location.href = s.viewer;
  };

  // ---- agent questions ------------------------------------------------------

  /**
   * Apply one pure reducer from the drawer's view-model to a question's draft.
   * The store holds the draft (a lowered drawer must not lose it) and the
   * view-model owns every rule about what a selection means, so this is the
   * whole seam between them: no answer logic lives here, and no state lives
   * there.
   */
  const updateQuestionDraft = (q: AgentQuestion, update: (draft: GroupDraft) => GroupDraft): void =>
    set((s) => ({
      questionDrafts: {
        ...s.questionDrafts,
        [q.id]: update(s.questionDrafts[q.id] ?? initialDraft(groupOf(q))),
      },
    }));

  /**
   * Lower the drawer without touching any draft (Escape, and the drawer's own
   * close). The dismissal names the asks OUTSTANDING RIGHT NOW, so a question
   * that arrives afterwards raises the drawer again: lowering one ask is not a
   * standing refusal to be asked. The reopen bar raises it in the meantime.
   */
  const dismissQuestionDrawer = (): void =>
    set((s) => ({
      questionDrawerDismissed: s.questions.filter((q) => !q.answered).map((q) => q.id),
      answerPickFor: null,
    }));

  const raiseQuestionDrawer = (): void => set({ questionDrawerDismissed: [] });

  /** Enter "pin a region for this answer" mode; the next artifact pick attaches
   *  to this question (see the shell's target-picked handler). Ensures marks
   *  are on so the overlay accepts a pick. */
  const startAnswerPick = (q: AgentQuestion): void => {
    if (!get().showTargets) {
      set({ showTargets: true });
      storage.persistShowTargets(true);
    }
    set({ answerPickFor: q.id });
    pushHighlights();
  };

  const cancelAnswerPick = (): void => set({ answerPickFor: null });

  /** The one panic gesture for targeting: drop the composer's collected spots
   *  (the whole annotation draft) AND every question's staged pins at once.
   *  Lives on the surface, where the marks are - by the time several spots
   *  are lit across the draft and two answers, per-chip × is bookkeeping. */
  const cancelAllPicks = (): void => {
    set({ answerAnchors: {}, answerAnchorLists: {}, answerPickFor: null });
    discardPending();
  };

  const clearAnswerAnchor = (q: AgentQuestion): void =>
    set((s) => {
      const next = { ...s.answerAnchors };
      const lists = { ...s.answerAnchorLists };
      delete next[q.id];
      delete lists[q.id];
      return {
        answerAnchors: next,
        answerAnchorLists: lists,
        answerPickFor: s.answerPickFor === q.id ? null : s.answerPickFor,
      };
    });

  /** Drop one pinned spot from an answer (a chip's ×); clearing the last one
   *  clears the answer anchor entirely. */
  const removeAnswerAnchor = (q: AgentQuestion, index: number): void => {
    const next = (get().answerAnchorLists[q.id] ?? []).filter((_, i) => i !== index);
    if (next.length === 0) {
      clearAnswerAnchor(q);
      return;
    }
    set((s) => ({
      answerAnchors: { ...s.answerAnchors, [q.id]: next[0]! },
      answerAnchorLists: { ...s.answerAnchorLists, [q.id]: next },
    }));
  };

  const addAnswerImage = async (q: AgentQuestion, file: File): Promise<void> => {
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
        // gone and there is nothing to decrement (recreating it would
        // resurrect it).
        const n = s.answerUploading[q.id];
        if (n === undefined) return {};
        return { answerUploading: { ...s.answerUploading, [q.id]: Math.max(0, n - 1) } };
      });
    }
  };

  const removeAnswerImage = (q: AgentQuestion, id: string): void =>
    set((s) => {
      const list = s.answerImages[q.id] ?? [];
      const img = list.find((i) => i.id === id);
      if (img) URL.revokeObjectURL(img.url);
      return { answerImages: { ...s.answerImages, [q.id]: list.filter((i) => i.id !== id) } };
    });

  /** Drop all staged answer state for a question (draft, anchor, images, and
   *  the upload counter) and exit its pick mode - shared by submit and skip.
   *  Clearing the upload counter is also how an in-flight `addAnswerImage`
   *  detects the question was cleared and declines to resurrect it. Object URLs
   *  the caller still holds are revoked by the caller. */
  const clearAnswerState = (st: ReturnType<typeof get>, id: string) => {
    const drafts = { ...st.questionDrafts };
    const anchors = { ...st.answerAnchors };
    const anchorLists = { ...st.answerAnchorLists };
    const imgs = { ...st.answerImages };
    const uploading = { ...st.answerUploading };
    delete drafts[id];
    delete anchors[id];
    delete anchorLists[id];
    delete imgs[id];
    delete uploading[id];
    return {
      questionDrafts: drafts,
      answerAnchors: anchors,
      answerAnchorLists: anchorLists,
      answerImages: imgs,
      answerUploading: uploading,
      answerPickFor: st.answerPickFor === id ? null : st.answerPickFor,
      questionDrawerDismissed: st.questionDrawerDismissed.filter((qid) => qid !== id),
    };
  };

  /** Answer sends in flight, by question id. A second click would otherwise
   *  append a second `question_answered` event for one decision - the fold
   *  takes the last of them and `lucid wait` wakes twice. */
  const answerSending = new Set<string>();

  /**
   * Submit the drawer's draft as the answer to one asked question (D12).
   *
   * Gated by the SHARED validator, so this can only post what the server would
   * accept. Two wire shapes, one draft: a question the agent asked with a
   * `group` takes per-item answers; a legacy one (text + options) has no stored
   * contract to validate items against, so it takes the fields that wire has
   * always carried. The pinned region and images ride the answer either way.
   */
  const submitAnswer = async (q: AgentQuestion): Promise<void> => {
    const s = get();
    const group = groupOf(q);
    const draft = s.questionDrafts[q.id] ?? initialDraft(group);
    // Never send with an image still uploading: it would be omitted, and the
    // send's cleanup could race the finishing upload. Enter is dropped here;
    // the button is disabled for the same reason.
    if ((s.answerUploading[q.id] ?? 0) > 0) return;
    if (answerSending.has(q.id)) return;
    const anchor = s.answerAnchors[q.id];
    const anchorList = s.answerAnchorLists[q.id] ?? [];
    const images = s.answerImages[q.id] ?? [];
    const hasAttachments = anchor !== undefined || images.length > 0;
    if (draftIssues(group, draft, { hasAttachments }).length > 0) return;
    const grouped = (q.group?.length ?? 0) > 0;
    const legacy = grouped ? null : legacyAnswerFields(group, draft);
    answerSending.add(q.id);
    try {
      await api("/__lucid/answer", {
        id: uuid(),
        questionId: q.id,
        text: legacy?.text ?? "",
        ...(grouped ? { items: buildItems(group, draft) } : {}),
        ...(legacy && legacy.options.length > 0 ? { options: legacy.options } : {}),
        ...(anchor ? { anchor } : {}),
        // Several pins send as `anchors`; the server derives `anchor` as the
        // first, same as an annotation's `targets`.
        ...(anchorList.length > 1 ? { anchors: anchorList } : {}),
        ...(images.length > 0 ? { images: toWireImages(images) } : {}),
      });
      // Clear this question's staged answer only after it is recorded.
      for (const img of images) URL.revokeObjectURL(img.url);
      set((st) => clearAnswerState(st, q.id));
    } catch {
      warn("Your answer didn't send - it's kept here, try again.");
    } finally {
      answerSending.delete(q.id);
    }
  };

  /** Decline a question: it leaves the panel and the agent is told the human
   *  skipped it (so it proceeds without an answer rather than re-asking). Any
   *  staged draft/options/anchor/images for it are discarded. */
  const skipQuestion = async (q: AgentQuestion): Promise<void> => {
    if (answerSending.has(q.id)) return;
    answerSending.add(q.id);
    try {
      await api("/__lucid/answer", { id: uuid(), questionId: q.id, text: "", skipped: true });
      // Revoke any already-staged image URLs; a still-in-flight upload sees the
      // cleared counter and revokes its own.
      for (const img of get().answerImages[q.id] ?? []) URL.revokeObjectURL(img.url);
      set((st) => clearAnswerState(st, q.id));
    } catch {
      warn("Couldn't skip that question - try again.");
    } finally {
      answerSending.delete(q.id);
    }
  };

  /** "I don't understand" (#40): clears the question with `unclear: true` so
   *  the agent owes a shorter, plainer version of the SAME question. `note` is
   *  what the human said was confusing - the one thing worth carrying, and a
   *  bare re-ask is allowed (not understanding is the point). */
  const reaskQuestion = async (q: AgentQuestion, note?: string): Promise<void> => {
    if (answerSending.has(q.id)) return;
    answerSending.add(q.id);
    try {
      await api("/__lucid/answer", {
        id: uuid(),
        questionId: q.id,
        text: (note ?? "").trim(),
        unclear: true,
      });
      for (const img of get().answerImages[q.id] ?? []) URL.revokeObjectURL(img.url);
      set((st) => clearAnswerState(st, q.id));
    } catch {
      warn("Couldn't send that back - try again.");
    } finally {
      answerSending.delete(q.id);
    }
  };

  const focusQuestionRef = (ref?: string): void => {
    if (ref) toOverlay({ source: "lucid-chrome", type: "focus-annotation", id: ref });
  };

  /** Scroll the artifact to a section by its `data-lucid-id`. The landing for a
   *  chat section permalink (`lucid:section/<id>`). */
  const revealSection = (lucidId: string): void => {
    toOverlay({ source: "lucid-chrome", type: "reveal-section", lucidId });
  };

  /** Emphasize an update already in view, once per version. The store guard is
   *  synchronous so React's development effect replay cannot restart the same
   *  pulse and make a soft glance read as a persistent animation. */
  const pulseSection = (lucidId: string): void => {
    const seen = get().emphasizedSectionIds;
    if (seen.has(lucidId)) return;
    set({ emphasizedSectionIds: new Set([...seen, lucidId]) });
    toOverlay({ source: "lucid-chrome", type: "pulse-section", lucidId });
  };

  // ---- hover + lightbox -----------------------------------------------------

  /** Mirror a card hover onto the surface mark (and back off with null/""). */
  const setHovered = (id: string | null): void => set({ hoveredId: id });

  /** A thumb asks for the lightbox by URL; resolve it back to the message's
   *  image list so the arrows can step through the set it came from. */
  const openLightboxForSrc = (src: string): void => {
    const file = src.split("/").pop() ?? "";
    const owner = get().messages.find((m) => m.images?.some((i) => i.file === file));
    const images = owner?.images;
    if (!images) return;
    set({ lightboxImages: images, lightboxIndex: images.findIndex((i) => i.file === file) });
  };

  /** Open the lightbox on a known image list (an annotation's own thumbs). */
  const openLightbox = (images: readonly MessageImage[], index: number): void =>
    set({ lightboxImages: images, lightboxIndex: index });

  const closeLightbox = (): void => set({ lightboxImages: null });

  const stepLightbox = (delta: number): void => {
    const s = get();
    const list = s.lightboxImages;
    if (!list || list.length === 0) return;
    set({ lightboxIndex: (((s.lightboxIndex + delta) % list.length) + list.length) % list.length });
  };

  // ---- change view ----------------------------------------------------------

  const enterDiff = async (base?: number): Promise<void> => {
    const diffBase = base ?? get().diffBase;
    if (get().viewingVersion !== null) set({ viewingVersion: null }); // diff and history view are exclusive surfaces
    try {
      const res = await api(`/__lucid/diff?base=${diffBase}`);
      const data = (await res.json()) as DiffData;
      set({ diffData: data, diffBase, diffMode: true, diffIndex: 0 });
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
   * from the diff: this is the whole document as it was at vN, not a
   * comparison. Picking is refused while it is up (the shell guards
   * target-picked) - a snapshot is not the live DOM, so an anchor captured
   * against it would point at nothing on return.
   */
  const viewVersion = async (v: number): Promise<void> => {
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
    // Clear marks and drop out of targeting first: the current annotations do
    // not belong on a historical snapshot, and read mode is what a snapshot is.
    // pushHighlights owns that rule (it reads viewingVersion), so the toggles
    // that stay clickable during history view cannot undo this clear.
    pushHighlights();
    toOverlay({ source: "lucid-chrome", type: "swap", html });
  };

  /** Return the surface to the live current artifact and restore its marks. */
  const exitVersionView = async (): Promise<void> => {
    if (get().viewingVersion === null) return;
    set({ viewingVersion: null });
    const html = await api("/__lucid/artifact")
      .then((r) => r.text())
      .catch(() => null);
    if (html !== null) toOverlay({ source: "lucid-chrome", type: "swap", html });
    pushHighlights();
  };

  const exitDiff = async (): Promise<void> => {
    set({ diffMode: false, revertWhy: "" });
    const html = await api("/__lucid/artifact")
      .then((r) => r.text())
      .catch(() => null);
    if (html !== null) toOverlay({ source: "lucid-chrome", type: "swap", html });
    pushHighlights();
  };

  const gotoHunk = (index: number): void => {
    const hunks = get().diffData?.hunks ?? [];
    if (hunks.length === 0) return;
    const i = ((index % hunks.length) + hunks.length) % hunks.length;
    set({ diffIndex: i });
    const hunk = hunks[i];
    if (hunk) toOverlay({ source: "lucid-chrome", type: "diff-goto", hunkId: hunk.id });
  };

  const setRevertWhy = (why: string): void => set({ revertWhy: why });

  const revertCurrentHunk = async (): Promise<void> => {
    const s = get();
    const hunk = s.diffData?.hunks[s.diffIndex];
    // The RFC wants a revert to be self-justifying (it reaches the agent
    // without the surrounding conversation). That is a requirement on the
    // RECORD, not on the human: an undo is unambiguous without prose, so a
    // blank box gets the plain instruction rather than a disabled button.
    const why = s.revertWhy.trim() || `Undo this change - restore to v${s.diffBase}.`;
    if (!hunk) return;
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

  return {
    addToQueue,
    queueQuickReply,
    forkPending,
    discardPending,
    removePendingTarget,
    setComposerNote,
    addPastedImage,
    removePastedImage,
    removeQueued,
    beginEdit,
    cancelEdit,
    setEditDraft,
    commitEdit,
    sendQueue,
    sendAll,
    enqueueMessage,
    discardOutboxMessage,
    flushOutbox,
    approveReview,
    queueDecision,
    toggleTargets,
    toggleFocusAll,
    toggleFocus,
    reopenReview,
    loadSessions,
    switchToSession,
    updateQuestionDraft,
    dismissQuestionDrawer,
    raiseQuestionDrawer,
    startAnswerPick,
    cancelAnswerPick,
    cancelAllPicks,
    clearAnswerAnchor,
    removeAnswerAnchor,
    addAnswerImage,
    removeAnswerImage,
    submitAnswer,
    skipQuestion,
    reaskQuestion,
    focusQuestionRef,
    pulseSection,
    revealSection,
    setHovered,
    openLightbox,
    openLightboxForSrc,
    closeLightbox,
    stepLightbox,
    enterDiff,
    viewVersion,
    exitVersionView,
    exitDiff,
    gotoHunk,
    setRevertWhy,
    revertCurrentHunk,
  };
};

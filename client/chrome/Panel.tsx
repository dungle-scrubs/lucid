import { useEffect, useRef } from "react";
import {
  addPastedImage,
  addToQueue,
  beginEdit,
  cancelEdit,
  commitEdit,
  discardPending,
  forkPending,
  QUICK_REPLIES,
  queueQuickReply,
  removePastedImage,
  removeQueued,
  sendQueue,
} from "./actions.ts";
import { TargetSnippet } from "./AnnotationPart.tsx";
import { imagesFromPaste, set, useLucid } from "./store.ts";
import type { PastedImage } from "./types.ts";
import { Kbd, KbdGroup } from "./ui/kbd.tsx";

/**
 * The parts of the panel that are not transcript: work staged but not yet in
 * the log. They sit at the end of the record, where the eye already is after a
 * pick.
 */

const btn =
  "cursor-pointer rounded-md border border-ink-600 bg-ink-700 px-2 py-[3px] text-[11px] font-semibold uppercase tracking-[0.05em] text-fg hover:bg-ink-600 disabled:cursor-not-allowed disabled:opacity-40";
const btnPrimary =
  "cursor-pointer rounded-md border border-accent bg-accent px-2 py-[3px] text-[11px] font-semibold uppercase tracking-[0.05em] text-on-accent hover:bg-accent-bright disabled:cursor-not-allowed disabled:opacity-40";
const heading = "mb-2 text-[10px] font-semibold uppercase tracking-[0.8px] text-fg-muted";
/* my-1 on top of the card's 7px gap: the focus ring extends 4px past the
   border on every side (2px outline + 2px offset), which otherwise leaves the
   snippet above and the buttons below visually touching the ring. */
const field =
  "my-1 resize-y rounded-md border border-ink-600 bg-bg-inset p-2 font-sans text-[13px] text-fg placeholder:text-fg-faint focus-visible:annot-outline";

/** Enter submits, Shift+Enter is a newline - the composer's rule everywhere. */
const onSubmitKey = (e: React.KeyboardEvent, action: () => void): void => {
  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
    e.preventDefault();
    action();
  }
};

/** Staged images, before the annotation carrying them is sent. */
const Chips = ({
  images,
  onRemove,
}: {
  readonly images: readonly PastedImage[];
  readonly onRemove?: (id: string) => void;
}) => {
  if (images.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {images.map((img) => (
        <span
          key={img.id}
          data-test="annotation-chip"
          className="inline-flex items-center gap-1.5 rounded-full border border-ink-600 bg-ink-800 py-[3px] pr-[6px] pl-[3px]"
        >
          <img src={img.url} alt="" className="size-[22px] rounded-full object-cover" />
          <span className="max-w-[150px] truncate text-[11px] text-cream-300">{img.name}</span>
          {onRemove ? (
            <button
              type="button"
              title="Remove"
              onClick={() => onRemove(img.id)}
              className="cursor-pointer px-[3px] text-fg-muted hover:text-rust-300"
            >
              ×
            </button>
          ) : null}
        </span>
      ))}
    </div>
  );
};

export const Warnings = () => {
  const warnings = useLucid((s) => s.warnings);
  if (warnings.length === 0) return null;
  return (
    <section>
      <h3 className={heading}>Warnings</h3>
      {warnings.map((w) => (
        <div key={`${w.code}:${w.message}`} className="text-[12px] text-rust-300">
          {w.code}: {w.message}
        </div>
      ))}
    </section>
  );
};

/**
 * A composed-but-unsent annotation, inline in the record at the moment it was
 * written - the same place its sent form will hold (the event carries
 * authoredAt). Client-side until Send; reads the live queue by id so edits
 * re-render without the timeline rebuilding.
 */
export const QueuedCard = ({ id, index }: { readonly id: string; readonly index: number }) => {
  const q = useLucid((s) => s.queue.find((x) => x.id === id));
  const editingId = useLucid((s) => s.editingId);
  const editDraft = useLucid((s) => s.editDraft);
  const sending = useLucid((s) => s.sending);
  const hoveredId = useLucid((s) => s.hoveredId);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const editing = editingId === id;

  // Keyed on the edit state, not mount: the textarea does not exist until the
  // card opens, so an empty dep array would focus nothing, every time.
  useEffect(() => {
    if (!editing) return;
    const box = editRef.current;
    if (!box) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }, [editing]);

  if (!q) return null; // just sent: the located card takes this spot over
  return (
    <section
      data-test="queued-annotation"
      data-annotation-id={q.id}
      aria-label={`Queued annotation ${index}`}
      className={`relative flex flex-col gap-[7px] rounded-lg border border-dashed bg-ink-700 px-[11px] py-[10px] ${
        hoveredId === q.id
          ? "border-accent shadow-[inset_0_0_0_1px_var(--color-accent)]"
          : "border-ink-500"
      }`}
      onMouseEnter={() => {
        set({ hoveredId: q.id });
        window.dispatchEvent(new CustomEvent("lucid:focus-annotation", { detail: q.id }));
      }}
      onMouseLeave={() => {
        set({ hoveredId: null });
        window.dispatchEvent(new CustomEvent("lucid:focus-annotation", { detail: "" }));
      }}
    >
      <span className="absolute -top-px -left-px z-1 flex size-5 items-center justify-center rounded-full border border-dashed border-accent-dim bg-brass-400 text-[11px] font-bold tabular-nums text-on-accent shadow-[0_1px_3px_rgba(0,0,0,0.4)]">
        {index}
      </span>
      <span className="absolute -top-[9px] -right-[9px] z-1 rounded-full bg-ink-600 px-[7px] py-px text-[10px] text-steel-300 shadow-[0_1px_3px_rgba(0,0,0,0.4)]">
        queued
      </span>
      <TargetSnippet target={q.target} />
      <Chips images={q.images} />
      {editing ? (
        <>
          <textarea
            ref={editRef}
            rows={3}
            data-test="edit-note"
            placeholder="Edit this annotation… (Enter to save, Shift+Enter for a new line, Esc to cancel)"
            value={editDraft}
            onChange={(e) => set({ editDraft: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                cancelEdit();
                return;
              }
              onSubmitKey(e, () => commitEdit());
            }}
            className={field}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-test="save-edit"
              disabled={editDraft.trim().length === 0}
              onClick={() => commitEdit()}
              className={`${btnPrimary} flex items-center gap-1.5`}
            >
              Save
              <Kbd className="border-on-accent/30 bg-on-accent/10 text-on-accent">↵</Kbd>
            </button>
            <button
              type="button"
              data-test="cancel-edit"
              onClick={cancelEdit}
              className={`${btn} flex items-center gap-1.5`}
            >
              Cancel
              <Kbd>esc</Kbd>
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="text-fg">{q.note}</div>
          <div className="flex gap-2">
            <button
              type="button"
              data-test="edit-queued"
              disabled={sending}
              onClick={() => beginEdit(q.id)}
              className={btn}
            >
              Edit
            </button>
            <button
              type="button"
              disabled={sending}
              onClick={() => removeQueued(q.id)}
              className={btn}
            >
              Remove
            </button>
          </div>
        </>
      )}
    </section>
  );
};

/** The one queue-wide action. The cards live in the record; the send is a bar
 *  that stays visible above the composer however far the transcript scrolls. */
export const SendQueueBar = () => {
  const queueLen = useLucid((s) => s.queue.length);
  const sending = useLucid((s) => s.sending);
  if (queueLen === 0) return null;
  return (
    <div className="border-t border-ink-600 bg-bg px-[14px] py-2">
      <button
        type="button"
        data-test="send-queue"
        disabled={sending}
        onClick={() => void sendQueue()}
        className={`${btnPrimary} flex w-full items-center justify-center gap-2`}
      >
        <span>
          Send {queueLen} annotation{queueLen > 1 ? "s" : ""}
        </span>
        {/* Keycaps on a filled button borrow the label's own colour: an ink
            keycap would punch a dark hole in the accent fill. */}
        <KbdGroup className="opacity-90">
          <Kbd className="border-on-accent/30 bg-on-accent/10 text-on-accent">⌘</Kbd>
          <Kbd className="border-on-accent/30 bg-on-accent/10 text-on-accent">↵</Kbd>
        </KbdGroup>
      </button>
    </div>
  );
};

/** The in-flight pick: an element chosen on the surface, awaiting its note.
 *  Renders nothing at all when idle - the pick gesture is taught once, by the
 *  empty-thread state, and a permanent placeholder was furniture after that. */
export const PendingComposer = () => {
  const pendingTarget = useLucid((s) => s.pendingTarget);
  const composerNote = useLucid((s) => s.composerNote);
  const pastedImages = useLucid((s) => s.pastedImages);
  const forking = useLucid((s) => s.forking);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (pendingTarget) ref.current?.focus();
  }, [pendingTarget]);

  if (!pendingTarget) return null;
  return (
    <section>
      <h3 className={heading}>New annotation</h3>
      {
        <div className="flex flex-col gap-[7px] rounded-lg border border-ink-600 bg-ink-700 px-[11px] py-[10px]">
          <TargetSnippet target={pendingTarget} />
          <Chips images={pastedImages} onRemove={removePastedImage} />
          <textarea
            ref={ref}
            rows={3}
            data-test="annotation-note"
            disabled={forking}
            placeholder="What should change here? Paste an image to show it. (Enter to queue, Shift+Enter for a new line, Esc to discard)"
            value={composerNote}
            onChange={(e) => set({ composerNote: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                discardPending();
                return;
              }
              onSubmitKey(e, addToQueue);
            }}
            onPaste={(e) => {
              const files = imagesFromPaste(e);
              if (files.length === 0) return; // let a normal text paste through
              e.preventDefault();
              for (const f of files) void addPastedImage(f);
            }}
            className={field}
          />
          {/* One-tap canned notes. Clicking queues that note for this pick, the
              same as typing it and pressing Enter - no textarea detour for the
              asks that recur. */}
          <div className="flex flex-wrap gap-1.5">
            {QUICK_REPLIES.map((r) => (
              <button
                key={r}
                type="button"
                data-test="quick-reply"
                onClick={() => queueQuickReply(r)}
                className="cursor-pointer rounded-full border border-ink-500 bg-ink-800 px-2.5 py-1 text-[11px] text-cream-300 hover:border-accent hover:text-fg"
              >
                {r}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-test="add-to-queue"
              onClick={addToQueue}
              className={`${btnPrimary} flex items-center gap-1.5`}
            >
              Add to queue
              <Kbd className="border-on-accent/30 bg-on-accent/10 text-on-accent">↵</Kbd>
            </button>
            <button type="button" data-test="discard" onClick={discardPending} className={btn}>
              Discard
            </button>
            {/* The one composer action that starts something new instead of
                changing this artifact: spin the selection off into its own
                artifact + session. The note above is the directive. */}
            <button
              type="button"
              data-test="fork"
              onClick={forkPending}
              disabled={forking}
              title="Spin this selection off into a new artifact and agent session"
              className={`${btn} ml-auto disabled:cursor-default disabled:opacity-50`}
            >
              {forking ? "Forking…" : "Fork"}
            </button>
          </div>
        </div>
      }
    </section>
  );
};

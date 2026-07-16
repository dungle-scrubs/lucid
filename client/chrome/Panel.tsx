import { useEffect, useMemo, useRef } from "react";
import {
  addPastedImage,
  addToQueue,
  beginEdit,
  cancelEdit,
  commitEdit,
  discardPending,
  removePastedImage,
  removeQueued,
  sendQueue,
} from "./actions.ts";
import { TargetSnippet } from "./AnnotationPart.tsx";
import { imagesFromPaste, set, useLucid } from "./store.ts";
import type { PastedImage } from "./types.ts";

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

/** Anchors that no longer attach. Listed, never floated at a stale spot. */
export const Orphans = () => {
  // Select the slice, derive after: a selector that filters returns a new array
  // every read, which never compares equal and re-renders forever (React #185).
  const annotations = useLucid((s) => s.annotations);
  const orphans = useMemo(() => annotations.filter((a) => !a.resolved), [annotations]);
  if (orphans.length === 0) return null;
  return (
    <section>
      <h3 className={heading}>Orphaned ({orphans.length})</h3>
      <div className="mt-1.5 flex flex-col gap-4">
        {orphans.map((a) => (
          <div
            key={a.id}
            data-test="orphan"
            className="relative flex flex-col gap-[7px] rounded-lg border border-ink-600 bg-ink-850 px-[11px] py-[10px]"
          >
            <span className="absolute -top-[9px] -right-[9px] z-1 rounded-full bg-rust-500/30 px-[7px] py-px text-[10px] text-rust-300 shadow-[0_1px_3px_rgba(0,0,0,0.4)]">
              orphaned · v{a.version}
            </span>
            <TargetSnippet target={a.target} />
            <div className="text-fg">{a.note}</div>
          </div>
        ))}
      </div>
    </section>
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
      className={`relative flex flex-col gap-[7px] rounded-lg border border-dashed bg-ink-850 px-[11px] py-[10px] ${
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
      <span className="absolute -top-[9px] -right-[9px] z-1 rounded-full bg-ink-700 px-[7px] py-px text-[10px] text-steel-300 shadow-[0_1px_3px_rgba(0,0,0,0.4)]">
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
          <div className="flex gap-2">
            <button
              type="button"
              data-test="save-edit"
              disabled={editDraft.trim().length === 0}
              onClick={() => commitEdit()}
              className={btnPrimary}
            >
              Save
            </button>
            <button type="button" data-test="cancel-edit" onClick={cancelEdit} className={btn}>
              Cancel
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
        className={`${btnPrimary} w-full`}
      >
        Send {queueLen} annotation{queueLen > 1 ? "s" : ""}
      </button>
    </div>
  );
};

/** The in-flight pick: an element chosen on the surface, awaiting its note. */
export const PendingComposer = () => {
  const pendingTarget = useLucid((s) => s.pendingTarget);
  const composerNote = useLucid((s) => s.composerNote);
  const pastedImages = useLucid((s) => s.pastedImages);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (pendingTarget) ref.current?.focus();
  }, [pendingTarget]);

  return (
    <section>
      <h3 className={heading}>New annotation</h3>
      {pendingTarget ? (
        <div className="flex flex-col gap-[7px] rounded-lg border border-ink-600 bg-ink-850 px-[11px] py-[10px]">
          <TargetSnippet target={pendingTarget} />
          <Chips images={pastedImages} onRemove={removePastedImage} />
          <textarea
            ref={ref}
            rows={3}
            data-test="annotation-note"
            placeholder="What should change here? Paste an image to show it. (Enter to queue, Shift+Enter for a new line)"
            value={composerNote}
            onChange={(e) => set({ composerNote: e.target.value })}
            onKeyDown={(e) => onSubmitKey(e, addToQueue)}
            onPaste={(e) => {
              const files = imagesFromPaste(e);
              if (files.length === 0) return; // let a normal text paste through
              e.preventDefault();
              for (const f of files) void addPastedImage(f);
            }}
            className={field}
          />
          <div className="flex gap-2">
            <button
              type="button"
              data-test="add-to-queue"
              onClick={addToQueue}
              className={btnPrimary}
            >
              Add to queue
            </button>
            <button type="button" data-test="discard" onClick={discardPending} className={btn}>
              Discard
            </button>
          </div>
        </div>
      ) : (
        <div className="text-[12px] italic text-fg-faint">
          Click an element or select text in the artifact to annotate it.
        </div>
      )}
    </section>
  );
};

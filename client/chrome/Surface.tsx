import { useEffect } from "react";
import { useActions, useSession, useSessionHandle } from "./context.tsx";
import type { DiffHunk } from "./types.ts";

const HUNK_SIGN: Readonly<Record<DiffHunk["kind"], string>> = {
  added: "+",
  removed: "−",
  changed: "~",
};

const iconBtn =
  "cursor-pointer rounded-md border border-ink-400 bg-ink-800/80 px-1.5 py-px text-[12px] text-fg hover:bg-ink-700";
const select =
  "rounded-md border border-ink-400 bg-ink-800 px-1.5 py-px text-[11px] text-fg focus-visible:annot-outline";

/**
 * A floating pill over the artifact. Shadows mean "this floats"; it is one of
 * the few places that earns one.
 */
export const DiffBar = () => {
  const { enterDiff, exitDiff, gotoHunk, revertCurrentHunk, setRevertWhy } = useActions();
  const diffMode = useSession((s) => s.diffMode);
  const diffData = useSession((s) => s.diffData);
  const diffIndex = useSession((s) => s.diffIndex);
  const diffBase = useSession((s) => s.diffBase);
  const version = useSession((s) => s.version);
  const revertWhy = useSession((s) => s.revertWhy);

  if (!diffMode) return null;
  const hunks = diffData?.hunks ?? [];
  const total = hunks.length;
  const current = hunks[diffIndex];
  const bases = Array.from({ length: Math.max(0, version - 1) }, (_, i) => i + 1);

  return (
    <div
      data-test="diff-bar"
      className="absolute top-3 left-1/2 z-5 flex max-w-[calc(100%-32px)] -translate-x-1/2 flex-wrap items-center gap-3 rounded-lg border border-ink-400 bg-ink-900/95 px-3 py-1.5 text-[11px] text-fg shadow-[0_4px_14px_rgba(0,0,0,0.45)]"
    >
      <span className="flex items-center gap-1.5">
        Changes since
        <select
          value={String(diffBase)}
          onChange={(e) => void enterDiff(Number.parseInt(e.target.value, 10))}
          className={select}
        >
          {bases.map((v) => (
            <option key={v} value={v}>
              v{v}
            </option>
          ))}
        </select>
      </span>
      {total === 0 ? (
        <span className="text-fg-muted">no changes from v{diffBase}</span>
      ) : (
        <>
          <span className="flex items-center gap-1.5">
            <button
              type="button"
              title="Previous change"
              onClick={() => gotoHunk(diffIndex - 1)}
              className={iconBtn}
            >
              ◀
            </button>
            <span data-test="diff-count" className="tabular-nums">
              {diffIndex + 1} / {total}
            </span>
            <button
              type="button"
              title="Next change"
              onClick={() => gotoHunk(diffIndex + 1)}
              className={iconBtn}
            >
              ▶
            </button>
          </span>
          <select
            value={String(diffIndex)}
            onChange={(e) => gotoHunk(Number.parseInt(e.target.value, 10))}
            className={`${select} max-w-[220px]`}
          >
            {hunks.map((h, i) => (
              <option key={h.id} value={i}>
                {HUNK_SIGN[h.kind]} {h.label}
              </option>
            ))}
          </select>
          {current ? (
            <span className="flex items-center gap-1.5">
              <input
                data-test="revert-why"
                placeholder={`revert this to v${diffBase} - why?`}
                value={revertWhy}
                onChange={(e) => setRevertWhy(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void revertCurrentHunk();
                  }
                }}
                className="w-[190px] rounded-md border border-ink-400 bg-bg-inset px-1.5 py-px text-[11px] text-fg placeholder:text-fg-faint focus-visible:annot-outline"
              />
              <button
                type="button"
                data-test="revert"
                disabled={revertWhy.trim().length === 0}
                onClick={() => void revertCurrentHunk()}
                className="cursor-pointer rounded-md border border-rust-500 bg-rust-500/80 px-2 py-px text-[11px] font-semibold text-cream-50 hover:bg-rust-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Revert
              </button>
            </span>
          ) : null}
        </>
      )}
      <button
        type="button"
        data-test="diff-done"
        onClick={() => void exitDiff()}
        className={iconBtn}
      >
        Done
      </button>
    </div>
  );
};

/**
 * The read-only history notice. Viewing a past version swaps the surface to
 * that snapshot; this floats over it so the state is never silent - it says
 * which version is up, that it cannot be annotated, and offers the way back.
 */
export const VersionViewBanner = () => {
  const { exitVersionView } = useActions();
  const viewing = useSession((s) => s.viewingVersion);
  const version = useSession((s) => s.version);
  if (viewing === null) return null;
  return (
    <div
      data-test="version-view"
      className="absolute top-3 left-1/2 z-5 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-amber-500/50 bg-ink-900/95 px-3 py-1.5 text-[11px] text-fg shadow-[0_4px_14px_rgba(0,0,0,0.45)]"
    >
      <span className="flex items-center gap-1.5">
        <span className="size-1.5 rounded-full bg-amber-400" />
        Viewing <span className="font-semibold tabular-nums text-amber-300">v{viewing}</span> ·
        read-only
      </span>
      <button
        type="button"
        data-test="version-view-exit"
        onClick={() => void exitVersionView()}
        className="cursor-pointer rounded-md border border-ink-400 bg-ink-800/80 px-2 py-px text-[11px] text-fg hover:bg-ink-700"
      >
        Back to current v{version}
      </button>
    </div>
  );
};

/**
 * The deferred-swap notice. It names what actually holds the swap, so it never
 * offers a discard for work that discarding cannot touch: the queue is only
 * cleared by sending or removing card by card.
 */
export const NewerVersionBanner = () => {
  const { discardPending } = useActions();
  const newerVersion = useSession((s) => s.newerVersion);
  const queueLen = useSession((s) => s.queue.length);
  const pendingTarget = useSession((s) => s.pendingTarget);
  const composerNote = useSession((s) => s.composerNote);
  if (newerVersion === null) return null;

  const hasComposerDraft = pendingTarget !== null && composerNote.trim().length > 0;
  const queued = `send your ${queueLen} queued annotation${queueLen > 1 ? "s" : ""} to see it`;
  const blocker =
    queueLen > 0 && hasComposerDraft
      ? `${queued}, or discard your draft`
      : queueLen > 0
        ? queued
        : "send or discard your draft";

  return (
    <div
      data-test="newer-version"
      className="absolute top-3 left-1/2 z-5 flex -translate-x-1/2 items-center gap-2 rounded-lg bg-accent px-3.5 py-1.5 text-[12px] font-semibold text-on-accent shadow-[0_4px_14px_rgba(0,0,0,0.3)]"
    >
      Newer version (v{newerVersion}) available · {blocker}
      {hasComposerDraft ? (
        <button
          type="button"
          data-test="discard-draft"
          onClick={discardPending}
          className="cursor-pointer rounded-md bg-ink-900 px-2 py-1 text-cream-50"
        >
          Discard draft
        </button>
      ) : null}
    </div>
  );
};

/**
 * The agent has declared its next output will revise this document. Upper-left
 * of the surface, where reading starts. Declared intent is a promise, not a
 * fact - which is why it only ever says an update is on the way, and the
 * update itself (live reload, version bump) remains the proof.
 */
export const SurfaceUpdating = () => {
  const working = useSession((s) => s.agentWorking);
  const status = useSession((s) => s.status);
  if (working?.intent !== "revise" || status !== "active") return null;
  return (
    <div
      data-test="surface-updating"
      className="absolute top-3 left-3 z-5 flex items-center gap-2 rounded-full border border-ink-400 bg-ink-900/95 py-1 pr-3 pl-2 text-[12px] text-fg shadow-[0_4px_14px_rgba(0,0,0,0.45)]"
    >
      {/* lucide loader-circle */}
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="animate-spin text-accent-bright"
      >
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
      update on the way…
    </div>
  );
};

/** Full-bleed image view. Floats, so it gets a shadow. */
export const Lightbox = () => {
  const { closeLightbox, stepLightbox } = useActions();
  const { transport } = useSessionHandle();
  const images = useSession((s) => s.lightboxImages);
  const index = useSession((s) => s.lightboxIndex);

  const close = closeLightbox;
  const step = stepLightbox;

  useEffect(() => {
    if (!images) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!images || images.length === 0) return null;
  const img = images[index];
  if (!img) return null;
  const multi = images.length > 1;

  return (
    // <dialog> carries the modal role and the backdrop click target without a
    // div pretending to be one. Keys are handled at window level so they work
    // whatever has focus.
    <dialog
      open
      data-test="lightbox"
      aria-label={img.name}
      className="fixed inset-0 z-100 m-0 flex h-full max-h-none w-full max-w-none items-center justify-center border-0 bg-ink-900/90 p-0"
    >
      {/* A real button for the backdrop rather than a click handler on the
          box: clicking outside to dismiss then has a keyboard equivalent. */}
      <button
        type="button"
        aria-label="Close image"
        onClick={close}
        className="absolute inset-0 cursor-zoom-out"
      />
      <button
        type="button"
        title="Close (Esc)"
        onClick={close}
        className="absolute top-4 right-5 cursor-pointer text-[26px] leading-none text-cream-200 hover:text-cream-50"
      >
        ×
      </button>
      {multi ? (
        <button
          type="button"
          data-test="lb-prev"
          title="Previous (←)"
          onClick={() => step(-1)}
          className="absolute left-5 cursor-pointer text-[34px] leading-none text-cream-200 hover:text-cream-50"
        >
          ‹
        </button>
      ) : null}
      <img
        src={transport.assetUrl(img.file)}
        alt={img.name}
        className="max-h-[86vh] max-w-[90vw] rounded-lg bg-white shadow-[0_24px_70px_-20px_rgba(0,0,0,0.8)]"
      />
      {multi ? (
        <button
          type="button"
          data-test="lb-next"
          title="Next (→)"
          onClick={() => step(1)}
          className="absolute right-5 cursor-pointer text-[34px] leading-none text-cream-200 hover:text-cream-50"
        >
          ›
        </button>
      ) : null}
      {multi ? (
        <div
          data-test="lb-counter"
          className="absolute bottom-8 text-[12px] tabular-nums text-cream-200"
        >
          {index + 1} / {images.length}
        </div>
      ) : null}
      <div className="absolute bottom-4 text-[11px] text-fg-muted">{img.name}</div>
    </dialog>
  );
};

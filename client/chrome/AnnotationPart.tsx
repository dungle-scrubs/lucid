import type { DataMessagePartComponent } from "@assistant-ui/react";
import type { Anchor } from "../../src/anchors/anchor.ts";
import { set, useLucid } from "./store.ts";
import type { MessageImage } from "./types.ts";

export interface AnnotationData {
  readonly id: string;
  /** null when the anchor is orphaned: no mark on the surface, so no badge. */
  readonly index: number | null;
  readonly version: number;
  readonly note: string;
  readonly target: Anchor;
  readonly images?: readonly { readonly name: string; readonly file: string }[];
}

/**
 * What the human pointed at, in their terms.
 *
 * An element anchor's snippet is outerHTML, so showing it raw was markup soup
 * truncated mid-tag - it named everything except the thing you clicked. Parse it
 * and keep the visible text: that *is* what was pointed at. The tag name is not
 * shown; "p" or "div" is a fact about the markup, not about the thing.
 *
 * A range is a phrase lifted out of a block, so it keeps its quotes; an element
 * is the block itself and reads as itself.
 */
export const targetText = (target: Anchor): string => {
  const tidy = (s: string): string => s.replace(/\s+/g, " ").trim();
  if (target.kind !== "element") return `“${tidy(target.snippet)}”`;
  try {
    const el = new DOMParser().parseFromString(target.snippet, "text/html").body.firstElementChild;
    return tidy(el?.textContent ?? "") || tidy(target.snippet);
  } catch {
    return tidy(target.snippet);
  }
};

/** The marked-text treatment: a translucent brass wash, no rule - the same
 *  language the surface uses for the mark itself. */
export const TargetSnippet = ({ target }: { readonly target: Anchor }) => {
  const text = targetText(target);
  return (
    // No `title`: the full text as a native tooltip was a wall of run-together
    // prose on anything larger than a phrase, and it fired on every pass of the
    // pointer over the card. The mark on the surface is the real referent - this
    // is a two-line reminder of what was pointed at, not a way to read it.
    <div className="rounded-md bg-brass-400/10 px-2 py-1.5 text-[12px] leading-[1.45] text-cream-200">
      <span className="line-clamp-2">{text}</span>
    </div>
  );
};

const focus = (id: string): void => {
  window.dispatchEvent(new CustomEvent("lucid:focus-annotation", { detail: id }));
};

/**
 * A sent annotation, rendered inline in the transcript where it was sent.
 *
 * The chip and the status pill ride the card's corners rather than sitting in a
 * row, so the card costs one line less and reads as the same numbered item as
 * its mark on the surface - same circle, same straddled corner.
 *
 * An orphan keeps its place in the record and loses only what it no longer has:
 * the number, because the badge it matched is gone. The snippet stays - what was
 * pointed at is still what the note is about.
 */
export const AnnotationPart: DataMessagePartComponent<AnnotationData> = ({ data }) => {
  const hovered = useLucid((s) => s.hoveredId === data.id);
  const images: readonly MessageImage[] = data.images ?? [];
  const orphaned = data.index === null;
  const enter = (): void => {
    set({ hoveredId: data.id });
    focus(data.id);
  };
  const leave = (): void => {
    set({ hoveredId: null });
    focus("");
  };
  return (
    // A labelled <section> rather than a div+role: it carries the region role
    // itself, and focus mirrors hover so the card↔mark link survives for
    // anything that focuses it, not only a pointer.
    <section
      data-test={orphaned ? "orphan" : "annotation"}
      data-annotation-id={data.id}
      aria-label={orphaned ? "Annotation with an orphaned anchor" : `Annotation ${data.index}`}
      // An orphan has no mark to light up, so it takes no hover wiring: the
      // card↔mark link is the only thing these handlers exist for.
      onMouseEnter={orphaned ? undefined : enter}
      onMouseLeave={orphaned ? undefined : leave}
      onFocus={orphaned ? undefined : enter}
      onBlur={orphaned ? undefined : leave}
      className={`relative flex flex-col gap-[7px] rounded-lg border bg-ink-700 px-[11px] py-[10px] focus-visible:annot-outline ${
        hovered ? "border-accent shadow-[inset_0_0_0_1px_var(--color-accent)]" : "border-ink-600"
      }`}
    >
      {orphaned ? null : (
        <span className="absolute -top-px -left-px z-1 flex size-5 items-center justify-center rounded-full bg-accent text-[11px] font-bold tabular-nums text-on-accent shadow-[0_1px_3px_rgba(0,0,0,0.4)]">
          {data.index}
        </span>
      )}
      {/* Straddles the top edge like the number chip, but stays inside the
          card horizontally: hung off the right corner it landed a few px from
          the panel's own border and read as tucked under it, rounded end and
          all. Nothing needs to hang into that gutter. */}
      {orphaned ? (
        <span className="absolute -top-[9px] right-2 z-1 rounded-full bg-rust-500/30 px-[7px] py-px text-[10px] text-rust-300 shadow-[0_1px_3px_rgba(0,0,0,0.4)]">
          Orphaned anchor
        </span>
      ) : (
        <span className="absolute -top-[9px] right-2 z-1 rounded-full bg-sage-600/25 px-[7px] py-px text-[10px] text-sage-300 shadow-[0_1px_3px_rgba(0,0,0,0.4)]">
          located · v{data.version}
        </span>
      )}
      <TargetSnippet target={data.target} />
      <div className="text-fg">{data.note}</div>
      {images.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {images.map((img, i) => (
            <button
              key={img.file}
              type="button"
              data-test="annotation-thumb"
              title={img.name}
              onClick={() => set({ lightboxImages: images, lightboxIndex: i })}
              className="cursor-zoom-in rounded-md focus-visible:annot-outline"
            >
              <img
                src={`/__lucid/asset/${img.file}`}
                alt={img.name}
                className="block h-[66px] w-[88px] rounded-md border border-ink-600 object-cover hover:border-accent"
              />
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
};

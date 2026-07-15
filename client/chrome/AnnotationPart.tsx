import type { DataMessagePartComponent } from "@assistant-ui/react";
import type { Anchor } from "../../src/anchors/anchor.ts";
import { set, useLucid } from "./store.ts";
import type { MessageImage } from "./types.ts";

export interface AnnotationData {
  readonly id: string;
  readonly index: number;
  readonly version: number;
  readonly note: string;
  readonly target: Anchor;
  readonly images?: readonly { readonly name: string; readonly file: string }[];
}

export const targetLabel = (target: Anchor): string =>
  target.kind === "element"
    ? target.snippet.replace(/\s+/g, " ").slice(0, 80)
    : `“${target.snippet.slice(0, 80)}”`;

const focus = (id: string): void => {
  window.dispatchEvent(new CustomEvent("lucid:focus-annotation", { detail: id }));
};

/**
 * A sent annotation, rendered inline in the transcript where it was sent.
 *
 * The chip and the status pill ride the card's corners rather than sitting in a
 * row, so the card costs one line less and reads as the same numbered item as
 * its mark on the surface - same circle, same straddled corner.
 */
export const AnnotationPart: DataMessagePartComponent<AnnotationData> = ({ data }) => {
  const hovered = useLucid((s) => s.hoveredId === data.id);
  const images: readonly MessageImage[] = data.images ?? [];
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
      data-test="annotation"
      data-annotation-id={data.id}
      aria-label={`Annotation ${data.index}`}
      onMouseEnter={enter}
      onMouseLeave={leave}
      onFocus={enter}
      onBlur={leave}
      className={`relative flex flex-col gap-[7px] rounded-lg border bg-ink-850 px-[11px] py-[10px] focus-visible:annot-outline ${
        hovered ? "border-accent shadow-[inset_0_0_0_1px_var(--color-accent)]" : "border-ink-600"
      }`}
    >
      <span className="absolute -top-[9px] -left-[9px] z-1 flex size-5 items-center justify-center rounded-full bg-accent text-[11px] font-bold tabular-nums text-on-accent shadow-[0_1px_3px_rgba(0,0,0,0.4)]">
        {data.index}
      </span>
      <span className="absolute -top-[9px] -right-[9px] z-1 rounded-full bg-sage-600/25 px-[7px] py-px text-[10px] text-sage-300 shadow-[0_1px_3px_rgba(0,0,0,0.4)]">
        located · v{data.version}
      </span>
      <div className="max-h-14 overflow-hidden rounded-[5px] border-l-2 border-accent bg-bg-inset px-[7px] py-[5px] font-mono text-[11px] text-cream-300">
        {targetLabel(data.target)}
      </div>
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

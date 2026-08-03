import type { DataMessagePartComponent } from "@assistant-ui/react";
import type { Anchor } from "../../src/anchors/anchor.ts";
import { TargetSnippet } from "./TargetSnippet.tsx";
import { useActions, useSession, useSessionHandle } from "./context.tsx";
import { DeliveryLabel } from "./Delivery.tsx";
import { FoldedText } from "./FoldedText.tsx";
import type { MessageImage } from "./types.ts";
import { Kbd } from "./ui/kbd.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

export interface AnnotationData {
  readonly id: string;
  /** null when the anchor is orphaned: no mark on the surface, so no badge. */
  readonly index: number | null;
  readonly version: number;
  readonly note: string;
  readonly target: Anchor;
  /** Every spot the note covers when several were cmd-collected; `target` is
   *  always the first (the wire's rule, src/protocol/wire.ts). */
  readonly targets?: readonly Anchor[];
  /** `"low"` when the anchor re-attached only by position (plan 05, M2.2,
   *  #47): the mark sits on whatever occupies that slot now, not provably on
   *  the thing that was pointed at. */
  readonly confidence?: "low";
  readonly images?: readonly { readonly name: string; readonly file: string }[];
}

/** The transient hover light - the mark glows while the pointer (or keyboard
 *  focus) is on the card and goes out when it leaves. Distinct from the card's
 *  Focus link, which pins the mark until something else takes the focus. */
const lightMark = (id: string): void => {
  window.dispatchEvent(new CustomEvent("lucid:focus-annotation", { detail: id }));
};

/** Lighting shows the mark; reveal also scrolls the surface to it. The keyboard
 *  "open": a reader on the card who wants to look at the thing it points at. */
const reveal = (id: string): void => {
  window.dispatchEvent(new CustomEvent("lucid:reveal-annotation", { detail: id }));
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
  const { setHovered, openLightbox, toggleFocus } = useActions();
  const { transport } = useSessionHandle();
  const hovered = useSession((s) => s.hoveredId === data.id);
  // The card's own focus, not the header's all-at-once: with everything lit
  // there is nothing for one card to release, so each still offers to narrow
  // the artifact down to itself.
  const focused = useSession((s) => s.focusedId === data.id);
  const images: readonly MessageImage[] = data.images ?? [];
  const orphaned = data.index === null;
  // Located, but only because something still occupies that slot. Saying
  // "located" here is the lie #47 named: the card claims a match the resolver
  // could not actually make.
  const positional = !orphaned && data.confidence === "low";
  const enter = (): void => {
    setHovered(data.id);
    lightMark(data.id);
  };
  const leave = (): void => {
    setHovered(null);
    lightMark("");
  };
  return (
    // A labelled <section> rather than a div+role: it carries the region role
    // itself, and focus mirrors hover so the card↔mark link survives for
    // anything that focuses it, not only a pointer.
    <section
      data-test={orphaned ? "orphan" : "annotation"}
      data-annotation-id={data.id}
      aria-label={orphaned ? "Annotation with an orphaned anchor" : `Annotation ${data.index}`}
      // An orphan has no mark to light up, so it takes no hover wiring and never
      // enters the tab order: the card↔mark link is the only thing these handlers
      // (and the keyboard reveal) exist for.
      tabIndex={orphaned ? undefined : 0}
      onMouseEnter={orphaned ? undefined : enter}
      onMouseLeave={orphaned ? undefined : leave}
      onFocus={orphaned ? undefined : enter}
      onBlur={orphaned ? undefined : leave}
      onKeyDown={
        orphaned
          ? undefined
          : (e) => {
              // Only the card itself opens its mark - not Enter/Space bubbling
              // up from an inner control (an image thumb opening the lightbox),
              // which this would otherwise hijack. Space would scroll the panel;
              // Enter is the primary gesture.
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                reveal(data.id);
              }
            }
      }
      // mt-3: the located/orphaned badge straddles the top edge, so the card
      // reserves room for it. Without that reserve it sat on the previous
      // item's own footer - two labels colliding across a card boundary.
      className={`group relative mt-3 flex flex-col gap-[7px] border bg-ink-700 px-[11px] py-[10px] focus-visible:annot-outline ${
        hovered ? "border-accent shadow-[inset_0_0_0_1px_var(--color-accent)]" : "border-ink-600"
      }`}
    >
      {orphaned ? null : (
        // leading-none + pt-px is optical centring, the pair the overlay's
        // badge also carries: centring the line box leaves a descender-less
        // digit sitting high in the circle, and pinning the leading keeps the
        // correction from depending on whatever line-height it inherits.
        <span className="absolute -top-px -left-px z-1 flex size-5 -translate-x-[33%] -translate-y-[33%] items-center justify-center rounded-full bg-accent pt-px text-[11px] leading-none font-bold tabular-nums text-on-accent shadow-[0_1px_3px_rgba(0,0,0,0.4)]">
          {data.index}
        </span>
      )}
      {/* Straddles the top edge like the number chip, but stays inside the
          card horizontally: hung off the right corner it landed a few px from
          the panel's own border and read as tucked under it, end and
          all. Nothing needs to hang into that gutter. */}
      {orphaned ? (
        <span className="absolute bottom-full right-2 mb-px z-1 bg-rust-500/30 px-[7px] py-px text-[10px] text-rust-300 shadow-[0_1px_3px_rgba(0,0,0,0.4)]">
          Orphaned anchor
        </span>
      ) : positional ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                data-test="positional-anchor"
                className="absolute bottom-full right-2 mb-px z-1 bg-brass-500/25 px-[7px] py-px text-[10px] text-brass-300 shadow-[0_1px_3px_rgba(0,0,0,0.4)]"
              >
                positional · v{data.version}
              </span>
            }
          />
          <TooltipContent>
            Matched by position only - no id or unique fingerprint. The mark may be on whatever took
            that spot rather than what was pointed at.
          </TooltipContent>
        </Tooltip>
      ) : (
        <span className="absolute bottom-full right-2 mb-px z-1 bg-sage-600/25 px-[7px] py-px text-[10px] text-sage-300 shadow-[0_1px_3px_rgba(0,0,0,0.4)]">
          located · v{data.version}
        </span>
      )}
      {/* Only on keyboard focus: a pointer user is already at the mark, and a
          per-card hint on every read would be furniture. */}
      <span className="pointer-events-none absolute bottom-full left-1/2 mb-px hidden -translate-x-1/2 items-center gap-1 border border-ink-500 bg-ink-800 px-2 py-px text-[10px] text-fg-muted shadow-[0_1px_3px_rgba(0,0,0,0.4)] group-focus-visible:flex">
        <Kbd>↵</Kbd> reveal
      </span>
      {/* Every spot the note covers, first (the numbered one) to last. */}
      {(data.targets ?? [data.target]).map((t: Anchor, i: number) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: anchors have no id and a sent annotation's list never reorders.
        <TargetSnippet key={i} target={t} />
      ))}
      {/* Verbatim like a message turn - an expanded paste in a note comes
          back from the log as its full self, so a wall of it folds. */}
      <div className="text-fg">
        <FoldedText text={data.note} />
      </div>
      {images.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {images.map((img, i) => (
            <Tooltip key={img.file}>
              <TooltipTrigger
                render={
                  <button
                    key={img.file}
                    type="button"
                    data-test="annotation-thumb"
                    onClick={() => openLightbox(images, i)}
                    className="cursor-zoom-in focus-visible:annot-outline"
                  >
                    <img
                      src={transport.assetUrl(img.file)}
                      alt={img.name}
                      className="block h-[66px] w-[88px] border border-ink-600 object-cover hover:border-accent"
                    />
                  </button>
                }
              />
              <TooltipContent>{img.name}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      ) : null}
      {/* Bottom row: the focus link on the left, delivery on the right - the
          last thing read on the card is where it got to. Sent marks are quiet
          by default (delivered feedback's markup is noise on the artifact),
          so this link is how one mark comes back: focusing also scrolls the
          surface to it, and releases whatever was focused before. Hovering the
          card lights it briefly either way. An orphan has no mark to focus, so
          it keeps the delivery label alone. */}
      {orphaned ? (
        <DeliveryLabel className="self-end" />
      ) : (
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            data-test="toggle-focus"
            aria-pressed={focused}
            onClick={() => toggleFocus(data.id)}
            className={`cursor-pointer text-[11px] underline underline-offset-2 hover:text-accent-bright ${
              focused
                ? "text-accent-bright decoration-accent/60"
                : "text-steel-300 decoration-steel-500/60"
            }`}
          >
            {focused ? "Unfocus" : "Focus"}
          </button>
          <DeliveryLabel />
        </div>
      )}
    </section>
  );
};

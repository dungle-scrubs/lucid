/**
 * The chrome's dismiss control, in two sizes. Every × in the UI is one of
 * these: they were hand-rolled per site and drifted down to 3px of padding
 * around an inherited glyph - a hit target smaller than the pointer, and a
 * mark too faint to read as a control at all.
 *
 * Both are real square buttons with a hover plate, so they look pressable
 * before they are hovered and are comfortably clickable at any density.
 */

/** Panel and dialog dismissal - 24px, the standard control size. */
export const closeButton =
  "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-[16px] leading-none text-fg-faint hover:bg-ink-700 hover:text-fg focus-visible:annot-outline";

/** Removal INSIDE a row (a chip, a queued card, a tab): 20px, so it sits in
 *  a line of 12-13px text without setting the row's height. */
export const closeButtonSmall =
  "flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-[14px] leading-none text-fg-faint hover:bg-ink-700 hover:text-fg focus-visible:annot-outline";

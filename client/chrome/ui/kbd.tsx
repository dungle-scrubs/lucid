import type { ComponentProps } from "react";
import { cn } from "./utils.ts";

/**
 * Vendored from shadcn/ui (`shadcn add kbd`). A keycap has no Base UI or Radix
 * primitive behind it - it is a styled `<kbd>` - so the component is identical
 * across shadcn registries and this is the whole of it, kept diffable against
 * upstream per AGENTS.md.
 *
 * The one Lucid change is the skin. Upstream's `bg-muted text-muted-foreground`
 * bridges to Lucid's darkest ink on steel type (styles.css), which vanishes on
 * the ink-700/800 grounds these hints actually sit on. A keycap has to read as a
 * raised key, so it borrows the panel's own button language instead: an ink-600
 * rule over ink-800, steel glyphs. `pointer-events-none` and `select-none` keep
 * it a label, never a target.
 */
export const Kbd = ({ className, ...props }: ComponentProps<"kbd">) => (
  <kbd
    data-slot="kbd"
    className={cn(
      "pointer-events-none inline-flex h-[18px] w-fit min-w-[18px] select-none items-center justify-center gap-0.5 border border-ink-600 bg-ink-800 px-1 font-sans text-[10px] font-medium tracking-normal text-fg-muted [&_svg:not([class*='size-'])]:size-3",
      className,
    )}
    {...props}
  />
);

/** A run of keycaps read as one chord: `⌘` `⇧` `↵`. The gap is tighter than
 *  free-standing caps so the group holds together as a single shortcut. */
export const KbdGroup = ({ className, ...props }: ComponentProps<"div">) => (
  <div
    data-slot="kbd-group"
    className={cn("inline-flex items-center gap-0.5", className)}
    {...props}
  />
);

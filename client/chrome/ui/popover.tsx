import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { cn } from "./utils.ts";

/**
 * Vendored from shadcn/ui (Base UI variant), the base-nova `popover` registry
 * item (AGENTS.md). shadcn is open code, not a dependency: this copy is ours
 * to edit, and it inherits Lucid's palette through the `@theme inline` shadcn
 * variable bridge in styles.css rather than carrying a second theme. Kept close
 * to upstream so a later `shadcn add` stays diffable.
 *
 * Edits vs upstream:
 *  - Dark only, like tooltip.tsx / context-menu.tsx: Lucid's chrome has one
 *    theme, so the shadcn light tokens (`bg-popover`) are replaced by the
 *    ink/cream ramps the rest of the chrome uses.
 *  - `PopoverPositioner` is exported directly (not folded into Content) so the
 *    Copy Popover can pass a `VirtualElement` to its `anchor` prop and position
 *    against the selection-release point with no real trigger element (spike
 *    A-001: Base UI's `anchor` accepts a `VirtualElement`).
 *
 * Base UI names the parts Root/Trigger/Portal/Positioner/Popup/Close; shadcn
 * re-exports them under the familiar Popover* names.
 */

const Popover = (props: PopoverPrimitive.Root.Props) => (
  <PopoverPrimitive.Root data-slot="popover" {...props} />
);

const PopoverTrigger = PopoverPrimitive.Trigger;

/** The positioning layer. `anchor` is the load-bearing prop here: pass a
 *  `VirtualElement` (`{ getBoundingClientRect }`) to position at a coordinate
 *  with no trigger element (the Copy Popover anchors at the selection-release
 *  point). Defaults to the trigger otherwise. */
const PopoverPositioner = ({ className, ...props }: PopoverPrimitive.Positioner.Props) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Positioner
      data-slot="popover-positioner"
      className={cn("z-100 outline-none", className)}
      {...props}
    />
  </PopoverPrimitive.Portal>
);

const PopoverContent = ({ className, children, ...props }: PopoverPrimitive.Popup.Props) => (
  <PopoverPrimitive.Popup
    data-slot="popover-content"
    className={cn(
      "border border-ink-500 bg-ink-800 p-1 text-fg shadow-[0_10px_30px_-10px_rgba(0,0,0,0.7)] outline-none",
      className,
    )}
    {...props}
  >
    {children}
  </PopoverPrimitive.Popup>
);

const PopoverClose = PopoverPrimitive.Close;

export { Popover, PopoverClose, PopoverContent, PopoverPositioner, PopoverTrigger };

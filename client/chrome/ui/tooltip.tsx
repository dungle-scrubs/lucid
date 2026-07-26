import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { cn } from "./utils.ts";

/**
 * Vendored from shadcn/ui (Base UI variant), `shadcn add tooltip -b base`
 * against the base-nova registry (AGENTS.md). shadcn is open code, not a
 * dependency: this copy is ours to edit.
 *
 * Replaces the browser's `title` attribute everywhere in the chrome. A native
 * tooltip is drawn by the OS in the OS's own light palette and system font -
 * a white box in the middle of a dark panel - and it cannot be styled, timed,
 * or wrapped. This one is the panel's own: ink ground, cream text, square
 * corners, mono at the chrome's caption size.
 *
 * Dark only, deliberately: Lucid's chrome has one theme, and the shadcn
 * light-mode tokens (`bg-popover`) would resolve to a second palette.
 *
 * Base UI names the parts Provider/Root/Trigger/Portal/Positioner/Popup;
 * shadcn re-exports them under the familiar Tooltip* names.
 */

/** Wraps the app once. `delay` is the hover dwell before the first tooltip
 *  opens; once one is open, moving to another shows it immediately. */
const TooltipProvider = ({ delay = 400, ...props }: TooltipPrimitive.Provider.Props) => (
  <TooltipPrimitive.Provider delay={delay} {...props} />
);

const Tooltip = TooltipPrimitive.Root;

/**
 * The element the tooltip describes. Base UI merges into a child element via
 * `render`, so a trigger adds no wrapper box to the layout:
 *
 *     <Tooltip>
 *       <TooltipTrigger render={<button type="button">…</button>} />
 *       <TooltipContent>why this button exists</TooltipContent>
 *     </Tooltip>
 */
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = ({
  className,
  children,
  sideOffset = 6,
  side = "top",
  ...props
}: TooltipPrimitive.Popup.Props & {
  readonly sideOffset?: number;
  readonly side?: TooltipPrimitive.Positioner.Props["side"];
}) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Positioner className="z-100 outline-none" side={side} sideOffset={sideOffset}>
      <TooltipPrimitive.Popup
        data-slot="tooltip-content"
        className={cn(
          // max-w + wrap: these carry a sentence or two of explanation, and a
          // single long line would run off the panel it belongs to.
          "max-w-[280px] border border-ink-500 bg-ink-700 px-2 py-1 text-[11px] leading-snug text-cream-200 shadow-[0_10px_30px_-10px_rgba(0,0,0,0.7)] outline-none",
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Popup>
    </TooltipPrimitive.Positioner>
  </TooltipPrimitive.Portal>
);

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };

import { Select as SelectPrimitive } from "@base-ui/react/select";
import { cn } from "./utils.ts";

/**
 * Vendored from shadcn/ui (Base UI variant), `shadcn add select -b base` against
 * the base-nova registry (AGENTS.md). shadcn is open code, not a dependency:
 * this copy is ours to edit, and it reads Lucid's ramps through the shadcn
 * variable bridge in styles.css rather than carrying a second palette. Kept
 * close to upstream so a later `shadcn add` stays diffable.
 *
 * Trimmed to the parts the version picker uses (no groups, scroll arrows, or
 * separate value slot); add them back from upstream if a later caller needs
 * them. Icons are inlined Lucide per the repo's icon rule.
 *
 * Base UI names the parts Root/Trigger/Value/Positioner/Popup/Item; shadcn
 * re-exports them under the familiar Select* names, which is what we use.
 */

const Select = SelectPrimitive.Root;
const SelectValue = SelectPrimitive.Value;

const SelectTrigger = ({ className, children, ...props }: SelectPrimitive.Trigger.Props) => (
  <SelectPrimitive.Trigger
    data-slot="select-trigger"
    className={cn(
      "flex w-fit cursor-pointer items-center justify-between gap-1 border border-ink-400 bg-ink-700 px-[9px] py-px text-[11px] tabular-nums text-steel-300 outline-none hover:border-accent-bright hover:text-fg focus-visible:annot-outline data-[popup-open]:border-accent-bright data-[popup-open]:text-fg [&_svg]:pointer-events-none [&_svg]:shrink-0",
      className,
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon className="text-fg-muted">
      {/* lucide chevron-down */}
      <svg
        viewBox="0 0 24 24"
        width="12"
        height="12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
);

const SelectContent = ({ className, children, ...props }: SelectPrimitive.Popup.Props) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Positioner
      data-slot="select-positioner"
      className="z-100 outline-none"
      sideOffset={4}
      alignItemWithTrigger={false}
    >
      <SelectPrimitive.Popup
        data-slot="select-content"
        className={cn(
          "max-h-[min(24rem,var(--available-height))] min-w-[var(--anchor-width)] overflow-y-auto overscroll-contain border border-ink-500 bg-ink-800 p-1 text-fg shadow-[0_10px_30px_-10px_rgba(0,0,0,0.7)] outline-none",
          className,
        )}
        {...props}
      >
        {children}
      </SelectPrimitive.Popup>
    </SelectPrimitive.Positioner>
  </SelectPrimitive.Portal>
);

const SelectItem = ({ className, children, ...props }: SelectPrimitive.Item.Props) => (
  <SelectPrimitive.Item
    data-slot="select-item"
    className={cn(
      "relative flex w-full cursor-pointer select-none items-center gap-2 py-1 pr-2 pl-7 text-[12px] tabular-nums outline-none data-[highlighted]:bg-ink-600 data-[highlighted]:text-fg-strong",
      className,
    )}
    {...props}
  >
    <SelectPrimitive.ItemIndicator className="absolute left-2 flex items-center text-accent-bright">
      {/* lucide check */}
      <svg
        viewBox="0 0 24 24"
        width="12"
        height="12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M20 6 9 17l-5-5" />
      </svg>
    </SelectPrimitive.ItemIndicator>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
);

export { Select, SelectTrigger, SelectValue, SelectContent, SelectItem };

import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { cn } from "./utils.ts";

/**
 * Vendored from shadcn/ui (Base UI variant), basecn's `context-menu` registry
 * item (AGENTS.md). shadcn is open code, not a dependency: this copy is ours
 * to edit, and it reads Lucid's ramps through the shadcn variable bridge in
 * styles.css rather than carrying a second palette. Kept close to upstream so
 * a later `shadcn add` stays diffable.
 *
 * Trimmed to the parts the tab menu uses (no submenus, checkboxes, radio
 * groups, labels, or shortcuts); add them back from upstream if a later
 * caller needs them. Square corners and the chrome's ink/cream ramps replace
 * upstream's rounded popover tokens, matching select.tsx and tooltip.tsx.
 *
 * Base UI names the parts Root/Trigger/Portal/Positioner/Popup/Item; shadcn
 * re-exports them under the familiar ContextMenu* names, which is what we use.
 */

const ContextMenu = (props: ContextMenuPrimitive.Root.Props) => (
  <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />
);

/** Right-click surface. Base UI merges into the child via `render`, so the
 *  trigger adds no wrapper box to the layout - same idiom as TooltipTrigger. */
const ContextMenuTrigger = (props: ContextMenuPrimitive.Trigger.Props) => (
  <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />
);

const ContextMenuContent = ({
  className,
  children,
  ...props
}: ContextMenuPrimitive.Popup.Props) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.Positioner
      data-slot="context-menu-positioner"
      className="z-100 outline-none"
    >
      <ContextMenuPrimitive.Popup
        data-slot="context-menu-content"
        className={cn(
          "min-w-[160px] border border-ink-500 bg-ink-800 p-1 text-fg shadow-[0_10px_30px_-10px_rgba(0,0,0,0.7)] outline-none",
          className,
        )}
        {...props}
      >
        {children}
      </ContextMenuPrimitive.Popup>
    </ContextMenuPrimitive.Positioner>
  </ContextMenuPrimitive.Portal>
);

const ContextMenuItem = ({ className, ...props }: ContextMenuPrimitive.Item.Props) => (
  <ContextMenuPrimitive.Item
    data-slot="context-menu-item"
    className={cn(
      "flex w-full cursor-pointer select-none items-center gap-2 px-2 py-1 text-[12px] outline-none data-[highlighted]:bg-ink-600 data-[highlighted]:text-fg-strong",
      className,
    )}
    {...props}
  />
);

const ContextMenuSeparator = ({ className, ...props }: ContextMenuPrimitive.Separator.Props) => (
  <ContextMenuPrimitive.Separator
    data-slot="context-menu-separator"
    className={cn("-mx-1 my-1 h-px bg-ink-600", className)}
    {...props}
  />
);

export {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
};

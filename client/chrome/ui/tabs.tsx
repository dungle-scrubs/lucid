import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./utils.ts";

/**
 * Vendored from shadcn/ui (Base UI variant), `shadcn add tabs` against the
 * base-nova registry. shadcn is an open-code registry, not a dependency: the
 * copy is ours to edit, and it reads Lucid's ramps through the shadcn variable
 * bridge in styles.css rather than carrying a second palette.
 *
 * Otherwise kept close to upstream so it stays diffable against a future
 * `shadcn add`. Upstream's `dark:` variants are inlined rather than dropped:
 * they could never fire here - Lucid is dark by its ramps, not by a `dark`
 * class - but they are not dead weight. Upstream's light-mode active chip is
 * `bg-background` (white on a grey track), which inverts on a dark ground:
 * background is the DARKEST ink, so the chip sank into the track instead of
 * rising out of it. Upstream corrects for that behind `dark:`; so do we, with
 * Lucid's ramps. The active chip is the one thing that rises.
 *
 * Base UI names the parts Root/List/Tab/Panel; shadcn re-exports them under the
 * familiar Tabs/TabsList/TabsTrigger/TabsContent names, which is what we use.
 * Note Panel unmounts when hidden unless `keepMounted` is set.
 */

const Tabs = ({ className, orientation = "horizontal", ...props }: TabsPrimitive.Root.Props) => (
  <TabsPrimitive.Root
    data-slot="tabs"
    data-orientation={orientation}
    className={cn("group/tabs flex gap-2 data-horizontal:flex-col", className)}
    {...props}
  />
);

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center p-[3px] text-muted-foreground group-data-horizontal/tabs:h-8 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

const TabsList = ({
  className,
  variant = "default",
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) => (
  <TabsPrimitive.List
    data-slot="tabs-list"
    data-variant={variant}
    className={cn(tabsListVariants({ variant }), className)}
    {...props}
  />
);

const TabsTrigger = ({ className, ...props }: TabsPrimitive.Tab.Props) => (
  <TabsPrimitive.Tab
    data-slot="tabs-trigger"
    className={cn(
      // cursor-pointer is ours: Tailwind v4's preflight resets buttons to
      // cursor:default and upstream never overrides it, so a tab reads as
      // inert text without this.
      "relative inline-flex h-[calc(100%-1px)] flex-1 cursor-pointer items-center justify-center gap-1.5 border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-fg-muted transition-all hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 group-data-[variant=default]/tabs-list:data-active:shadow-sm group-data-[variant=line]/tabs-list:data-active:shadow-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
      "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent",
      // Upstream's `dark:` correction, inlined: the chip rises off the track on
      // ink-600 with a lit top edge, and its label goes to full cream.
      "data-active:border-border-strong data-active:bg-ink-600 data-active:text-fg-strong",
      "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-horizontal/tabs:after:bottom-[-5px] group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-vertical/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
      className,
    )}
    {...props}
  />
);

const TabsContent = ({ className, ...props }: TabsPrimitive.Panel.Props) => (
  <TabsPrimitive.Panel
    data-slot="tabs-content"
    className={cn("flex-1 text-sm outline-none", className)}
    {...props}
  />
);

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants };

import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";

/**
 * Vendored from shadcn/ui (Base UI variant), `shadcn add collapsible -b base`
 * against the base-nova registry (AGENTS.md). Upstream is an unstyled
 * passthrough - Root/Trigger/Panel stamped with data-slot names - so this is
 * the whole of it; callers style the parts. Base UI marks the trigger with
 * `data-panel-open` while open, which is what label swaps key off.
 */

export const Collapsible = (props: CollapsiblePrimitive.Root.Props) => (
  <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />
);

export const CollapsibleTrigger = (props: CollapsiblePrimitive.Trigger.Props) => (
  <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" {...props} />
);

export const CollapsibleContent = (props: CollapsiblePrimitive.Panel.Props) => (
  <CollapsiblePrimitive.Panel data-slot="collapsible-content" {...props} />
);

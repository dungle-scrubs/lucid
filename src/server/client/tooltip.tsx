import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as React from "react";

// shadcn/ui Tooltip, styled with the application's existing theme tokens.
const Content = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(function TooltipContent(props, ref) {
  const { className, sideOffset = 8, ...rest } = props;
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        collisionPadding={12}
        className={["rich-tooltip", className].filter(Boolean).join(" ")}
        {...rest}
      />
    </TooltipPrimitive.Portal>
  );
});

export const Tooltip = {
  Content,
  Provider: TooltipPrimitive.Provider,
  Root: TooltipPrimitive.Root,
  Trigger: TooltipPrimitive.Trigger,
};

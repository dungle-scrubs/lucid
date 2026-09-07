import * as Popover from "@radix-ui/react-popover";
import type { ReactNode } from "react";

/** Editors escape the dock so their actions remain reachable on a small screen. */
export function SettingsPopover(props: {
  readonly label: string;
  readonly children: ReactNode;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Popover.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Popover.Trigger className="settings-trigger" title={props.label}>
        {props.label}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="settings-popover"
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={16}
          aria-label={props.label}
        >
          {props.children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

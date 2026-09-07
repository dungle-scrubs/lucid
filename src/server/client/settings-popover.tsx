import * as Popover from "@radix-ui/react-popover";
import type { ReactNode } from "react";

/** Editors escape the dock so their actions remain reachable on a small screen. */
export function SettingsPopover(props: {
  readonly label: string;
  readonly trigger?: ReactNode;
  readonly triggerClassName?: string;
  readonly className?: string;
  readonly side?: "top" | "bottom";
  readonly children: ReactNode;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Popover.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Popover.Trigger
        className={props.triggerClassName ?? "settings-trigger"}
        title={props.label}
        aria-label={props.label}
      >
        {props.trigger ?? props.label}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={`settings-popover ${props.className ?? ""}`}
          side={props.side ?? "top"}
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

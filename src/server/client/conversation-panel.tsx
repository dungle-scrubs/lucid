import * as React from "react";
import { initialConversationPanel } from "../view-options.js";
import { SidebarSimpleDuotone } from "./icons.js";

export const useConversationPanel = (search: string) => {
  const [open, setOpen] = React.useState(() => initialConversationPanel(search));
  const id = React.useId();
  const label = open ? "Hide conversation" : "Show conversation";
  const control = (
    <button
      aria-controls={id}
      aria-expanded={open}
      aria-label={label}
      className="v conversation-toggle"
      onClick={(event) => {
        // Safari pointer activation need not focus a button before its panel becomes inert.
        event.currentTarget.focus();
        setOpen((value) => !value);
      }}
      title={label}
      type="button"
    >
      <SidebarSimpleDuotone size={18} />
    </button>
  );
  return {
    control,
    open,
    panelProps: {
      "aria-hidden": !open,
      "aria-label": "Conversation",
      id,
      inert: open ? undefined : "",
    },
  };
};

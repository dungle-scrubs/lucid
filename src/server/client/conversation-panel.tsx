import * as React from "react";
import { initialConversationPanel } from "../view-options.js";
import { SidebarSimpleDuotone } from "./icons.js";

const STORAGE_KEY = "lucid:conversation-panel";

const restoreConversationPanel = (search: string, key: string): boolean | undefined => {
  try {
    const saved = window.sessionStorage.getItem(key);
    if (saved === "open" || saved === "closed") return saved === "open";
  } catch {
    // Storage can be unavailable. The URL still supplies the initial state.
  }
  return new URLSearchParams(search).has("conversation-panel")
    ? initialConversationPanel(search)
    : undefined;
};

const saveConversationPanel = (key: string, open: boolean): void => {
  try {
    window.sessionStorage.setItem(key, open ? "open" : "closed");
  } catch {
    // A blocked storage API must not prevent opening or closing the panel.
  }
};

export const useConversationPanel = (search: string, defaultOpen = false, viewId = "") => {
  const key = viewId ? `${STORAGE_KEY}:${viewId}` : STORAGE_KEY;
  const [choice, setOpen] = React.useState(() => restoreConversationPanel(search, key));
  const open = choice ?? defaultOpen;
  const id = React.useId();
  const toggle = React.useRef<HTMLButtonElement>(null);
  // Set by `show`: what takes focus once the panel is no longer inert.
  const focusOnOpen = React.useRef<(() => HTMLElement | null) | null>(null);
  React.useEffect(() => {
    const target = focusOnOpen.current;
    if (!open || !target) return;
    focusOnOpen.current = null;
    (target() ?? toggle.current)?.focus();
  }, [open]);
  const label = open ? "Hide chat" : "Show chat";
  const control = (
    <button
      aria-controls={id}
      aria-expanded={open}
      aria-label={label}
      className="conversation-toggle"
      ref={toggle}
      onClick={(event) => {
        // Safari pointer activation need not focus a button before its panel becomes inert.
        event.currentTarget.focus();
        saveConversationPanel(key, !open);
        setOpen(!open);
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
    /** Open the panel from another control and move focus into it, to
     * `focus()`'s element or, when that is missing, the panel toggle. */
    show: (focus: () => HTMLElement | null): void => {
      // Already open: no state change follows, so focus now rather than
      // leaving a request for some later, unrelated open.
      if (open) {
        (focus() ?? toggle.current)?.focus();
        return;
      }
      focusOnOpen.current = focus;
      saveConversationPanel(key, true);
      setOpen(true);
    },
    panelProps: {
      "aria-hidden": !open,
      "aria-label": "Chat",
      id,
      inert: open ? undefined : "",
    },
  };
};

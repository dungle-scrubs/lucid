import { useMessage } from "@assistant-ui/react";
import type { DeliveryState } from "./types.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

/**
 * Per-item delivery state (D20): every piece of sent feedback says where it
 * got to, so "does the agent actually see this?" is answered by the panel
 * before it is asked.
 *
 * Deliberately quiet - 10px, faint, no color. It is a fact about the item,
 * not attention: the loud channels (the working indicator, the listener line,
 * the tab attention dot) already exist and mean something else.
 */

const TITLE: Record<DeliveryState, string> = {
  recorded: "In the log. No agent has taken delivery yet.",
  delivered: "An agent acknowledged the batch this was in.",
  answered: "The agent produced something after this.",
};

/** The strongest state the payload's flags support. Both absent means the
 *  item is in the log and nothing has happened to it yet. */
export const deliveryState = (item: {
  readonly delivered?: true;
  readonly answered?: true;
}): DeliveryState => (item.answered ? "answered" : item.delivered ? "delivered" : "recorded");

/**
 * Reads the state off the message's own metadata (set in convertMessage), so
 * an annotation card and a message bubble render the same label from the same
 * source. Renders nothing for items that have no delivery story - an agent's
 * turn, or a queued item that is not in the log yet.
 */
export const DeliveryLabel = ({ className }: { readonly className?: string }) => {
  const state = useMessage((m) => m.metadata.custom?.delivery);
  // Narrowed rather than cast: metadata.custom is an open bag, and the label
  // must not render whatever else ever lands in it.
  if (state !== "recorded" && state !== "delivered" && state !== "answered") return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-test="delivery-state"
            data-state={state}
            className={`text-[10px] leading-none text-fg-faint ${className ?? ""}`}
          >
            {state}
          </span>
        }
      />
      <TooltipContent>{TITLE[state]}</TooltipContent>
    </Tooltip>
  );
};

import { useQuery } from "@tanstack/react-query";
import type * as React from "react";
import type { BrowserConnection, ConnectionStatus } from "../../protocol/connection-status.js";
import { nativeConnectionQueryKey } from "./native-input-controls.js";
import { Tooltip } from "./tooltip.js";

type Tone = "ok" | "busy" | "warn";

/** A short header label for each connection state, and how urgent it is.
 * The full message and the recovery steps stay in the chat card. */
export const connectionSummary = (state: ConnectionStatus["state"]): [string, Tone] => {
  switch (state) {
    case "listening":
    case "hold-connected":
      return ["Session connected", "ok"];
    case "headless-starting":
    case "headless-running":
      return ["Agent replying", "busy"];
    case "headless-fallback":
      return ["Headless replies", "ok"];
    case "cleanup":
    case "hold-detaching":
      return ["Disconnecting", "busy"];
    case "closed":
      return ["Session closed", "warn"];
    case "setup-required":
    case "not-listening":
    case "owner-unknown":
    case "reconnect-waiting":
      return ["Not connected", "warn"];
    case "owner-conflict":
    case "delivery-uncertain":
    case "outcome-unknown":
    case "launch-uncertain":
    case "resume-failed":
      return ["Connection needs attention", "warn"];
  }
};

/**
 * The native connection's status in the header while chat is closed.
 *
 * The full connection card lives at the top of chat. With chat closed it
 * used to float over the document's lower right and cover its text. The
 * header has reserved room beside the theme and chat controls, so the
 * status sits there as one labelled button: the tooltip carries the
 * current message, and pressing it opens chat at the card. It shares the
 * card's query key, so it adds no request.
 */
export function HeaderConnection(props: {
  readonly conversationId: string;
  readonly enabled: boolean;
  readonly onOpen: () => void;
  readonly request: (signal: AbortSignal) => Promise<Response>;
}): React.ReactElement | null {
  const { conversationId, enabled, onOpen, request } = props;
  const result = useQuery({
    enabled,
    gcTime: 0,
    queryFn: async ({ signal }): Promise<BrowserConnection> => {
      const response = await request(signal);
      if (!response.ok) throw new Error("Connection status is unavailable. Check detection again.");
      return response.json();
    },
    queryKey: nativeConnectionQueryKey(conversationId),
    refetchInterval: 2000,
    refetchIntervalInBackground: false,
    retry: false,
    staleTime: 0,
  });
  const connection = result.data;
  if (!enabled || !connection?.nativeConnectionRequired) return null;
  const [label, tone]: [string, Tone] = result.isError
    ? ["Connection unknown", "warn"]
    : connectionSummary(connection.state);
  const message = result.isError
    ? "Current connection could not be checked. Saved feedback is unchanged."
    : connection.message;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          className="header-connection"
          data-tone={tone}
          aria-label={`${label}. Open chat for connection details`}
          onClick={onOpen}
        >
          <span className="header-connection-dot" aria-hidden="true" />
          <span className="header-connection-label">{label}</span>
        </button>
      </Tooltip.Trigger>
      <Tooltip.Content className="header-connection-help" align="end">
        <p>{message}</p>
        <p>Open chat to check the connection or follow its recovery steps.</p>
      </Tooltip.Content>
    </Tooltip.Root>
  );
}

import { useQuery } from "@tanstack/react-query";
import type * as React from "react";
import type { BrowserConnection } from "../../protocol/connection-status.js";
import { nativeConnectionQueryKey } from "./native-input-controls.js";
import { Button } from "./ui/button.js";

/**
 * The connection card's one-line stand-in for the closed-chat corner.
 *
 * `NativeConnection` mounts inside hidden chat and only fetches while the
 * panel is open, so with chat closed its status - "Current connection",
 * the session identity, the retry control - is unreachable. This reads the
 * same query under the same key, so whichever mounts first fetches and the
 * other shares: no second endpoint, no second poll. It renders only while
 * the record is native-owned; otherwise it is nothing.
 *
 * Compact on purpose: the message, the session identity, and the one
 * action that matters (retry detection, or re-check). Instructions and
 * details stay in chat, one toggle away.
 */
export function ClosedChatConnection(props: {
  readonly conversationId: string;
  readonly enabled: boolean;
  readonly request: (signal: AbortSignal) => Promise<Response>;
}): React.ReactElement | null {
  const { conversationId, enabled, request } = props;
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
  const unavailable = result.isError;
  const message = unavailable
    ? "Current connection could not be checked. Saved feedback is unchanged."
    : (connection?.message ?? "Checking the native connection…");
  const retry = !unavailable && connection.actions.includes("retry-detection");
  return (
    <section className="floating-connection" aria-label="Current native connection">
      <p className="floating-connection-head">Current connection</p>
      <p className="floating-connection-message">{message}</p>
      <p className="floating-connection-identity">
        {connection.nativeSessionId ? (
          <>
            Native session <code>{connection.nativeSessionId}</code>
          </>
        ) : (
          "Native session identity is not verified yet."
        )}
      </p>
      <Button
        aria-disabled={!enabled || result.isFetching}
        onClick={() => {
          if (enabled && !result.isFetching) void result.refetch();
        }}
        variant="outline"
      >
        {retry ? "Retry session detection" : "Check connection status"}
      </Button>
    </section>
  );
}

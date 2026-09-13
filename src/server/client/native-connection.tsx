import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import type { BrowserConnection } from "../../protocol/connection-status.js";
import { Button } from "./ui/button.js";

interface NativeConnectionProps {
  readonly conversationId: string;
  readonly enabled: boolean;
  readonly request: (signal: AbortSignal) => Promise<Response>;
}

export function NativeConnection(props: NativeConnectionProps) {
  const { conversationId, enabled, request } = props;
  const result = useQuery({
    enabled,
    gcTime: 0,
    queryFn: async ({ signal }): Promise<BrowserConnection> => {
      const response = await request(signal);
      if (!response.ok) throw new Error("Connection status is unavailable. Check detection again.");
      return response.json();
    },
    queryKey: ["native-connection", conversationId],
    refetchInterval: 2000,
    refetchIntervalInBackground: false,
    retry: false,
    staleTime: 0,
  });
  const connection = result.data;
  const unavailable = !enabled || result.isError;
  const message = unavailable
    ? "Current connection could not be checked. Saved feedback is unchanged."
    : (connection?.message ?? "Checking the native connection…");
  const [announcement, setAnnouncement] = React.useState("");
  // Populate the mounted live region only when its message changes, never on timestamp polls.
  React.useEffect(() => {
    setAnnouncement(connection?.nativeConnectionRequired ? message : "");
  }, [connection?.nativeConnectionRequired, message]);
  // A native publication can need setup before its session identity is known.
  if (!connection?.nativeConnectionRequired) return null;
  return (
    <section className="native-connection" aria-label="Current native connection">
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      <h3>Current connection</h3>
      <p>{message}</p>
      <p className="native-connection-identity">
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
        {!unavailable && connection.actions.includes("retry-detection")
          ? "Retry session detection"
          : "Check connection status"}
      </Button>
      <details>
        <summary>Connection instructions</summary>
        <p>
          Checking status only reads current ownership. It does not send feedback or start a
          session.
        </p>
        {unavailable ? (
          <p>Refresh connection status before following recovery instructions.</p>
        ) : (
          connection.instructions.map((instruction) => (
            <div key={instruction.action}>
              <h4>{instruction.label}</h4>
              <p>{instruction.text}</p>
              {instruction.command && <pre>{instruction.command}</pre>}
            </div>
          ))
        )}
      </details>
      <details>
        <summary>Connection details</summary>
        <dl>
          <dt>Lucid conversation</dt>
          <dd>
            <code>{connection.conversationId}</code>
          </dd>
          <dt>Native interface</dt>
          <dd>{connection.interface ?? "Unverified"}</dd>
          <dt>Last observed</dt>
          <dd>
            <time dateTime={new Date(connection.observedAt).toISOString()}>
              {new Date(connection.observedAt).toLocaleTimeString()}
            </time>
          </dd>
          {connection.reason && (
            <>
              <dt>Reason</dt>
              <dd>{connection.reason}</dd>
            </>
          )}
        </dl>
        <p>Saved response preferences in Settings do not establish a live connection.</p>
      </details>
    </section>
  );
}

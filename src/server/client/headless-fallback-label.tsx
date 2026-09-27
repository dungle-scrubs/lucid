import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import type { BrowserConnection } from "../../protocol/connection-status.js";
import { NativeInputControlsContext, nativeConnectionQueryKey } from "./native-input-controls.js";
import { Tooltip } from "./tooltip.js";

/**
 * Says who answers when the publishing session cannot (RFC 34). It reads the
 * connection query that `NativeConnection` polls under the same key, so it
 * adds no request. Renders only for a `headless-fallback` record.
 */
export function HeadlessFallbackLabel(): React.ReactElement | null {
  const controls = React.useContext(NativeInputControlsContext);
  const { data } = useQuery<BrowserConnection>({
    enabled: false,
    queryKey: nativeConnectionQueryKey(controls?.conversationId ?? ""),
  });
  if (data?.state !== "headless-fallback") return null;
  const preference = data.savedPreference;
  const driver = preference
    ? [preference.harness, preference.provider, preference.model].filter(Boolean).join(" / ")
    : "the saved settings";
  return (
    <p className="headless-fallback">
      <span>Replies come from a new headless {driver} session.</span>
      <Tooltip.Root>
        <Tooltip.Trigger
          className="headless-fallback-trigger"
          aria-label="Why replies come from a new headless session"
        >
          ?
        </Tooltip.Trigger>
        <Tooltip.Content className="headless-fallback-help" align="end">
          <p>
            The session that published this document has no Lucid integration, so Lucid cannot send
            your notes back into it.
          </p>
          <p>
            Lucid starts a new session with the same settings instead. It sees the document and your
            notes, not the earlier conversation. Change the model in Settings.
          </p>
        </Tooltip.Content>
      </Tooltip.Root>
    </p>
  );
}

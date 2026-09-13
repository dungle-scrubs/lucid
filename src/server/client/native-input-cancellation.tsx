import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import type { NativeInputDelivery } from "../../protocol/connection-status.js";
import { NativeInputControlsContext, nativeConnectionQueryKey } from "./native-input-controls.js";
import { Button } from "./ui/button.js";

type CancellationResult =
  | { readonly kind: "cancelled"; readonly message: string }
  | { readonly kind: "refused" | "unconfirmed"; readonly message: string };

const CANCELLED_MESSAGE =
  "Message cancelled before dispatch. Its text remains in this conversation.";

export function NativeInputCancellation(props: { readonly delivery: NativeInputDelivery }) {
  const { delivery } = props;
  const controls = React.useContext(NativeInputControlsContext);
  const wasEligible = React.useRef(false);
  const eligible = delivery.actions.includes("cancel-unsent-input");
  React.useEffect(() => {
    if (eligible) wasEligible.current = true;
  }, [eligible]);
  if (!controls || (!eligible && !wasEligible.current)) return null;
  return <Cancellation delivery={delivery} controls={controls} />;
}

function Cancellation(props: {
  readonly controls: NonNullable<React.ContextType<typeof NativeInputControlsContext>>;
  readonly delivery: NativeInputDelivery;
}) {
  const { controls, delivery } = props;
  const client = useQueryClient();
  const pending = React.useRef(false);
  const mutation = useMutation({
    mutationFn: async (): Promise<CancellationResult> => {
      try {
        const response = await controls.cancel(delivery.inputId);
        const value: unknown = await response.json();
        if (
          value &&
          typeof value === "object" &&
          "status" in value &&
          value.status === "cancelled" &&
          "inputId" in value &&
          value.inputId === delivery.inputId &&
          response.ok
        )
          return {
            kind: "cancelled",
            message: CANCELLED_MESSAGE,
          };
        if (
          response.status >= 400 &&
          response.status < 500 &&
          value &&
          typeof value === "object" &&
          "reason" in value &&
          typeof value.reason === "string"
        )
          return { kind: "refused", message: value.reason };
      } catch {
        // A lost response does not establish whether cancellation was recorded.
      }
      return {
        kind: "unconfirmed",
        message: "Cancellation was not confirmed. Check status or retry this cancellation.",
      };
    },
    onSettled: (result) => {
      pending.current = false;
      if (result) controls.announce(result.message);
      void client.invalidateQueries({
        queryKey: nativeConnectionQueryKey(controls.conversationId),
      });
    },
    retry: false,
  });
  const canCancel = delivery.actions.includes("cancel-unsent-input");
  const cancelled = delivery.state === "cancelled" || mutation.data?.kind === "cancelled";
  const announce = controls.announce;
  const recordedCancellation = delivery.state === "cancelled";
  const unconfirmed = mutation.data?.kind === "unconfirmed";
  React.useEffect(() => {
    if (recordedCancellation && unconfirmed) announce(CANCELLED_MESSAGE);
  }, [announce, recordedCancellation, unconfirmed]);
  const unavailable = !controls.enabled || !canCancel || cancelled || mutation.isPending;
  return (
    <div>
      <p>Cancel only before dispatch. This does not stop an active response.</p>
      <Button
        type="button"
        aria-disabled={unavailable}
        variant="outline"
        onClick={() => {
          if (unavailable || pending.current) return;
          pending.current = true;
          mutation.mutate();
        }}
      >
        {cancelled
          ? "Cancelled"
          : mutation.isPending
            ? "Cancelling…"
            : !canCancel
              ? "Cancellation unavailable"
              : mutation.data?.kind === "unconfirmed"
                ? "Retry cancellation"
                : "Cancel unsent message"}
      </Button>
      {mutation.data && !cancelled ? <p>{mutation.data.message}</p> : null}
      {mutation.data?.kind === "unconfirmed" && !cancelled ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            controls.announce("Checking cancellation status. Saved feedback is unchanged.");
            void client.invalidateQueries({
              queryKey: nativeConnectionQueryKey(controls.conversationId),
            });
          }}
        >
          Check status
        </Button>
      ) : null}
    </div>
  );
}

import type { NativeInputDelivery as Delivery } from "../../protocol/connection-status.js";

export function NativeInputDelivery(props: { readonly delivery: Delivery | undefined }) {
  const { delivery } = props;
  if (!delivery) return null;
  const label =
    delivery.state === "finished"
      ? delivery.outcome?.kind === "question"
        ? "Question received"
        : delivery.outcome?.kind === "refusal"
          ? "Response refused"
          : delivery.outcome?.kind === "failure"
            ? "Response failed"
            : delivery.outcome === null
              ? "Response ended"
              : "Response finished"
      : {
          saved: "Saved",
          sending: "Sending",
          received: "Received",
          "delivery-uncertain": "Delivery uncertain",
          cancelled: "Cancelled",
          "not-started": "Not started",
        }[delivery.state];
  return (
    <details className="native-input-delivery" data-input-id={delivery.inputId}>
      <summary aria-label={`Message delivery: ${label}`}>{label}</summary>
      <p>{delivery.message}</p>
    </details>
  );
}

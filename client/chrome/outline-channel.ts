import { isOutlineChannelBootstrap } from "../shared/protocol.ts";
import type { OutlinePort } from "./artifact-outline-session.ts";

export type OutlinePortDisposition = "handled" | "unowned";
type PortAcceptor = (source: MessageEventSource, port: OutlinePort) => OutlinePortDisposition;

const MAX_PENDING_PORTS = 16;
const PENDING_PORT_TTL_MS = 5_000;
interface PendingPort {
  readonly port: MessagePort;
  readonly timeout: ReturnType<typeof setTimeout>;
}

const pending = new Map<object, PendingPort>();
const acceptors = new Set<PortAcceptor>();

const discardPending = (source: object): boolean => {
  const entry = pending.get(source);
  if (entry === undefined) return false;
  pending.delete(source);
  clearTimeout(entry.timeout);
  entry.port.close();
  return true;
};

const offer = (source: MessageEventSource, port: MessagePort): void => {
  for (const accept of acceptors) {
    if (accept(source, port) === "handled") return;
  }
  if (typeof source !== "object" || source === null) {
    port.close();
    return;
  }
  const existing = pending.get(source);
  if (existing !== undefined) {
    port.close();
    return;
  }
  while (pending.size >= MAX_PENDING_PORTS) {
    const oldest = pending.keys().next().value as object | undefined;
    if (oldest === undefined) break;
    discardPending(oldest);
  }
  const timeout = setTimeout(() => discardPending(source), PENDING_PORT_TTL_MS);
  pending.set(source, { port, timeout });
};

if (typeof window !== "undefined") {
  // Module evaluation happens before React creates the iframe. Capturing here
  // prevents the pre-artifact one-shot transfer from racing a component effect.
  window.addEventListener("message", (event) => {
    if (
      !isOutlineChannelBootstrap(event.data) ||
      event.source === null ||
      event.ports.length !== 1 ||
      event.ports[0] === undefined
    ) {
      return;
    }
    offer(event.source, event.ports[0]);
  });
}

export const subscribeOutlineChannels = (accept: PortAcceptor): (() => void) => {
  acceptors.add(accept);
  return () => acceptors.delete(accept);
};

export const claimPendingOutlineChannel = (
  source: MessageEventSource | null,
  accept: PortAcceptor,
): boolean => {
  if (typeof source !== "object" || source === null) return false;
  const port = pending.get(source);
  if (port === undefined) return false;
  pending.delete(source);
  clearTimeout(port.timeout);
  if (accept(source, port.port) === "handled") return true;
  port.port.close();
  return false;
};

export const discardPendingOutlineChannel = (source: MessageEventSource | null): boolean =>
  typeof source === "object" && source !== null ? discardPending(source) : false;

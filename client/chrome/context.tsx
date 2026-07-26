import { createContext, useContext, type ReactNode } from "react";
import { useStore } from "zustand";
import type { SessionActions } from "./actions.ts";
import type { SessionHandle } from "./session.ts";
import type { SessionState } from "./store.ts";

/**
 * The React face of a SessionHandle. Components under a provider read and
 * mutate ONE session without knowing which - the same component tree renders
 * whichever session is active, and everything session-scoped flows through
 * these hooks instead of module imports.
 */

const SessionContext = createContext<SessionHandle | null>(null);

export const SessionProvider = ({
  session,
  children,
}: {
  readonly session: SessionHandle;
  readonly children: ReactNode;
}) => <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;

export const useSessionHandle = (): SessionHandle => {
  const handle = useContext(SessionContext);
  if (!handle) throw new Error("lucid: useSessionHandle outside a SessionProvider");
  return handle;
};

/** Subscribe to a slice of the active session's state (the old `useLucid`). */
export const useSession = <T,>(selector: (state: SessionState) => T): T =>
  useStore(useSessionHandle().store, selector);

/** The active session's mutations. */
export const useActions = (): SessionActions => useSessionHandle().actions;

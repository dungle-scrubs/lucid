import * as React from "react";

interface ControlAnnouncement {
  readonly id: string;
  readonly message: string;
}

interface NativeInputControls {
  readonly announce: (message: string) => void;
  readonly announcement: ControlAnnouncement | null;
  readonly cancel: (inputId: string) => Promise<Response>;
  readonly conversationId: string;
  readonly enabled: boolean;
}

export function nativeConnectionQueryKey(conversationId: string) {
  return ["native-connection", conversationId] as const;
}

export const NativeInputControlsContext = React.createContext<NativeInputControls | null>(null);

export function NativeInputControlsProvider(props: {
  readonly cancel: NativeInputControls["cancel"];
  readonly children: React.ReactNode;
  readonly conversationId: string;
  readonly enabled: boolean;
}) {
  const { cancel, children, conversationId, enabled } = props;
  const [announcement, setAnnouncement] = React.useState<ControlAnnouncement | null>(null);
  const announce = React.useCallback((message: string) => {
    setAnnouncement({ id: crypto.randomUUID(), message });
  }, []);
  const value = React.useMemo(
    () => ({ announce, announcement, cancel, conversationId, enabled }),
    [announce, announcement, cancel, conversationId, enabled],
  );
  return (
    <NativeInputControlsContext.Provider value={value}>
      {children}
    </NativeInputControlsContext.Provider>
  );
}

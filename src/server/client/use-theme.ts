import { useSyncExternalStore } from "react";
import { getBrowserTheme } from "./browser-theme.js";

const subscribe = (listener: () => void) => getBrowserTheme().subscribe(listener);
const read = () => getBrowserTheme().read();
const serverState = { appearance: "light", persisted: true, preference: "system" } as const;
export const useTheme = () => useSyncExternalStore(subscribe, read, () => serverState);

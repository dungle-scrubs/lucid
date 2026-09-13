import type { NativeInterface } from "./connection.js";
import type { DriverPreference } from "./driver-settings.js";

export interface ConnectionStatus {
  readonly message: string;
  readonly reason: string | null;
  readonly state:
    | "setup-required"
    | "listening"
    | "not-listening"
    | "owner-unknown"
    | "owner-conflict"
    | "delivery-uncertain"
    | "outcome-unknown"
    | "launch-uncertain"
    | "headless-starting"
    | "headless-running"
    | "cleanup"
    | "reconnect-waiting"
    | "resume-failed"
    | "closed";
}

export type ConnectionAction =
  | "reconnect-instructions"
  | "resume-listening-instructions"
  | "retry-detection"
  | "setup-instructions";

export interface ConnectionProjection extends ConnectionStatus {
  readonly actions: readonly ConnectionAction[];
  readonly conversationId: string;
  readonly interface: NativeInterface | null;
  readonly nativeSessionId: string | null;
  readonly observedAt: number;
  readonly savedPreference: DriverPreference | null;
}

export interface ConnectionInstruction {
  readonly action: ConnectionAction;
  readonly command: string | null;
  readonly label: string;
  readonly text: string;
}

export interface BrowserConnection extends ConnectionProjection {
  readonly instructions: readonly ConnectionInstruction[];
}

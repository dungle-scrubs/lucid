import { spawn } from "node:child_process";

/** A parent-lifetime channel survives stdin completion. Its closure means the worker
 * died; this process still owns the harness process group and can reap it. */
export async function superviseHcn(argv: readonly string[]): Promise<void> {
  const [binary, ...args] = argv;
  if (!binary) throw new Error("A harness command is required");
  if (!process.connected) throw new Error("A supervisor requires its parent IPC channel");
  const connected = await new Promise<boolean>((resolve) => {
    process.once("message", () => resolve(true));
    process.once("disconnect", () => resolve(false));
  });
  if (!connected) return;
  const child = spawn(binary, args, { detached: true, stdio: "inherit" });
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  const signalGroup = (signal: NodeJS.Signals): void => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause;
    }
  };
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    signalGroup("SIGTERM");
    escalation = setTimeout(() => signalGroup("SIGKILL"), 250);
  };
  process.once("disconnect", stop);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    process.exitCode = await new Promise<number>((resolve) => {
      child.once("error", () => resolve(1));
      child.once("exit", (code) => {
        // A completed hcn must not leave descendants holding output or work.
        signalGroup("SIGKILL");
        resolve(code ?? 1);
      });
    });
  } finally {
    clearTimeout(escalation);
    process.off("disconnect", stop);
    if (process.connected) process.disconnect?.();
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}

/** Read stdin fully as utf8 — the single place hook CLIs do it. */
export const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

/** Emit the hook's stderr + exit(0) contract (non-destructive). */
export const exitHook = (result: {
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
}): never => {
  if (!result.ok) {
    process.stderr.write(`${result.code ?? "hook-error"}: ${result.message ?? ""}\n`);
  }
  process.exit(0);
};

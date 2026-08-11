/**
 * CLI frame mapping: the pure subcommand -> protocol intent translation.
 *
 * This is the entry-point / orchestration seam: parsing `argv` into a
 * structured command that the process-orchestration layer (`run`, `send`,
 * `watch`) then executes. Keeping it pure (no I/O, no lock, no spawn)
 * makes it testable in isolation and mirrors `src/tui/view.ts`'s own
 * pure projection. What it is NOT: it does not perform the append,
 * hold a lock, or decide liveness - those belong to the transaction
 * and the presence module.
 */

export type MappedCommand =
  | { readonly kind: "send"; readonly conversationId: string; readonly text: string }
  | { readonly kind: "watch"; readonly conversationId: string }
  | { readonly kind: "run"; readonly conversationId: string | undefined }
  | { readonly kind: "announce" }
  | { readonly kind: "inject" }
  | { readonly kind: "help"; readonly message: string };

/** Map `argv` (without the `lucid` binary prefix) to a structured command.
 * Pure, no I/O. The `send` input is a transient `input` append folded by
 * the NEXT `lucid run` (not delivered live, D-011). */
export const mapSubcommand = (argv: readonly string[]): MappedCommand => {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "send": {
      const conversationId = rest[0];
      if (!conversationId)
        return { kind: "help", message: "usage: lucid send <conversation> <text>" };
      const text = rest.slice(1).join(" ");
      if (!text) return { kind: "help", message: "usage: lucid send <conversation> <text>" };
      return { kind: "send", conversationId, text };
    }
    case "watch": {
      const conversationId = rest[0];
      if (!conversationId) return { kind: "help", message: "usage: lucid watch <conversation>" };
      return { kind: "watch", conversationId };
    }
    case "run": {
      const conversationId = rest[0];
      return { kind: "run", conversationId };
    }
    case "announce":
      return { kind: "announce" };
    case "inject":
      return { kind: "inject" };
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return {
        kind: "help",
        message: "usage: lucid <send|watch|run|announce|inject> [...]",
      };
    default:
      return { kind: "help", message: `unknown command: ${cmd}` };
  }
};

import type { ConversationPanelVisibility } from "../server/view-options.js";
import { validConversationId } from "../store/errors.js";

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
  | {
      readonly kind: "run";
      readonly conversationId: string | undefined;
      readonly harnessName?: string;
    }
  | {
      readonly kind: "chat";
      readonly conversationId: string | undefined;
      readonly harnessName?: string;
    }
  | { readonly kind: "announce" }
  | { readonly kind: "inject" }
  | {
      readonly kind: "serve";
      readonly conversationId: string;
      readonly conversationPanel: ConversationPanelVisibility | undefined;
    }
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
        return { kind: "help", message: "usage: lucid2 send <conversation> <text>" };
      const text = rest.slice(1).join(" ");
      if (!text) return { kind: "help", message: "usage: lucid2 send <conversation> <text>" };
      return { kind: "send", conversationId, text };
    }
    case "watch": {
      const conversationId = rest[0];
      if (!conversationId) return { kind: "help", message: "usage: lucid2 watch <conversation>" };
      return { kind: "watch", conversationId };
    }
    case "run": {
      let harnessName: string | undefined;
      const positionals: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i] as string;
        if (arg === "--harness" || arg === "--harness-name") {
          harnessName = rest[i + 1];
          if (!harnessName)
            return {
              kind: "help",
              message: "usage: lucid2 run [conversation] [--harness <claude|codex|pi|muse>]",
            };
          i++;
        } else if (arg.startsWith("--")) {
          return { kind: "help", message: `unknown flag for run: ${arg}` };
        } else {
          positionals.push(arg);
        }
      }
      const conversationId = positionals[0];
      return harnessName === undefined
        ? { kind: "run", conversationId }
        : { kind: "run", conversationId, harnessName };
    }
    case "chat": {
      let harnessName: string | undefined;
      const positionals: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i] as string;
        if (arg === "--harness" || arg === "--harness-name") {
          harnessName = rest[i + 1];
          if (!harnessName)
            return {
              kind: "help",
              message: "usage: lucid2 chat [conversation] [--harness <claude|codex|pi|muse>]",
            };
          i++;
        } else if (arg.startsWith("--")) {
          return { kind: "help", message: `unknown flag for chat: ${arg}` };
        } else {
          positionals.push(arg);
        }
      }
      const conversationId = positionals[0];
      return harnessName === undefined
        ? { kind: "chat", conversationId }
        : { kind: "chat", conversationId, harnessName };
    }
    case "announce":
      return { kind: "announce" };
    case "inject":
      return { kind: "inject" };
    case "serve": {
      const usage =
        "usage: lucid2 serve [conversation] [--conversation-panel <open|closed>]\nConversation defaults to demo; the panel defaults to closed.\nExamples: lucid2 serve demo --conversation-panel open\n          lucid2 serve demo --conversation-panel closed";
      const invalid = (message: string): MappedCommand => ({
        kind: "help",
        message: `${message}\n${usage}`,
      });
      let conversationId: string | undefined;
      let conversationPanel: ConversationPanelVisibility | undefined;
      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i] as string;
        if (arg === "--help" || arg === "-h") return { kind: "help", message: usage };
        if (arg === "--conversation-panel") {
          if (conversationPanel !== undefined)
            return invalid("Repeated --conversation-panel option");
          const value = rest[++i];
          if (value !== "open" && value !== "closed")
            return invalid("--conversation-panel requires open or closed");
          conversationPanel = value;
        } else if (arg.startsWith("-")) return invalid(`Unknown serve option: ${arg}`);
        else if (conversationId !== undefined)
          return invalid(`Unexpected conversation argument: ${arg}`);
        else if (!validConversationId(arg)) return invalid(`Invalid conversation name: ${arg}`);
        else conversationId = arg;
      }
      return { kind: "serve", conversationId: conversationId ?? "demo", conversationPanel };
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return {
        kind: "help",
        message: "usage: lucid2 <send|watch|run|chat|serve|announce|inject> [...]",
      };
    default:
      return { kind: "help", message: `unknown command: ${cmd}` };
  }
};

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
  | { readonly kind: "hcn-supervisor"; readonly argv: readonly string[] }
  | {
      readonly kind: "context";
      readonly path: string;
      readonly offset: number;
      readonly bytes: number;
      readonly json: boolean;
    }
  | { readonly kind: "name-titles"; readonly root: string }
  | {
      readonly kind: "managed-worker";
      readonly root: string;
      readonly conversationId: string;
      readonly inputId: string;
    }
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
      readonly conversationId?: string;
      readonly conversationPanel?: ConversationPanelVisibility;
    }
  | { readonly kind: "help"; readonly message: string };

/** Map `argv` (without the `lucid` binary prefix) to a structured command.
 * Pure, no I/O. The `send` input is a transient `input` append folded by
 * the NEXT `lucid run` (not delivered live, D-011). */
export const mapSubcommand = (argv: readonly string[]): MappedCommand => {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "context": {
      const help = {
        kind: "help",
        message:
          "usage: lucid2 context <offered-directory> [--offset BYTE] [--bytes COUNT] [--json]\nRead a bounded slice of offered conversation context. Reports nextOffset and done.",
      } as const;
      const path = rest[0];
      if (!path || path.startsWith("--")) return help;
      let offset = 0;
      let bytes = 65_536;
      let json = false;
      const used = new Set<string>();
      for (let index = 1; index < rest.length; index++) {
        const flag = rest[index];
        if (!flag || used.has(flag)) return help;
        used.add(flag);
        if (flag === "--json") {
          json = true;
          continue;
        }
        const value = rest[++index];
        if (
          (flag !== "--offset" && flag !== "--bytes") ||
          value === undefined ||
          !/^\d+$/.test(value)
        )
          return help;
        const number = Number(value);
        if (!Number.isSafeInteger(number)) return help;
        if (flag === "--offset") offset = number;
        else bytes = number;
      }
      return { kind: "context", path, offset, bytes, json };
    }
    case "_name-titles":
      return rest.length === 1 && rest[0]
        ? { kind: "name-titles", root: rest[0] }
        : { kind: "help", message: "A record root is required" };
    case "_hcn-supervise":
      return rest.length > 0
        ? { kind: "hcn-supervisor", argv: rest }
        : { kind: "help", message: "A harness command is required" };
    case "_managed-worker":
      return rest.length === 3 && rest[0] && rest[1] && rest[2]
        ? { kind: "managed-worker", root: rest[0], conversationId: rest[1], inputId: rest[2] }
        : { kind: "help", message: "A record root, conversation, and accepted input are required" };
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
      if (rest.length === 0) return { kind: "serve" };
      const usage =
        "usage: lucid2 serve [conversation] [--conversation-panel <open|closed>]\nWithout arguments, open the hub. A panel option without a conversation selects demo; the panel defaults to closed.\nExamples: lucid2 serve demo --conversation-panel open\n          lucid2 serve demo --conversation-panel closed";
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
        message: "usage: lucid2 <send|watch|run|chat|serve|announce|inject|context> [...]",
      };
    default:
      return { kind: "help", message: `unknown command: ${cmd}` };
  }
};

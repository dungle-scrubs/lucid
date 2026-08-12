#!/usr/bin/env bun

/**
 * `lucid` CLI entry point (M2.1-M2.4).
 *
 * Dispatches `lucid <subcommand>` via the pure `mapSubcommand` seam.
 * Hook commands use exec-form argument arrays, never interpolated shell
 * strings. `HERDR_ENV` is unset for the child (D-025).
 */

import { renderLines } from "../tui/render.js";
import { mapSubcommand } from "./mapping.js";

const run = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const mapped = mapSubcommand(argv);

  switch (mapped.kind) {
    case "send": {
      const { sendInput } = await import("./send.js");
      const rootDir = process.env.LUCID_ROOT;
      sendInput(mapped.conversationId, { rootDir, text: mapped.text });
      console.log(`sent to ${mapped.conversationId}`);
      break;
    }
    case "watch": {
      const { watchConversation } = await import("./watch.js");
      const rootDir = process.env.LUCID_ROOT;
      const ac = new AbortController();
      process.on("SIGINT", () => ac.abort());
      process.on("SIGTERM", () => ac.abort());
      await watchConversation(mapped.conversationId, {
        rootDir,
        onView: (view) => {
          console.clear();
          for (const line of renderLines(view)) console.log(line);
        },
        signal: ac.signal,
      });
      break;
    }
    case "run": {
      const { runConversation } = await import("./run.js");
      const rootDir = process.env.LUCID_ROOT;
      await runConversation({
        rootDir,
        conversationId: mapped.conversationId,
        harnessName: mapped.harnessName,
      });
      break;
    }
    case "announce": {
      const { runAnnounce } = await import("./hooks/announce.js");
      await runAnnounce();
      break;
    }
    case "inject": {
      const { runInject } = await import("./hooks/inject.js");
      await runInject();
      break;
    }
    case "help":
      console.log(mapped.message);
      break;
  }
};

run().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

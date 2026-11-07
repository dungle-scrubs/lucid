/**
 * Runs before every test file (bunfig.toml `[test] preload`).
 *
 * The suite is deterministic by contract, and part of it spawns the pinned
 * hcn for inspection. hcn reads the user's `$XDG_CONFIG_HOME/hcn/config.json`
 * and refuses a key it does not know, so a config written for a newer hcn
 * made the pinned one answer "config error" and emptied every served
 * harness list. Pointing XDG at a fresh, empty directory keeps a person's
 * own configuration out of the oracle. Lucid's own user config reads the
 * same variable, so it is isolated by the same line.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "lucid-test-xdg-"));

import { describe, expect, test } from "bun:test";
import { parseSlashCommand, SLASH_COMMANDS } from "../client/chrome/commands.ts";

/**
 * The parser is a safety boundary: anything it claims is a command never
 * reaches the agent. The interesting cases are all the ones it must REFUSE.
 */
describe("parseSlashCommand", () => {
  test("recognizes a bare command", () => {
    expect(parseSlashCommand("/clear")?.name).toBe("clear");
    expect(parseSlashCommand("  /clear  ")?.name).toBe("clear");
    expect(parseSlashCommand("/CLEAR")?.name).toBe("clear");
  });

  test("a path is a message, not a command", () => {
    // The case this parser exists for: a slash-led path must send verbatim.
    expect(parseSlashCommand("/Users/kevin/dev/lucid")).toBeNull();
    expect(parseSlashCommand("/etc/hosts")).toBeNull();
    expect(parseSlashCommand("/")).toBeNull();
  });

  test("a sentence that starts with a command is a message", () => {
    expect(parseSlashCommand("/clear the second paragraph")).toBeNull();
    expect(parseSlashCommand("/clear-ish")).toBeNull();
  });

  test("an unknown command is a message, never a near match", () => {
    // A typo sends - recoverable. Running the nearest command is not.
    expect(parseSlashCommand("/cler")).toBeNull();
    expect(parseSlashCommand("/clearr")).toBeNull();
    expect(parseSlashCommand("/help")).toBeNull();
  });

  test("ordinary text is untouched", () => {
    expect(parseSlashCommand("clear")).toBeNull();
    expect(parseSlashCommand("please clear the chat")).toBeNull();
    expect(parseSlashCommand("")).toBeNull();
  });

  test("every registered command is reachable by its own name", () => {
    for (const command of SLASH_COMMANDS) {
      expect(parseSlashCommand(`/${command.name}`)).toBe(command);
    }
  });
});

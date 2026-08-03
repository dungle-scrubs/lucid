/**
 * Slash commands typed into the composer.
 *
 * A composer command is text the viewer ACTS on instead of sending. That makes
 * the parser a safety boundary, not a convenience: everything it does not
 * recognize must reach the agent byte for byte, because the alternative is a
 * message that silently disappears. A path (`/Users/kevin/dev/lucid`), a regex,
 * a snippet of shell - all of them start with a slash and none of them are
 * commands.
 *
 * So the rule is exact and narrow: the WHOLE trimmed message is `/name`, with
 * no arguments and nothing after it. Anything else is a message. There is no
 * prefix matching and no fuzzy resolution; a typo sends, which is recoverable,
 * rather than running the nearest command, which is not.
 *
 * This is a registry rather than one `if` because the second command is the
 * one that turns a special case into a pattern, and it costs a few lines now
 * instead of a refactor then.
 */

/** What a command needs from the session to do its work. */
export interface CommandContext {
  readonly clearRecord: () => Promise<void>;
}

export interface SlashCommand {
  /** One line, for anything that lists commands later. Nothing renders it yet -
   *  the composer deliberately has no popup menu. */
  readonly description: string;
  /** Without the slash. */
  readonly name: string;
  readonly run: (context: CommandContext) => Promise<void> | void;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    description: "Clear the chat. Nothing is deleted - the log keeps everything.",
    name: "clear",
    run: (context) => context.clearRecord(),
  },
];

/**
 * The command a message IS, or null if it is a message.
 *
 * Null is the answer for every uncertain case, which is what keeps a typed path
 * from being eaten.
 */
export const parseSlashCommand = (text: string): SlashCommand | null => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const name = trimmed.slice(1);
  // No whitespace anywhere: `/clear` is a command, `/clear the deck` is a
  // sentence somebody typed, and `/Users/kevin` has a slash of its own.
  if (name === "" || /[\s/]/.test(name)) return null;
  return SLASH_COMMANDS.find((command) => command.name === name.toLowerCase()) ?? null;
};

# Native Claude Code conversations

Publish an artifact from an existing Claude Code CLI session and receive
browser feedback in that same session. The publication request, offer format,
receipt and response rules are the ones in
[Native Codex authoring](native-codex.md#author-and-revise). This page covers
what differs in Claude Code. Terminal reconnect and automatic headless
continuation are verified for Codex CLI only.

## Set up hooks

Run `lucid connection setup --interface claude-cli --settings-file FILE [--json]`
against the Claude Code settings file that should hold the hooks: usually
`~/.claude/settings.json`, or a project's `.claude/settings.json`. Setup
refuses a deployed symlink; use its managed source file. It preserves other
settings and hooks, creates a missing file, and makes no changes when its
handlers already match. A changed or duplicate Lucid handler is a refusal.

Setup installs four handlers, each running the configured Lucid executable
with its record root:

| Event | Deadline | Purpose |
| --- | --- | --- |
| `SessionStart` | 60 s | Registers the session ID, folder and `claude` process |
| `UserPromptSubmit` | 10 s | Ends listening when a new prompt arrives |
| `Stop` | 60 s | Waits up to 45 seconds for saved feedback and delivers it |
| `PostToolUse` on `Bash` | 30 s | Records Lucid commands the main conversation ran |

Claude Code holds back hooks until the project folder's workspace trust is
accepted. A new session, or `/clear` in an open one, runs SessionStart and
registers it. Setup alone does not mean the session is listening. See
[Claude Code hooks](https://code.claude.com/docs/en/hooks).

## Why commands finish in a hook

Claude Code runs a subagent's Bash commands with the parent's session ID
and process, so a Lucid command cannot prove which conversation ran it.
The hook callbacks can: Claude Code marks a subagent's callback with
`agent_id`.

So in Claude Code, `artifact publish`, `connection resume-listen`,
`connection receipt` and `connection respond` save a request and print a
`lucid-claude-proposal:` line. Nothing in the conversation record changes
yet, except that publish writes the document. When the Bash call finishes,
the `PostToolUse` hook records the request, but only for a main-conversation
call in the registered session. It reports the result to the model after
the tool output.

- Run each command in its own foreground Bash call. A background command
  finishes after its callback, so its request is never recorded.
- A subagent's request is refused and cannot be recorded later.
- A request expires after 10 minutes and is recorded at most once.
- `connection cancel-input` and `connection status` run directly.

## Listening

After publication, the hook result confirms the connection. Then run
`lucid connection resume-listen CONVERSATION --json`, let that Bash call
finish, and end the turn. Stop waits up to 45 seconds without a model
request and continues the turn with the feedback. After the response is
recorded, the next Stop listens again.

Listening ends and needs another `resume-listen` when:

- the wait expires;
- the person presses Escape during the wait (Claude Code stops the hook);
- any new prompt arrives, including a background task notification;
- Lucid reaches Claude Code's consecutive Stop hook limit
  (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`, default 8). Lucid stops before the
  limit, because Claude Code would not deliver an offer past it, and shows a
  notice.

Feedback delivered in one Stop continuation is capped at 19,900 encoded
bytes. Larger feedback, and feedback with attached files, stays saved and
held.

If the Claude Code session is closed, resume it in its working folder with
`claude --resume SESSION_ID`, then run `resume-listen` in it. The browser
shows these instructions for a closed Claude Code connection.

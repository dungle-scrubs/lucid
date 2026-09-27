# Native Pi conversations

Publish an artifact from an existing Pi CLI session and receive browser
feedback in that same session. The publication request, offer format,
receipt and response rules are the ones in
[Native Codex authoring](native-codex.md#author-and-revise). This page covers
what differs in Pi. Terminal reconnect is verified for Codex CLI only; a
closed Pi session continues headlessly instead (below).

## Set up the extension

Run `lucid connection setup --interface pi-cli --settings-file FILE [--json]`
against Pi's user settings file: `$PI_CODING_AGENT_DIR/settings.json` when
that variable is set, else `~/.pi/agent/settings.json`. Setup writes
Lucid's extension under the configured record root and appends its absolute
path to the `extensions` array in that file. It preserves every other
setting and extension, creates a missing file, and makes no changes when
its entry already matches. The extension file is named for its content, so
a changed Lucid installation writes a new file; re-running setup replaces
Lucid's old entry with the new path instead of adding a second one. An
invalid settings file is a refusal; its contents are kept.

Start a new Pi session after setup so the extension's `session_start`
registers it. Setup alone does not mean the session is listening.

## What the extension does

The extension runs inside the Pi TUI session. It registers the session when
it starts, and when a run settles it waits up to 45 seconds for saved
browser feedback if listening was requested, delivering a note into the
session as a follow-up message. Typing in Pi cancels that wait; the note
stays saved and needs another explicit `resume-listen`.

In Pi, `artifact publish`, `connection resume-listen`, `connection receipt`
and `connection respond` only propose: each saves a request and prints a
`lucid-pi-proposal:` line. The extension commits the request when the Bash
call that ran the command finishes, and reports the result after the tool
output.

- Run each Lucid command in its own Bash call and let it finish; the
  extension records it from that call's result.
- A proposal expires after 10 minutes and is recorded at most once.
- `connection cancel-input` and `connection status` run directly.

## Run the lucid binary directly

Run the `lucid` binary directly in Pi's Bash tool. `npx`, `bunx`, `pnpm`,
`node <script>`, or a nested `pi` between the command and the session
refuses with `proposal-ancestry-unverified`: Lucid cannot prove which Pi
session ran the command when a JavaScript runtime or another Pi process
sits in between.

## Headless resume

After the interactive Pi session closes and Lucid confirms its departure, a
bound record continues through `hcn` with Lucid's extension loaded into the
headless run. The extension verifies the opened session and folder before
the prompt can reach the model, closing the race where a missing session
file would silently resume an empty new session. A proven refusal holds
the note with reason `native-session-missing`: no automatic retry and no
fresh session. Any other uncertain outcome stays held under the ordinary
continuation rules.

## Limits

RPC, print, and JSON Pi runs never register, so their publications fall
back to a headless session. A Pi subagent's proposals are never committed:
a subagent process has its own session ID, so its proposals fail the
session check, and a nested Pi that resumed the parent session is refused
by the ancestry rule above.

| Refusal | Meaning |
| --- | --- |
| `native-context-unverified` | The registering process could not be proven to be the Pi session that owns the callback. |
| `proposal-ancestry-unverified` | A JavaScript runtime or another Pi process runs between the Lucid command and the registered session, so nothing was saved. |
| `proposal-session-mismatch` | The proposal names a session other than the registered one, so it was not committed. |
| `registration-replaced` | A newer session start replaced the registration this commit named; the record binding is unchanged. |
| `native-extension-unavailable` | Lucid could not prepare its extension file for a headless resume, so nothing was started. |

## Troubleshooting

A publish that reports `owner-unknown` from inside Pi means the Bash
command ran without `PI_SESSION_ID`. Pi sets it only when its Bash tool
receives the tool context; an extension that replaces the Bash tool must
pass its `ctx` argument to Pi's built-in tool's `execute`. Check with
`echo "$PI_SESSION_ID"` from Pi's Bash tool.

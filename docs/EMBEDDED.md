# Lucid inside a chat desktop app

For harness authors integrating Lucid with an app that embeds a browser pane
next to the conversation - ChatGPT desktop, Claude desktop. One file: what to
export, what `open` returns, and how feedback gets back into the agent's
context.

If you are integrating a terminal harness, you do not need this file. Nothing
here changes the terminal path, and the defaults it describes are not the
defaults there.

## Why the pane is a different view

The embedded pane is a window over ONE session. The chat app already plays the
role the shell plays for a terminal harness - it is where the human switches
between conversations - so a tab strip and a palette inside that pane offer
navigation the conversation already owns. The pane should show that one
artifact with the full review UI and nothing around it.

Lucid calls this the **view**, and it decides presentation only: never process
topology. (Not to be confused with a *surface*, which in Lucid means the
addressable rendering itself - the artifact plus the overlay that makes every
part of it targetable. A view is the window a surface is presented in.) A hub still hosts the session if one is running, the hub is
still the single appender, and there is no second process either way.

## What to export

One variable, beside the ones your integration already exports:

```sh
export LUCID_VIEW=solo
```

Sniffing the host app is deliberately not supported: those apps' own
environment variables are undocumented and unstable, while this channel is the
same per-harness integration file that already carries `LUCID_HARNESS`,
`LUCID_SESSION_ID` and `LUCID_MODEL` - variables measured reaching the session
log's attendant stamp intact from inside these apps.

A value Lucid does not recognise resolves to the shell view and is not an error, so an integration file written against a newer Lucid will not break an
older CLI.

## What `open` then returns

```jsonc
{
  "session": "/abs/path/.lucid/plan.html",
  "version": 1,
  "status": "active",
  "nextCursor": "evt_00001",
  "url": "http://127.0.0.1:17428/s/a1b2c3/__lucid/viewer",
  "view": "solo"
}
```

Two things differ from a terminal open:

- **`url` is the shell-free review UI.** `/__lucid/viewer` when the session has
  its own server, `<hub>/s/<id>/__lucid/viewer` when a hub is hosting it. There
  is no new route here - the hub already mounts every session's own server body
  under `/s/<id>`, so that URL already existed.
- **No browser is launched.** Surface the `url` in your pane. Lucid does not
  reach the launcher at all on this path, so nothing pops over the human's
  window.

The `view` field is always present, in both views. Read it when a URL is not what
you expected: it says which decision produced it, rather than leaving you to
infer that from the shape of the path.

`url` is the same field a terminal open returns. There is no second field to
choose between - two URLs for one surface is a choice an agent can get wrong.

## Getting feedback back: drain at the start of every turn

The recording side needs nothing from you. Annotations append to the session
log whether or not anyone is listening, and artifact updates reach the open
pane live. The only question is how feedback re-enters the agent's context, and
in an embedded app the answer is a non-blocking drain at the top of each turn:

```sh
lucid wait <file> --since <cursor> --timeout 0
```

`--timeout 0` is a **drain**: one read of the log, whatever is pending, no
blocking. Carry the `nextCursor` from every payload forward and pass it as
`--since` on the next call.

The loop, per turn:

1. Drain with the cursor you stored.
2. Act on whatever came back - annotations, replies, answers.
3. Store the new `nextCursor`.

State the latency plainly to whoever you are integrating for: **annotations
arrive with the human's next chat message.** Somebody who marks up the artifact
and waits silently will see nothing happen. That is the honest cost of this
option, and it buys full reliability with no concurrency hazards - the drain is
one read, and the log is append-only.

## The two alternatives, and why neither is the embedded default

**Attend / spawn.** A hub started with `--attend` resumes the recorded harness
session headlessly, one turn per send, so feedback lands instantly. Not the
default here for two reasons: the resumed turn happens outside the app's chat
UI, so it is invisible in the conversation history the human is reading, and it
risks two writers on one conversation when the human is mid-message in the app.
Trusting it in this scenario needs harness presence detection - knowing whether
the human's own session is live - which is filed separately and not built.

**A background blocking `wait`.** No Lucid change at all: run `lucid wait`
without `--timeout 0` as a background process and re-enter the conversation
when it returns. This fits Claude Code well, where a completed background task
re-invokes the agent. It fits the ChatGPT app poorly - its process manager does
not feed that output back into the chat the same way - which is why the drain
is the recommendation for that app rather than this.

## When a terminal session unexpectedly loses its shell

Check `view` in the `open` payload first. `LUCID_VIEW` exported in a terminal
session - from a shell profile, or inherited from a parent agent
process - makes every `open` in that shell return the solo URL and launch no browser. It
is per-integration-file on purpose so this is a visible mistake rather than a
silent one, and the payload names it.

## See also

- [CONTRACT.md](./CONTRACT.md) - the wait payload and the loop, in every view.
- `skills/lucid/SKILL.md` - the one file an agent reads.

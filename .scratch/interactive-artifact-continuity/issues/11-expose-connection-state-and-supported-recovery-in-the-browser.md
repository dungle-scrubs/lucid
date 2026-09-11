# 11: Expose connection state and supported recovery in the browser

Status: open
Blocked by: 01, 02, 08, 09

## What to build

A first-time reader can see where feedback will go and act on supported recovery without confusing saved preferences with a live connection.

## Acceptance criteria

- [ ] The shared projection supplies current state, exact reason, supported actions, native ID and observed time independently of historical notices and saved preferences.
- [ ] Saved, Sending, Received, Response finished, Cancelled and uncertainty retain their distinct meanings and actual outcomes.
- [ ] Recovery actions revalidate server-side and never infer closed ownership, retry uncertain work, switch models or create a fresh native conversation.
- [ ] Authoring guidance uses the new publish command and its returned URL, then enters the installed listener.
- [ ] The real browser passes the accepted scenarios at 390, 768 and 1440 pixels in light and dark themes, with keyboard focus retained and one live announcement.

## Parent

RFC 26 and planning map https://github.com/dungle-scrubs/lucid/issues/253. Machine-made implementation slice under the approved autonomous continuation.

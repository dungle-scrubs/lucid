# 11: Expose connection state and supported recovery in the browser

Status: claimed
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

## Projection implementation seam

Machine-made under the accepted autonomous instruction: first complete the existing shared read projection before rendering browser controls. Tests attach at ConversationHost, managed execution and observeConnection/readConnection with real records and injected process observations. An owned current launch with a matching attempt and held executor lock distinguishes starting, responding and terminal response awaiting cleanup. Missing owner/lock evidence and settled uncertainty remain held. Reconnect waiting preserves the current response stage, and no status grants dispatch authority. This holds product scope: the same person needs an accurate explanation of where saved feedback is going.

## Browser implementation seam

Machine-made under the same autonomous instruction: test supported action selection through public readConnection on durable records and fresh owner observations, then test HTTP instructions with the configured root and exact conversation. Browser verification attaches to the rendered connection panel, request cancellation, read-only refresh and keyboard focus. Render the native connection panel only for a bound native conversation. A missing binding alone cannot distinguish a failed native publication from an ordinary managed artifact, so retaining publication failure evidence and exposing setup for that case remains a separate unfinished slice. Saved preferences never establish connection or readiness. Terminal reconnect owns its wait; browser cancellation is not offered without a supported ownership contract. This holds scope for the same person reading and annotating an artifact.

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

## Per-input delivery seam

Machine-made under autonomous continuation. This holds scope for the person reading and annotating an artifact: Lucid routes an agent conversation into a durable record, and the person needs to distinguish saved feedback from receipt and response. Ticket 17 now supplies the unbound publication requirement and setup failure evidence.

Tests attach to public readConnection over real host records, then the HTTP poll and rendered message component. Cases in priority order:
1. Saved feedback advances through offer and receipt without confusing another queued message; lost or unknown ownership preserves receipt and changes only the uncertainty explanation. Read-only status does not mutate or resend.
2. Recorded answer, question, refusal, failure and unsent cancellation survive replay with their actual result.
3. Same-session headless attempts distinguish dispatch, receipt, terminal response and unknown outcome; publication-era legacy inputs never acquire an invented receipt.
4. HTTP joins delivery to the durable input ID for ordinary messages and annotation batches; native messages do not inherit unsupported ordinary recovery actions.
5. Browser labels explain each state beside the message, preserve annotation navigation, and add no per-message live region. Existing connection status owns live announcements.

No new cancellation, retry or reconnect mutation is introduced by this read-only slice.

## Per-input checkpoint

Implemented the read-only delivery projection and browser labels for plain messages and both annotation batch render paths. Durable offer/receipt/outcome, headless attempt/terminal evidence, unsent cancellation and legacy publication evidence retain separate meanings. A clean terminal with no recorded reply says Response ended. Native records no longer inherit ordinary recovery buttons or contradictory ordinary activity announcements. Native refusal class remains visible in transcript text.

Full check: 1,715 tests, 9,517 assertions; lint and both typechecks pass. Build passes. Four Muse axes completed against ef340fe; small findings applied, unreachable duplicate-offer and unsupported ordinary-recovery concerns rejected with reducer/host evidence. Browser evidence under ignored input-delivery-* verifies six viewport/theme combinations, transcript/composer space, durable receipt/outcome updates, preserved summary focus/open state and one announcement per change. Synthetic native binding stands in for process ownership; no model or harness was started in this browser run. Existing native-process acceptance remains separate. Browser native mutations and full activation acceptance remain unfinished.

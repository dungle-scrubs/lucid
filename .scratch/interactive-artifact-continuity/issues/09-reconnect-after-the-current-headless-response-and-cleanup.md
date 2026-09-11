# 09: Reconnect after the current headless response and cleanup

Status: open
Blocked by: 02, 07, 08

## What to build

The terminal reconnect command reserves return, waits for the current response to settle, and launches the exact native session once.

## Acceptance criteria

- [ ] The reservation fences managed and manual executor entrants; only the matching reconnect request or verified child can cross its admission gap.
- [ ] Current response and owned cleanup finish before native history loading, including question and failure outcomes.
- [ ] Already-live owners get existing-session listening instructions. Duplicate requests join or report the same pending request.
- [ ] Cancellation withdraws only a pre-launch wait; parent death, missing child provenance and lost control remain held unless no creation is proven.
- [ ] Claude and Pi instructions explain that direct native resume bypasses this protected workflow; observed conflicts hold subsequent delivery.
- [ ] Multiprocess race and crash tests prove launch ordering and cleanup-before-release.

## Parent

RFC 26 and planning map https://github.com/dungle-scrubs/lucid/issues/253. Machine-made implementation slice under the approved autonomous continuation.

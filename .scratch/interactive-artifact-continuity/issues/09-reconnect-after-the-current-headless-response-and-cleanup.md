# 09: Reconnect after the current headless response and cleanup

Status: claimed
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

## Implementation seams

The accepted RFC holds scope: one person returns to the native session that authored an artifact. Start with durable reconnect request and withdrawal facts in the shared connection reducer and host. The current response and its owned cleanup continue; candidate selection, preparation, final dispatch and all executor admission paths observe the reservation. Test actual record replay, presence locks, duplicate requests, cancellation and preparation-to-dispatch races before adding terminal launch. The HCN seam then consumes its existing strict interactive operation and records correlated start/refusal/cleanup evidence. CLI and browser controls follow only after their underlying operations are supported. These are machine-made implementation steps within the approved ticket and RFC.

## Reservation checkpoint

One durable request now holds new native work without taking an executor lease. Explicit cancellation names the pre-launch wait, preserves feedback and current work, and cannot cancel a newer request through historical replay. Duplicate requests read the existing result without renewed native admission. New requests still refuse alive or unknown native ownership and serialize through registration and record append ordering. This uses the existing record-control authority boundary; automatic requester-loss withdrawal remains a separate evidence operation.

Tests cover record reopen/replay, actual presence locks, request arrival during raw lease acquisition, a request after preparation with zero HCN creation, and a pending approval that receives one saved decision and finishes response plus cleanup while reconnect remains reserved. The idle status reads Waiting to reconnect. Four Muse review axes and scoped fixes pass 1,621 tests and build. Evidence and review dispositions are under ignored native-reconnect-* artifacts.

HCN interactive consumption, reconnect launch and matching-child admission, requester-loss reconciliation, public controls, multiprocess full handoff and native acceptance remain pending. Runtime stays fenced. The launch phase must leave requested state before invocation and reject cancellation after that transition.

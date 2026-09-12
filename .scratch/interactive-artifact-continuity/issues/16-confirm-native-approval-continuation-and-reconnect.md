# 16: Confirm native approval continuation and reconnect

Status: open
Blocked by: 14, 15

## What to build

The disposable native lane proves same-ID settings preservation, one native request answered through Lucid, response completion and cleanup before reconnect.

## Acceptance criteria

- [ ] A native CLI-authored session continues with its exact ID, model, effort, provider and supported permissions.
- [ ] A native approval waits for an explicit browser decision and receives exactly that decision.
- [ ] Cancellation, process loss and reconnect preserve queued feedback and executor ownership.
- [ ] Pin and recording integration, full Lucid gates, build and review pass before the supported runtime lane is enabled. Desktop acceptance remains separately tracked.

## Parent

RFC 27 v2, extending RFC 26 and ticket 08. Machine-made slicing under Kevin's autonomous implementation instruction. Local tracker only.

# 15: Answer native permission requests in Lucid

Status: open
Blocked by: 14

## What to build

The person sees a native request in chat and explicitly answers it while the current headless worker retains its executor lease.

## Acceptance criteria

- [ ] Only authenticated browser decisions and current managed-attempt requests create actionable approvals.
- [ ] Request, choice and write intent are durable; duplicate sends and reload never repeat uncertain writes.
- [ ] Pending, decided, sending, sent, cleared and unavailable states explain what happened and which recovery is supported.
- [ ] Real-record and browser checks cover races, crash recovery and 390, 768 and 1440 pixel layouts.

## Parent

RFC 27 v2, extending RFC 26 and ticket 08. Machine-made slicing under Kevin's autonomous implementation instruction. Local tracker only.

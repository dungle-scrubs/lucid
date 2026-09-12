# 15: Answer native permission requests in Lucid

Status: claimed
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

## Implementation seams

Machine-made under the accepted RFC and autonomous instruction: ConversationHost admits native requests and browser decisions under the append lock; a dedicated pure approval reducer owns their lifecycle. Version 3 execution entries make older readers refuse upgraded records. Tests attach to real records, then the protected browser API and current worker dispatch. Requests remain separate from model context. First prove request authority and durability, then saved choices and one-time write intent, terminal races, crash/reopen and browser rendering.

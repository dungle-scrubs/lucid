# 15: Answer native permission requests in Lucid

Status: resolved
Blocked by: 14

## What to build

The person sees a native request in chat and explicitly answers it while the current headless worker retains its executor lease.

## Acceptance criteria

- [x] Only authenticated browser decisions and current managed-attempt requests create actionable approvals.
- [x] Request, choice and write intent are durable; duplicate sends and reload never repeat uncertain writes.
- [x] Pending, decided, sending, sent, cleared and unavailable states explain what happened and which recovery is supported.
- [x] Real-record and browser checks cover races, crash recovery and 390, 768 and 1440 pixel layouts.

## Parent

RFC 27 v2, extending RFC 26 and ticket 08. Machine-made slicing under Kevin's autonomous implementation instruction. Local tracker only.

## Implementation seams

Machine-made under the accepted RFC and autonomous instruction: ConversationHost admits native requests and browser decisions under the append lock; a dedicated pure approval reducer owns their lifecycle. Version 3 execution entries make older readers refuse upgraded records. Tests attach to real records, then the protected browser API and current worker dispatch. Requests remain separate from model context. First prove request authority and durability, then saved choices and one-time write intent, terminal races, crash/reopen and browser rendering.

## Completion

The protected browser endpoint, full plain-text request controls, explicit saved-choice reconciliation, and all six lifecycle states are implemented. Full gates pass 1,586 tests. Six browser layouts cover light/dark at 390, 768 and 1440 pixels. A native browser double click produces one POST; executor loss removes choices while retaining the saved decision, including after reload. The browser stall indicator waits for the person during a pending request. Approval revisions avoid transferring unchanged history on each poll.

Four Muse review axes completed at baseline 718d172. Closed request parsing and direct single-entry projection fixes were applied. Uncertain saves retain their original choice identity; presence is checked under the append lock and freshly projected afterward. Evidence and review dispositions live under ignored artifacts/evidence/interactive-artifact-wayfinder/lucid-native-approval-12-*. Native HCN delivery and full-attempt cleanup after any request admission refusal are ticket16 integration checks. This ticket completes the durable state and browser surfaces; it does not enable automatic native continuation.

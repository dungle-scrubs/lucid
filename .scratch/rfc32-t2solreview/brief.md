# Task
Review the T2 review-fix commits 0b2c8cc and 9d77cf6 on branch feat/rfc32-review-hold
in /Users/kevin/dev/lucid, against their parent a635fb5.

## What this change does
A prior cross-family review (glm-5.3) returned 14 findings (F1-F14) against the
RFC 32 T2 review-hold commit a635fb5. These two commits claim to fix every
demonstrated-grade finding:

- F1: hold never engaged in production. Fix: `lucid handoff` stamps
  `handoff: true` in record meta (src/cli/handoff.ts); the worker engages hold
  mode with the configured window on marked records (src/cli/managed-worker.ts).
- F2: hold timeout with an active turn unbounded. Fix: timeout mirrors
  explicit detach, abort past holdMs+graceMs.
- F3: detach reason always shutdown. Fix: new `detachYield()` on the runtime
  handle (src/cli/runtime.ts) sends a yield detach frame; abort stays fallback.
- F4: timeout projected setup-required. Fix: lapsed hold on a handoff record
  projects closed with a reconnect message (src/store/connection-view.ts).
- F5: clock restarted on worker restart. Fix: seeded from lastActivityAt.
- F6: post-detach dispatch race. Fix: holdRelease gates managed candidates
  (src/store/managed-readiness.ts); a later accepted input clears it
  (src/protocol/reducer.ts).
- Guards: detach refuses on native-bound or never-held records
  (src/cli/detach.ts); unknown presence probe no longer reports detached (F11);
  hold-connected requires the handoff marker (F12); detach in top-level usage
  plus a mapping test (F14).

## What to check
1. Each fix actually closes its finding: trace the code path end to end.
   Grade each: demonstrated (cite the lines that prove it), observation, hunch.
2. New defects the fixes introduce. Suspect areas: the meta write in
   runHandoff (lock discipline, retry path), the reducer clearing
   holdRelease on every accepted input (extra log entries? the entry is the
   input itself, verify no reference-inequality write), the blanket
   managedCandidates gate blocking legitimate resume, detachYield refusal
   handling when a turn is running.
3. Test strength: the new tests (detach refusal, plain-record labeling,
   droppable classification, mapping) prove what they claim. Name untested
   criteria from RFC 32 Phase 2 that remain untested.
4. Anything the first review missed in the a635fb5 base that these commits
   touch (managed-worker loop, connection-view branches, detach).

## Inputs
- Spec: docs/rfc/32_any-session-handoff-to-lucid.rfc.md (repo root
  /Users/kevin/dev/lucid).
- Prior review: .scratch/rfc32-t2review/report.json (the F1-F14 findings).
- Diff under review: `git diff a635fb5..9d77cf6` on branch
  feat/rfc32-review-hold. Working tree HEAD is 9d77cf6; four dirty files
  (src/protocol/execution-view.ts, src/server/server.ts and two tests) are
  pre-existing and NOT in scope, ignore them.
- Skills available: review-rfc.

## Requirements
- Every finding verified by reading the code paths end to end; state the
  grade and the lines.
- Admit what you could not verify (no shell diff against older parents,
  no test execution in read-only sessions).
- Keep it under 400 lines.

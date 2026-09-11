# 08: Resume departed authors headlessly with the same native ID

Status: claimed
Blocked by: 01, 02

## What to build

New saved feedback automatically resumes the bound native conversation only after every interactive owner is confirmed gone.

## Acceptance criteria

- [ ] Alive owners retain the resume-listening instruction; unknown owners hold feedback with the specific reason.
- [ ] All executor entrants recheck durable connection admission around the existing presence lock.
- [ ] The agreed native-ID notice is appended once after final admission and before process creation; losing contenders emit none.
- [ ] Strict same-harness and same-folder continuation ignores incompatible saved preferences, marks managed launch role and preserves the original input.
- [ ] Pre-start refusal can retry the same session after repair; started or uncertain work cannot be automatically replayed.

## Implementation checkpoint

The shared ConversationHost.acquireExecutor operation checks the current record, acquires the existing presence lock, then rechecks under the append lock before returning an executor lease. Manual headless starts and managed workers share the runtime caller; the internal native listener holds registration authority across admission and its enable write. Refusal or read failure releases the raw lock. Replaying an old listener-enable action does not renew authority. Real-record tests cover binding and terminal appearance during acquisition, native owner loss/unknown, and readiness only after enable. Four Muse reviews found no blocking admission defect; full check passes 1,521 tests and build. Bound headless continuation remains fenced. Durable launch facts, same-ID invocation, reconnect and native interface acceptance remain pending, so the full admission criterion stays unchecked.

## Parent

RFC 26 and planning map https://github.com/dungle-scrubs/lucid/issues/253. Machine-made implementation slice under the approved autonomous continuation.

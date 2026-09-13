# 17: Hold native publications before binding

Status: resolved
Blocked by: 01, 02

## What to build

A native artifact remains readable when its connection fails, and its feedback stays saved for that intended native conversation. Reopening the artifact explains the retained failure and offers supported setup guidance. It cannot silently start an ordinary fresh headless session.

## Acceptance criteria

- [x] Publication records its native connection requirement before artifact write; a crash before binding cannot leave the published artifact eligible for ordinary managed execution.
- [x] The specific failed connection result survives reopening without becoming a claim about current native ownership. Failed diagnostic persistence is reported separately from successful artifact publication.
- [x] Repeated publication preserves the authoritative conversation, versions, saved feedback and settings. A conflicting binding is never overwritten.
- [x] Managed eligibility, executor admission, source attachment, attempt start, final dispatch and ordinary queued/replayed delivery honor the same requirement. Races consume no unauthorized native creation or delivery and do not advance a delivery cursor for held work.
- [x] Work already past creation or delivery may settle normally; the correction neither kills its process nor repeats its input. Repair requires existing verified-binding checks.
- [x] The browser shows setup for opted-in unbound records with native identity unknown and only supported instructions. Ordinary managed records keep their existing behavior.
- [x] Deterministic failure/crash/race tests, the previous reader's refusal, public command/HTTP checks and responsive browser confirmation pass, followed by review and a focused commit.

## Parent

RFC 26 v9 accepted native-publication amendment, correcting the existing accepted publication/continuity contract. The slice and test seams are machine-made under the standing autonomous instruction. Two Muse amendment reviews are complete, with dispositions in v9; this local ticket does not publish or alter a shared tracker.

The reproduction used the compiled publication command, durable feedback acceptance and the production managed-candidate projection. After missing registration, that projection still selected the saved input. Evidence rung 4; no native process was started. Tests attach at those same public seams, then shared host admission/dispatch and rendered browser behavior.

## Completion

Native publication admission, retained failures, saved/unverified diagnostics, final ordinary dispatch ordering and generic browser setup are implemented. Public replay, filesystem-fault, executor/dispatch-race and browser checks pass. Four Muse review axes were completed and their fixes verified. The full gate passes 1,706 tests; build passes. An actual emitted record is refused without byte mutation by the preserved previous binary. Evidence lives under ignored publication-* artifacts. This correction does not activate the automatic bound runtime or add native interface support.

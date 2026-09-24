# Review: RFC-32 T1 handoff implementation (review-v2)

Reviewer: glm (implementation review, headless session). Commit under review:
`f7d63cd2938610e5ebec47ca7c2023b7f0a6fe19` (`feat(handoff): any-session handoff
command with payload validation and crash recovery`), branch
`feat/rfc32-handoff-command`. The review-v1 comment pass (8 comments removed,
3 MUST KILL items fixed) is not re-litigated here.

## What was reviewed

Files, at the exact commit:

- `src/cli/handoff.ts` (new)
- `src/cli/handoff-request.ts` (new)
- `src/cli/mapping.ts` (handoff case only)
- `src/cli/dispatch.ts` (handoff dispatch hunk only)
- `test/cli/handoff.test.ts` (new)
- `test/cli/handoff-request.test.ts` (new)

Spec: `docs/rfc/32_any-session-handoff-to-lucid.rfc.md` (Accepted, v2), Design
1-3, State Machine, Error Handling, Security Considerations. Ticket:
dungle-scrubs/lucid#306 (T1). Sibling tickets read for scope splits: #307
(T2, review hold), #308 (T3, skill), #309 (T4, flaky-test quarantine).

Method: the scoped files in the working tree are byte-identical to the commit
(`git diff f7d63cd -- <scoped files>` is empty). `bun test` on both test files
passes (16/16). `bun run check` ran in a detached worktree at the exact commit.
Behavior probes ran against the commit's code from
`.scratch/handoff-review-v2/probe.ts` and `.scratch/handoff-review-v2/probe-presence.ts`
(local evidence paths; each probe's result is quoted inline below so this file
stands alone). Probes wrote only inside `mkdtemp` directories.

Grades: **demonstrated** (ran the code or a check), **observation** (code
inspection), **hunch** (neither).

## Findings

### 1. The command never attaches; the record ends PUBLISHED_UNATTACHED permanently

`src/cli/handoff.ts:92-100` (return after `presence.release()`), `:22-25`
(doc comment: "Presence is held across the appends, then released").

RFC Design 2 step 4 orders `attach` through `openDrivenConversation` after the
appends; Design 3 defines it (epoch 1, executor); the state machine's
`PUBLISHED_UNATTACHED -> HELD` transition has this attach as its only producer
from the handoff path. Issue #306's build text says the command "attaches the
invoker as source holding presence across creation," and its crash criterion
lists "attached" as a recovery state. T2 (#307) starts "after publish the
invoker stays attached," which presumes T1 attached.

None of that exists in the diff. Probe 4, after a successful handoff:

```text
after handoff: epoch=0 attached=false
```

The core RFC promise (browser chat reaches the invoker's session through the
review window) has no producer. As written, T1's scope was cut without the
ticket or RFC being updated; either the attach belongs in this branch or #306's
text and acceptance criteria need re-cutting. Severity: high.

**Grade: demonstrated** (probe 4).

### 2. Retry equality is not enforced for the continuation: a second task is queued

`src/cli/handoff.ts:65-68`, with `src/store/creation.ts:71-74` (receipt equality
compares only `settings` and `workingDirectory`).

RFC Design 1: "a retry sharing a `creationId` MUST be byte-identical in
artifact bytes, continuation `inputId` and text, settings, and working
directory... Any difference MUST be refused as a conflicting request." The
creation receipt cannot see the continuation, and `runHandoff` only detects a
difference when the inputId itself collides. A retry with the same
`creationId` and a fresh `inputId` succeeds and appends a second queued task.
Probe 1:

```text
PROBE 1 - retry, same creationId, DIFFERENT continuation inputId+text
  result: SUCCESS conversationId=true
  inputs in record after both: 2
```

The record is not duplicated (the `MUST NOT create a second record` half
holds), but the "any difference MUST be refused" half does not. A crash
followed by an operator-edited retry file silently double-queues work.
Severity: high.

**Grade: demonstrated** (probe 1).

### 3. Presence handle is dropped when `openWriter` throws

`src/cli/handoff.ts:49-51`: `acquirePresence` at line 49, `openWriter` at
line 50, the `try` begins at line 51. If `openWriter` throws (corrupt secret,
unreadable record), `presence` is held and never released on that path.

The `finally` at `:101-105` only covers exceptions after the `try` starts. In
the CLI the process exits immediately after, so the kernel frees the flock and
the leak is invisible. Any in-process caller (the server, tests, the T2 hold
wrapping this function) keeps the record's presence lock held indefinitely:
every later attach and managed dispatch is locked out until that process dies.
Probe 11:

```text
after corrupt-secret handoff THREW: StoreError: malformed secret file: ...
after OPENWRITER THROW: presenceHeld=true (false=released, true=LEAKED in-process)
```

Fix shape: move `openWriter` inside the `try`, or wrap from acquisition. This
is the hunt item "dropped presence handle on any path"; this is the one path.
Severity: high for T2, medium as shipped.

**Grade: demonstrated** (probe 11).

### 4. Differing artifact bytes on retry are refused E-HUB-03, not E-HUB-02

`src/cli/handoff.ts:62-63`.

A retry with the same creation key and different artifact bytes is "a
differing request on an existing key" - the RFC's error table assigns that
E-HUB-02, and the retry-equality paragraph says "MUST be refused as a
conflicting request." The implementation throws `E-HUB-03` ("bad handoff
request") with the internal issue name in the message. Probe 2:

```text
PROBE 2 - retry, same creationId, DIFFERENT artifact bytes
  result: REFUSED HubError E-HUB-03 (409): Artifact write refused: artifact-version-exists.
```

The refusal happens and nothing half-made persists, so this is a wrong-code
finding, not a wrong-behavior finding. The recovery instructions differ
between the two codes (E-HUB-02: reconcile and retry with a fresh key;
E-HUB-03: retry corrected), so the misclassification sends the operator to the
wrong recovery. Severity: medium.

**Grade: demonstrated** (probe 2).

### 5. Presence contention surfaces a raw LockError with no refusal vocabulary

`src/cli/handoff.ts:49` - `acquirePresence(dir, id, { timeoutMs: 0 })` with no
surrounding handling.

When another process holds the record's presence (an attached invoker, a
managed worker - exactly the state the RFC's hold creates), the command dies
with an unclassified `LockError`. Probe 7:

```text
PROBE 7 - presence held by another process during handoff
  result: REFUSED LockError code=lock-timeout: timed out acquiring append lock on
          .../presence
```

RFC Error Handling: "Refusal reasons MUST reuse the existing vocabulary." The
message also says "append lock" for a presence lock and leaks the absolute
record path. Once T2 ships the hold, retrying a handoff into a held
conversation is a natural operator move and it produces this. Severity: medium.

**Grade: demonstrated** (probe 7).

### 6. Existing record, colliding inputId, identical text: success instead of `input-id-reused`

`src/cli/handoff.ts:70-88` plus the idempotent replay branch in
`src/store/conversation-host.ts:1771-1796` (same id + same text + same mode
returns accepted with the old seq, nothing appended).

RFC Design 1: "For an existing record the continuation MUST carry an `inputId`
not already present, else `input-id-reused`." The implementation returns a
full success - and `src/cli/dispatch.ts:341` then prints
`continuation <id> queued`, which is false: nothing was queued, and if the
earlier input was already applied the "task" was finished long ago. Probe 5:

```text
PROBE 5 - existing record, colliding inputId, SAME text
  result: SUCCESS (idempotent) seq=1 inputs=2
```

(The 2 inputs are probe 4's fresh inputId plus the original; the colliding id
added none.) The idempotent return is the right behavior for the
creationId-retry path; the conversationId path cannot distinguish retry from
fresh handoff, and the RFC chose refusal there. The command should either
refuse per the RFC or report "already present" rather than "queued".
Severity: medium.

**Grade: demonstrated** (probe 5).

### 7. Artifact idempotency check is weaker than publication's

`src/cli/handoff.ts:62` compares `previous?.bytes` only.
`src/cli/artifact-publish.ts:167-170` compares bytes, `author`, and
`contentType` before tolerating `artifact-version-exists`.

On an existing record, a pre-existing version with identical bytes but a human
author (a saved version) is accepted as this handoff's agent-published version,
and the result reports `publication.status: "published"` for bytes the
handoff's invoker did not write. Same-shaped check as the sibling command;
three of four fields were carried over. Severity: low.

**Grade: observation.**

### 8. Portless `serverUrl` is accepted

`src/cli/handoff-request.ts:104-114`: the constraint block checks protocol,
hostname, credentials, pathname, search, and hash, but never requires a port.

`http://127.0.0.1/` parses and the produced artifact URL points at port 80,
where no Lucid server runs (the server binds one assigned loopback port).
Probe 9:

```text
PROBE 9 - portless serverUrl
  accepted; serverUrl=http://127.0.0.1/ -> artifactUrl origin http://127.0.0.1 (port 80)
```

The check is copied from publication, so this matches the
"validated as publication validates it" incorporation; the RFC's own field
text says `http://127.0.0.1:<port>`. Severity: low.

**Grade: demonstrated** (probe 9).

### 9. `runHandoff`'s `settings === undefined` fallback is dead via the CLI and diverges from the parser

`src/cli/handoff.ts:31-32` versus `src/cli/handoff-request.ts:125-126`.

`parseHandoffRequest` always supplies `settings` (user defaults when omitted),
so through `dispatch` the fallback is unreachable. It matters only for direct
callers: they get a second `readUserConfig()` read (which can diverge from the
parser's within one run if config changes) and pass
`completeSettings: undefined` into `acceptInput`, skipping
`completeLegacyPreference`. It also re-runs `settingsShape` over an
already-shaped `Settings`. Either drop the branch (require shaped input, as
the type already claims) or resolve defaults in one place. Severity: low.

**Grade: observation.**

### 10. Unknown request fields are silently ignored

`src/cli/handoff-request.ts:44` destructures the known keys; anything else in
the JSON is dropped without refusal.

RFC Design 1: the request "MUST contain exactly these fields" and "MUST NOT
contain transcript history, a foreign native session id, or credentials." The
security outcome holds - nothing ignored enters the record, and the store
seams never see those keys - but a request carrying a foreign session id or a
pasted transcript gets a success, not the specified refusal. Publication's
parser behaves the same way, so this is inherited, not introduced. Severity: low.

**Grade: observation.**

### 11. `bun run check` is red at the exact commit, from the #309-tracked flaky tests

A detached worktree at `f7d63cd` with a fresh `bun install`: 1823 pass, 2 fail
(`test/cli/compiled-routing.test.ts` "compiled worker commands route directly
to their internal subcommand", exit 137; `test/cli/managed-worker-process.test.ts`
"compiled background launch completes one task and all worker processes exit").
Both reproduce in the main working tree with the dirty files stashed, so they
are pre-existing at this commit and unrelated to the handoff files. They are
the two tests issue #309 (T4) already tracks as flaky.

Issue #306's first acceptance criterion ("`bun run check` green") is therefore
not literally met on this machine at this commit; all 16 handoff tests pass.
Severity: informational, tracked in #309.

**Grade: demonstrated** (worktree run, main-tree run).

### 12. Test coverage gaps against issue #306's acceptance criteria

The suite proves the happy path, the no-native-publication property, and the
parser boundary (including both multibyte sides of the code-unit limit). It
does not cover, by criterion:

- **Crash injection (criterion 4): no test at all.** The adopt test
  (`test/cli/handoff.test.ts:120`) inspects the post-append state, which
  approximates "crash after artifact append," but nothing injects a crash
  before the artifact write, and no test drives a retry into a half-made
  record.
- **Bad-folder refusal (criterion 3): no test.** The E-HUB-04 path works
  (probe 8: `HubError E-HUB-04 (400): Working folder is missing or
  inaccessible. Choose an available folder.`) but is unasserted.
- **Conflicting-retry refusals (criterion 3): partial.** Only
  continuation-text mismatch is tested (`handoff.test.ts:83`), it asserts the
  message substring, not the E-HUB-02 code, and the differing-bytes,
  differing-settings, and differing-workdir refusals are untested. Findings 2
  and 4 live exactly in that untested space.
- **The existing-conversation path is entirely untested.** No test passes
  `conversationId`. Findings 6 and 7 are on that path.
- **The identical-retry test (`handoff.test.ts:69`) asserts conversationId and
  URL only.** It does not assert the input count stays 1 or that the seq is
  unchanged, so a duplicated continuation append would pass it. It also does
  not assert `presenceHeld(dir) === false` after any run, which would have
  caught finding 3's class.

Severity: medium - the suite asserts the happy path faithfully but leaves the
RFC's distinctive claims (equality, crash, existing-record) to untested code.

**Grade: observation** (test reading; the underlying behaviors are
demonstrated in findings 2, 3, 4, 6, 8).

## Cleared

Checked and passing. Each item names its evidence.

- **Presence released on the success, refusal, and idempotent-retry paths**
  (`handoff.ts:80-82`, `:92-94`, `:101-105`). Probe 11:
  `presenceHeld=false` after success, after the E-HUB-02 refusal, and after
  the idempotent retry. The one leak is finding 3.
- **No native-publication requirement recorded; the continuation is an
  ordinary managed candidate** (RFC Design 2 MUST, #306 criterion 5).
  Probe 10: `executions kinds: ["requested"]`,
  `managedCandidates: ["continue-1"]`, `connection state: null`. Asserted by
  `handoff.test.ts:44-52` and `:113-127`.
- **Continuation enters as a managed input**: `acceptInput` with
  `managed: true` (`handoff.ts:65-68`) lands as a `managed-input` entry with
  execution `{kind: "requested", attempt: 0}` (`conversation-host.ts:1806-1818`,
  probe 10).
- **E-COMP-06 branch behavior**: text match returns the existing receipt with
  its original seq (`handoff.ts:70-88`; probe 5: `seq=1`, no new input);
  text mismatch returns E-HUB-02 with a recovery message (probe 6).
- **Existing-conversation path works with a fresh inputId** (probe 4:
  appended to the existing record, `inputs=2`), and a missing conversation is
  refused through `commandRecordDir` as E-HUB-03/404 - the same failure shape
  publication produces (`record-addressing.ts:190-198`).
- **Unterminated-turn safety at command exit**: the command never starts an
  attempt (execution `requested`, attempt 0), so no `attempt-started` exists,
  the input classifies never-dispatched, and later dispatch redelivers without
  the uncertain-attempt block (probe 10; RFC Design 3's distinction holds by
  construction).
- **Creation idempotency for identical retries**: same conversation id
  returned (test `handoff.test.ts:69`, probe 5); differing settings or
  working directory refused through the creation receipt with E-HUB-02's
  message (probe 3: `code=E-HUB-02: This creation ID was used with different
  choices.`), matching publication's behavior of letting `CreationError`
  propagate.
- **E-HUB-04 bad-folder refusal works with recovery guidance** (probe 8),
  via the same `WorkingFolderError` mapping publication uses.
- **Payload validation matches the spec's field list**: XOR identities with
  wire-valid ids, artifact shape with `validArtifactId` and version >= 1,
  UTF-16-code-unit limits on both artifact and continuation with oversize
  refused (never truncated) and both multibyte sides asserted
  (`handoff-request.test.ts:38-66`, including the 400,009-unit /
  1,200,009-byte acceptance case from review-v1 F9), nonempty continuation,
  loopback-only `serverUrl` with credentials/path/search/hash refused,
  absolute control-character-free `workingDirectory`.
- **URL and ordering details**: artifact URL matches the server route
  `/c/:id/:artifactId` (`server.ts:278`) and publication's format, with both
  segments encoded; artifact append precedes continuation append (RFC Design 2
  step 3); creation goes through the atomic `createWithReceipt` staging
  unchanged.
- **The creation-to-presence gap is safe**: on a first handoff the log is
  empty at that point, so no managed candidate exists to lose the race; on a
  retry into a record that already holds an input, RFC Design 2 explicitly
  allows managed dispatch ("that fallback is intended").
- **Mapping and dispatch hunks**: the handoff case follows the
  artifact-publish pattern exactly (duplicate `--json` or `--request`, missing
  or flag-like value, and unknown flags all fall to help); dispatch wires
  request-file -> parse -> run, prints one result, and `--json` emits the
  whole result object.

## Not reviewed

- **Design 4 and 5 (review hold, browser hold states)**: no code exists in
  this commit; T2 (#307) owns them. Their absence is noted in finding 1 only
  where T1's own text promised the attach.
- **Live-harness and browser confirmation**: no real model, no served-page
  check, no `lucid serve` round trip. Probes exercised the store seams
  directly.
- **Multi-process contention beyond the synthetic probe**: probe 7 used one
  in-process `Flock` holder; no two-CLI-process race was run.
- **The root cause of the two flaky tests** (finding 11): located and matched
  to #309; not diagnosed further. T4 owns them.
- **`docs/rfc/README.md` hunk**: out of scope. In passing: it still calls RFC
  32 "a draft" while the RFC file says Accepted v2.
- **Review-v1's comment pass** (8 removed comments, 3 fixed MUST KILLs): per
  instructions, not re-examined.

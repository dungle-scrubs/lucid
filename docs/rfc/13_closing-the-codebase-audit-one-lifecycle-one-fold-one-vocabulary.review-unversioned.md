# Review of RFC-13 (unversioned)

## What was reviewed

- RFC: `docs/rfc/13_closing-the-codebase-audit-one-lifecycle-one-fold-one-vocabulary.rfc.md`.
- Version: **none stated**. `unversioned` in this filename records that absence; it is not an assigned draft version.
- Status: **Draft**. Document date: 2026-09-05.
- SHA-256: `e2aed5e11f38c2327c034a7e6937b14e4db3194337c92c64ea79c385be08ec90`.
- Code baseline: `d9c8de0`, matching the RFC's cited audit baseline.
- Method: one whole-document review, with targeted source inspection and existing deterministic tests. The RFC and implementation were not edited.

## Structural results

Command:

```sh
npx tsx /Users/kevin/.agents/skills/draft-rfc/scripts/validate-structure.ts docs/rfc/13_closing-the-codebase-audit-one-lifecycle-one-fold-one-vocabulary.rfc.md
```

Validator output, verbatim:

```json
{
  "passed": true,
  "errors": [],
  "warnings": []
}
```

## Findings

### F1 - Preserve the existing sequence position in the new version headers

**Priority:** High. **Lands in:** C2, lines 225-228; C4, lines 314-325; Testing Strategy, item 4.

The specified walk output omits `artifactAfterSeq`. The specified version header contains `offset`, `author`, `at`, and `basedOn`, but no sequence position. C4 then requires the catalog to use these headers and makes `artifactKey` private, while the existing catalog still needs that key to retrieve each version's position.

The current fold records the preceding protocol sequence at `src/store/log.ts:697-703`. The catalog exposes it as `afterSeq` at `src/store/conversation-host.ts:492-508`. A byte offset and a timestamp do not replace that protocol sequence. Implementing the listed outputs literally loses existing catalog data or leaves an external dependency on the key that C4 makes private.

**Evidence:** Rung 4 for the existing behavior: all five tests in `test/store/artifact-place.test.ts` pass, including preceding-sequence placement and persistence across reopening. Rung 2 for the specification gap; a regression in a future implementation is unproven.

**Requested clarification:** Carry `afterSeq` in each accepted version's header, or specify an equivalent public projection. Preserve first-writer-wins behavior for duplicate versions and retain the artifact-place tests unchanged. Add this field to the transaction's cache-install contract where needed.

### F2 - The HTTP lock-timeout contract does not match the routes it names

**Priority:** High. **Lands in:** C2, lines 263-266; Migration Strategy, lines 452-455; Error Handling, E-LOG-01; Testing Strategy, item 7.

The migration promises 503 responses for version, save, restore, and meta requests through a change described as propagating `readArtifact` errors. Those routes do not share that read path:

- Version GET calls the lock-free `viewArtifactVersion`, which calls `foldLog` and `readArtifactVersion` (`src/server/server.ts:383-389`; `src/store/conversation-host.ts:517-525`). It does not call the method C2 changes.
- Save opens a host and writes a version without calling `readArtifact` (`src/server/server.ts:435-463`).
- Meta opens a host and writes metadata without calling `readArtifact` (`src/server/server.ts:514-547`).
- Restore calls `readArtifact`, but only after host construction (`src/server/server.ts:569-589`). Host construction and subsequent writes also need their own error boundary.

Even `ConversationLog.readArtifact` returns a valid indexed version before acquiring a lock; it locks only on its fallback path (`src/store/log.ts:1576-1596`). Merely removing its catch does not make an ordinary read throw when another process holds the append lock.

**Evidence:** Rung 2, verified source paths. The proposed HTTP behavior has not been run and remains unproven.

**Requested clarification:** Specify error mapping around host construction and mutation for each writer route. State that version GET remains lock-free, or explicitly propose and justify changing that contract. Define the precise stale-index condition for the read fallback test; a held lock alone is insufficient. Test each promised route response, including `retry-after`.

### F3 - Error reporting depends on the log operation that just failed

**Priority:** Medium. **Lands in:** Error Handling, E-LOG-01 and E-LOG-02, lines 491-507; Security Considerations, lines 543-546.

The RFC requires a non-terminal error event for a busy record, and a terminal error event plus detach for a corrupt or fold-refused record. It does not specify what happens when those reporting operations also fail.

Events go through `sendFrame` (`src/modes/sequencer.ts:138-146`), wired to `host.handleFrame` (`src/cli/runtime.ts:236`). Host transactions call `log.append` (`src/store/conversation-host.ts:247-257`), which acquires the same lock and folds the same log before writing (`src/store/log.ts:1243-1248`). A continuing lock timeout can therefore prevent the warning; unchanged corruption prevents the terminal event from being appended. Detach also sends a frame (`src/modes/sequencer.ts:239-242`). The promise that the condition appears in the record has no specified fallback.

**Evidence:** Rung 2, source-backed dependency chain; persistent-failure behavior under the proposed handlers has not been reproduced and is unproven.

**Requested clarification:** Make durable reporting conditional on a successful append. Specify a diagnostic outside the log and unconditional local cleanup when recording or detaching fails. Add a persistent-lock and persistent-corruption oracle that verifies cleanup completes without requiring a writable log.

### F4 - Old demotions do not always have a later event that can heal them

**Priority:** Medium. **Lands in:** C7, lines 370-377; Migration Strategy, lines 446-448; Risk Assessment, lines 483-484.

The compatibility rationale says the demoted send opens a new turn, so the old record's question state heals at the next event. The existing demotion path explicitly permits that send to be rejected or to throw. It then records a rejected disposition, with no new turn guaranteed (`src/modes/host.ts:593-605`). A process can also stop after recording the demotion and before recording the send outcome.

Under the proposed reducer, a pre-RFC demotion without `code` no longer clears the question. In those histories, it can remain open indefinitely. This is a visible compatibility change for a durable record that may never receive another event. The current applied-answer clearing rule (`src/protocol/reducer.ts:760-771`) does not cover rejected sends.

**Evidence:** Rung 2 for the uncovered histories; replay under a modified reducer is unproven. The two existing demotion tests pass, but they do not prove old-record compatibility after the proposed change.

**Requested clarification:** Either preserve old-record clearing through a defined compatibility rule, or explicitly accept the persistent stale-question state. Add replay cases for rejected fallback sends and a record ending immediately after the old demotion error. Do not describe either case as guaranteed to self-heal.

### F5 - A8 has no disposition despite the promise to close every audit finding

**Priority:** Low. **Lands in:** opening scope claim, lines 12-17; Implementation Plan, Phase 0.

The RFC promises a requirement, declined line, or chore for every audit finding. A8 has none. Searching the complete draft for `A8` finds no occurrence, and neither the proposed changes nor the chore list addresses the idle `steer`/`answer` exception.

The audit identifies it at `docs/reports/codebase-audit.md:199-206`. The branch remains explicit at `src/modes/host.ts:647-656`: only a queue input checks for a driver change, even when the session is idle.

**Evidence:** Rung 2, complete draft search and source inspection. No behavior change is proposed or experimentally assessed here.

**Requested clarification:** Give A8 an explicit disposition. Retaining the exception and correcting the documentation is an available answer. Changing which driver receives an idle answer requires its own stated behavior decision; this review does not choose it.

## Cleared

- The full RFC was read, including migration, risks, security, tests, open questions, and references. The validator reports no structural errors or warnings.
- C1 addresses the actual seam mismatch: runtime supplies `readArtifact` at `src/cli/runtime.ts:242`; chat's seam at `src/cli/chat.ts:216-228` omits it. Requiring that method closes this construction gap. This review did not rerun the audit's chat reproducer.
- C3 preserves the current unknown-kind fallback. `classOfEventKind` already treats anything outside the droppable list as lossless (`src/protocol/events.ts:78-81`); classifying `question` and `failure` explicitly does not change their runtime class.
- C7's added event fields fit the existing serializable event payload boundary (`src/protocol/frames.ts:255-270`). This clears payload compatibility, not the replay concern in F4.
- Existing focused checks passed: `bun test test/store/artifact-place.test.ts test/modes/demotion.test.ts`, **7 pass, 0 fail, 23 assertions**. These prove baseline behavior, not an implementation of this RFC.

## Not reviewed

- No implementation, full repository gate, browser session, or live harness lane was run. This is a specification review; the proposed changes do not exist yet.
- C8's entire deletion list was not independently checked for every consumer. C9's child cleanup was inspected but not tested against a process that ignores termination or fails while draining output.
- Historical RFCs were not each reviewed in full. Relevant current source, tests, CONTEXT.md, and audit sections were used to check the draft's claims. Audit counts and all documentation chores were not independently re-audited.
- No cross-family review was performed. This is the skill's default single pass; the originating author's model family was not established.
- Graph verification used search, trace, and snippet tools, followed by direct source reads. Coverage was checked for every cited source and test file. The graph reported a partial parse at `src/cli/runtime.ts:388`; that line and its surrounding function were read directly. Other checked files had matching metadata and no recorded issue. Coverage is best-effort: the graph returned no callers for the closure-based log read, so this review does not use that result as evidence of absence.

# Review: RFC-32 Any-session handoff to Lucid (review-v1)

Reviewer: gpt-6-astra@codex (cross-family; RFC drafted under glm). The reviewer worked in a read-only sandbox and could not write this file; the session lead placed the returned review text here verbatim, minus the reviewer's own delivery preamble. No content was altered.

## What was reviewed

RFC: `docs/rfc/32_any-session-handoff-to-lucid.rfc.md`, status **Draft**.

The RFC has no version field. Snapshot: `unversioned-bc35fd86fc1f`. Full SHA-256:

```text
bc35fd86fc1f86914b335d0b7cf10cb2f7cbbaa009d2c314cceea5f99f1c59c9
```

Checkout: `38d4a322cd44b4fc19a51d1ad67329dd3a6b22b0`, including existing working-tree changes. The RFC digest remained unchanged.

Applied review-rfc, technical-writing, unslop, and the required evidence grading rules. All RFC sections were read. Grade 2 means code and document inspection. Grade 4 means a check called the actual function. These checks used synthetic in-memory inputs. They do not prove the complete proposed handoff.

## Structural results

The validator ran first:

```sh
bun /Users/kevin/.agents/skills/draft-rfc/scripts/validate-structure.ts /Users/kevin/dev/lucid/docs/rfc/32_any-session-handoff-to-lucid.rfc.md
```

Exit status: **0**. Captured output, verbatim:

```text
/opt/homebrew/opt/lua/bin/lua5.5: ...r/luarocks/3.13.0_1/share/lua/5.5/luarocks/core/util.lua:22: unable to generate a unique filename
stack traceback:
	[C]: in field 'tmpname'
	...r/luarocks/3.13.0_1/share/lua/5.5/luarocks/core/util.lua:22: in field 'popen_read'
	...ar/luarocks/3.13.0_1/share/lua/5.5/luarocks/core/cfg.lua:500: in upvalue 'make_defaults'
	...ar/luarocks/3.13.0_1/share/lua/5.5/luarocks/core/cfg.lua:825: in field 'init'
	...llar/luarocks/3.13.0_1/share/lua/5.5/luarocks/loader.lua:21: in main chunk
	[C]: in global 'require'
	/opt/homebrew/bin/luarocks:9: in main chunk
	[C]: in ?
{
  "passed": true,
  "errors": [],
  "warnings": []
}
```

## Findings

### F1. The originating-session connection has no delivery path

**Sections:** Abstract; Introduction; Terminology; Design 1 and 3; Security Considerations. **Grade 2.** End-to-end behavior remains unproven.

The Abstract promises that browser feedback reaches the originating session. Security Considerations says that origin supplies text to a human who runs a local command. Design 1 forbids foreign session IDs. No section defines a return channel into the origin.

`openDrivenConversation` creates a headless source through `openHonoringDriver` (`src/cli/runtime.ts:615`). It does not adopt an arbitrary API thread. Native registration requires process ancestry and independent session proof (`src/store/native-registration.ts:87`).

"Origin," "invoker," and "source" refer to different actors without a specified connection. Define which session receives browser feedback. Specify how the local command reaches that session.

### F2. Existing publication admission blocks the proposed ordinary attach

**Sections:** Design 2 and 3; References. **Grade 4 for admission behavior.** Complete publication-to-worker execution remains unproven.

`publishArtifact` records a native-publication requirement before writing content (`src/cli/artifact-publish.ts:153`). Without binding, managed candidates are empty (`src/store/managed-readiness.ts:36`). Ordinary executor admission also refuses the record (`src/store/conversation-host.ts:1430`).

An in-memory call to `reduceConnection`, followed by `managedCandidates`, confirmed that `publication-requested` changes 1 eligible candidate to 0.

RFC 26 Design 2 forbids converting this requirement into ordinary managed execution (`26_interactive-artifact-conversation-continuity.rfc.md:93`, `:95`). RFC 32 must specify how its operation differs from native publication admission. Adding continuation text and a hold does not resolve that conflict.

### F3. Atomic creation does not make the whole handoff atomic

**Sections:** Design 2; Error Handling; Security Considerations; Implementation Plan. **Grade 2.** Crash behavior remains unproven.

The existing staging operation publishes an empty log (`src/store/store.ts:72`, `:108`). Artifact publication and connection happen afterward through separate operations (`src/cli/artifact-publish.ts:133`, `:153`, `:163`, `:176`).

Artifact admission can refuse after record creation (`src/store/conversation-host.ts:575`). Existing publication preserves saved content when connection fails (`src/cli/artifact-publish.ts:68`).

This does not establish the RFC's "nothing half-made persists" guarantee. Specify the commit boundary for metadata, artifact, and continuation. Specify recovery after commit but before attachment or URL output. The state machine lacks a published-but-unattached state. Phase 1 verification also needs interruption cases.

### F4. Request and retry identities are underspecified

**Sections:** Design 1 and 2; Error Handling; Open Questions. **Grade 2.** Retry behavior remains unproven.

The payload omits the creation key and server origin while claiming the existing request shape. Publication requires `creationId` or `conversationId`. It also requires `serverUrl` (`src/cli/artifact-publish.ts:77`, `:98`).

The creation receipt compares settings and working directory. It does not compare artifact or continuation content (`src/store/creation.ts:20`, `:71`). The RFC does not define a stable continuation input ID. It does not specify how retries behave after that input dispatches.

A whole-document search found **no occurrences of `creationId`, `serverUrl`, or `inputId`**. Design 1 uses the field `continuation`, while Open Question 1 reopens its placement.

Specify the complete request, equality rules, and continuation identity. State whether the operation accepts existing conversations. Specify the handoff and explicit detach command invocations.

### F5. Continuation is an active request, contrary to the security claim

**Sections:** Design 1; Security Considerations. **Grade 4.** The check called the actual context projection and rendering functions. It attempted no malicious execution.

Design 1 makes continuation the first accepted prompt. Security Considerations says handed-off content is quoted reference material, "never instructions."

The projector separates pending input from history (`src/store/conversation-context.ts:140`, `:191`). The renderer places pending text after "The current accepted user request follows," outside the quoted history JSON (`:210`).

An in-memory projection and rendering confirmed that behavior. Specify whether invoking the command authorizes continuation as a task or only imports reference material. Existing artifact-only guidance is model guidance. It does not enforce that restriction through code (`docs/drivers.md:35`).

### F6. Hold timing and detach rules conflict

**Sections:** Design 3 and 4; State Machine; Implementation Plan; Open Questions. **Grade 2.** Lifecycle races remain unproven.

The RFC resets the hold on dispatched input or emitted events. The cited worker resets its timer whenever work is busy. It also has other exit conditions (`src/cli/managed-worker.ts:52`, `:64`, `:72`). Preparation counts as busy (`src/modes/managed-execution.ts:158`).

Design 3 requires detach at a turn boundary. Design 4 requires explicit detach "at once." A silent running turn can cross the inactivity deadline. The RFC does not choose cancellation, completion, or deferred detachment for that case.

Worker expiry calls `abort`. That closes the source and sends `shutdown`, not `yield` (`src/cli/managed-worker.ts:77`; `src/modes/host.ts:1715`). Open Question 2 reopens the already-specified timeout reason.

Specify these transitions. Define the state that supplies the countdown. A source search for `holdUntil|holdRemaining|reviewHold|review.hold|holdMs` found **no matches**.

### F7. Hold expiry does not prove native departure

**Sections:** Design 4 and 5; State Machine; References. **Grade 2.** Live transitions remain unproven.

The RFC requires timeout to show the session gone. It requires later input to resume headlessly with the same ID. RFC 26 Design 6 instead requires confirmed native-owner departure, exact identity and folder, eligible input, and no conflicting reservations (`26_interactive-artifact-conversation-continuity.rfc.md:148`).

Current projection retains "still open" or "owner unknown" after listener expiry (`src/store/connection-view.ts:329`). Resume can also be refused while pending input is preserved (`docs/skill-chat-substrate.md:71`). A held initial continuation may never have launched a session.

Replace the unconditional `DETACHED -> RUNNING` transition with the required admission conditions. Define whether "gone" describes the local holder or native session. Current automatic native worker selection supports only `codex-cli` (`src/store/managed-readiness.ts:68`). Other routes need explicit treatment.

### F8. No-terminal redelivery contradicts uncertain-attempt recovery

**Sections:** Design 3; State Machine; Error Handling. **Grade 4.** The check called the actual outcome and eligibility functions. It killed no process.

Design 3 permits redelivery when a turn lacks a terminal event. Error Handling forbids automatic replay of uncertain started attempts.

`deriveAttemptOutcome` classifies missing terminal evidence as `uncertain` (`src/protocol/execution.ts:505`). `managedCandidates` then blocks automatic dispatch (`src/store/managed-readiness.ts:38`). Synthetic calls confirmed both results.

Distinguish never-dispatched input from an attempt that may have run. Input IDs alone cannot establish that external effects are safe to repeat. Add uncertainty and its explicit recovery route to the state machine.

### F9. The artifact limit counts string units, not bytes

**Sections:** Design 1; Security Considerations; Implementation Plan. **Grade 4 for the reader.** Writer conditions were inspected. The publication CLI was not tested.

The RFC requires rejecting artifact bytes above 1,000,000. Host admission, writing, and reading instead compare JavaScript `.length` (`src/store/conversation-host.ts:575`; `src/store/log.ts:1535`, `:960`).

A synthetic HTML entry containing 400,000 copies of `界` had **400,041 UTF-16 code units and 1,200,041 UTF-8 bytes**. `readArtifactAtOffset` returned it intact.

Specify the unit. State whether this introduces byte-based admission. Phase 1 needs a multibyte oversize case. The continuation codec also measures UTF-16 code units rather than an unspecified Unicode character count.

### F10. Error recovery promises unsupported automatic release

**Sections:** Design 2; Error Handling; State Machine. **Grade 2.** Running-worker recovery remains unproven.

The RFC says E-HUB-06 work dispatches when its budget or prerequisite clears. Existing eligibility automatically rechecks changed prerequisites for E-HUB-03 and E-HUB-04. It does not do this for E-HUB-06 (`src/store/managed-readiness.ts:140`). Context failures require recorded recovery actions (`docs/architecture.md:224`).

The normative refusal list also omits creation failures already produced by the reused path. These are E-HUB-01 for availability and E-HUB-02 for conflicts (`src/store/creation.ts:9`, `:33`, `:67`).

Specify recovery for the held initial continuation. Include those creation failures. Clarify whether saved artifact success can coexist with failed continuation. Specify how the command reports that result.

## Cleared

These are checked portions. They do not clear entire sections that contain findings.

- **Introduction, exclusions:** transcript import, dual writers, remote operation, and multi-user exclusions match existing scope.
- **Terminology:** referenced core terms exist. No unused newly defined term was found. Actor ambiguity remains F1.
- **Design 1, continuation limit:** the actual codec accepted 1,000,000 code units. It refused 1,000,001 without truncation.
- **Design 3, protocol checks:** reducer checks confirmed initial epoch 1, `lease-held` during a live lease, takeover epoch 2, and `stale-epoch` rejection afterward. OS lock contention was not tested.
- **Security Considerations, existing mechanisms:** mode-0600 secret creation, native ancestry/session verification, and selective context projection were inspected. This does not clear F5.
- **References, local targets:** cited source files and normative documents exist. RFC 26 Design 6 and 8 resolve.

At least 3 MUST statements were checked:

| Requirement | Result |
|---|---|
| Continuation MUST NOT exceed `TEXT_MAX` | Boundary checks passed in memory. |
| Artifact bytes MUST NOT exceed the limit | A multibyte entry exceeded the byte limit and was accepted; F9. |
| Creation MUST be atomic | Existing transaction covers initial record only; F3. |
| Second attach MUST receive `lease-held` | Passed for a live protocol lease. |
| Source MUST remain attached for the hold | Cited worker has different timing and exit rules; F6. |
| Timeout MUST show session gone | Existing ownership projection can remain alive or unknown; F7. |

The initial in-memory test stopped on an invalid synthetic action ID. After replacing it with a valid UUID, the remaining checks passed. This was a test-input correction.

## Not reviewed

- **Unread RFC sections:** none.
- **Motivation and Alternatives, historical evidence:** GitHub #299 and #300-305 could not be verified. `gh-axi` failed to connect to GitHub. Web retrieval also failed. The local decision ledger was read but does not replace ticket evidence.
- **Implementation Plan, runtime acceptance:** no publication round trip, crash injection, filesystem transaction test, multiprocess lock test, full suite, or live harness run. Filesystem writes were unavailable.
- **Design 4 and 5, operational/UI acceptance:** no measured heartbeat tuning, 30-minute hold, browser countdown, accessibility, restart, or native-departure test.
- **Cross-family provenance:** the RFC identifies a human author but no drafting model family. Cross-family independence could not be verified.
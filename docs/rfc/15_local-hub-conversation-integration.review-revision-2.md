# Review: RFC-15 Local hub conversation integration, revision 2

**What was reviewed.** `docs/rfc/15_local-hub-conversation-integration.rfc.md`, revision 2, status Draft, dated 2026-09-07. Plus the Findings and Cleared sections of `docs/rfc/15_local-hub-conversation-integration.review-revision-1.md`. Scope: resolution of the revision-1 blockers (F1-F7) and the new execution-envelope contract. Not a fresh full-source audit.

Evidence levels below use the ladder in `~/.agents/skills/blast-radius/references/EVIDENCE-LADDER.md`. Level 2 means a cited line in the document or the code. Level 3 means execution was traced.

**Structural results.** `bun ~/.agents/skills/draft-rfc/scripts/validate-structure.ts docs/rfc/15_local-hub-conversation-integration.rfc.md`, verbatim:

```
{
  "passed": true,
  "errors": [],
  "warnings": []
}
```

---

### Findings

**F1. Major - R5 line 123 closes the execution-fact kind list. R7 line 149 requires a seventh kind that list does not contain.** Evidence level 2.

R5: "The kinds are `requested`, `held`, `retry-authorized`, `fresh-authorized`, `attempt-started`, and `attempt-ended`." That is an exhaustive list. The same sentence requires "an input ID, attempt number, kind, and validated kind-specific payload" on every fact. R7 line 149 then says: "Persist coverage in internal coverage-confirmed facts keyed by harness and actual native session ID." That kind is absent from the list, and its key is harness plus native session ID, not input plus attempt. This is the key mismatch revision-1 F5 named, and the F5 disposition at line 262 claims it resolved.

Consequence: a worker resumes claude session `S` and offers record range `(120, 180]`. The turn is acknowledged but not completed, so `attempt-ended` cannot carry the confirmation and a standalone `coverage-confirmed` entry is required. A reducer built to R5's closed list rejects it as an unknown kind with no valid payload schema. The confirmation is lost. The next resume re-supplies from 120, which breaks R7 line 151's "MUST NOT create duplicate user inputs". The RFC never states whether `coverage-confirmed` extends the R5 family or is a separate family with its own key.

**F2. Major - R2 line 72 and the R9 driver row forbid the turn that R5, R6, and the State Machine require when a prerequisite hold clears.** Evidence level 2.

R2 line 72: "A metadata write MUST NOT create an artifact version or trigger an agent turn." R9 line 173, the `POST /driver` row: "no turn starts from changing a setting alone."

Against these: R5 line 123, "A cleared prerequisite hold becomes pending". R6 line 133, "on its reconciliation pass, request workers for eligible accepted hub inputs with no executor". State Machine line 200, "Held | Applicable retry, fresh, or folder remedy authorized for current attempt | Pending". The error table names the same path: E-HUB-03 recovery is "correct the named selection/config", E-HUB-04 is "Select folder for the same pending input".

Consequence: a submission is held E-HUB-04. The person selects a folder through `POST /location`, which is a metadata write. R5 and R6 make the input eligible, and reconciliation launches a worker within five seconds. R2 line 72 says that MUST NOT happen. An implementer who honors R2 leaves the input pending permanently, because R9's recovery route accepts only `retry` and `continue-fresh`, and line 182 scopes both to a known startup or external failure. A folder hold is not one. This is revision-1 F3's deadlock, reintroduced by a different sentence. The RFC already carries the correct narrow phrasing one row away, at line 174: "Saving location alone creates no new input." The two broad sentences are the ones that conflict.

**F3. Major - an attached source that lacks `managed-input-v1` has no state, no cause code, and R6 states the opposite delivery rule.** Evidence level 2.

Migration line 295: "The host records the declaration for the current participation and does not deliver managed inputs to a source lacking it." R6 line 135: "A live attached driver receives inputs through the record." The State Machine's only Held trigger for ownership is line 193, "Folder/settings/context unavailable, or live unattached terminal owner". An attached, live, old-binary source is none of those three. No E-HUB code covers it. E-HUB-03 covers the person's config or selection, not a peer's declared capability.

Consequence: an old-binary interactive terminal holds the record. The person submits from the hub. Acceptance succeeds and the receipt returns. The host must not deliver, the old reader skips the entry anyway, and R6 line 135 says delivery happens. The hub shows Pending with no cause and no action. The two real remedies stated in Migration line 295, upgrade the other binary or wait for it to exit, are not in R9's action set.

**F4. Moderate - RFC 15 line 127 separates automatic worker restart from "explicit source attachment", and nothing in the protocol carries that difference.** Evidence level 3 for the protocol gap.

Line 127: "Automatic worker restart or reconciliation is not an explicit source attachment and MUST NOT reset suppression or launch solely to retry that hold." RFC 14 line 182 is the rule being classified: "A new explicit source attachment also permits one bounded recovery attempt for still-pending inputs." The attach frame carries `profile`, `harness`, `secret`, `version`, and optional `resumeFrom` (`src/modes/sequencer.ts:90-101`; field set at `src/protocol/frames.ts:294-304`). It carries no marker for managed against human-initiated, and revision 2's Migration capability list adds none.

Consequence: a managed headless-turn worker exits at idle and relaunches for other eligible work, which R6 line 137 permits. Its attach is identical to a person running an explicit attach. The implementation then either grants RFC 14's bounded recovery attempt on every managed relaunch, which is the suppression reset line 127 forbids, or grants it on none, which makes RFC 14's explicit-attachment trigger dead for every hub record. Line 127's "MUST NOT launch solely to retry that hold" prevents the tight spawn loop revision-1 F6 warned about, but not this branch.

**F5. Moderate - `attempt-started` is appended before dispatch, so a crash in the pre-spawn window is classified Uncertain, blocks the conversation, and offers only a recovery that asserts side effects which did not occur.** Evidence level 2.

State Machine line 194 requires "append attempt-started before external dispatch". Line 197 maps "Worker loss with no confirmed outcome" to Uncertain. Line 204 states an uncertain attempt "blocks further execution for the conversation until explicitly resolved". R9 line 182: "Do not offer Retry into an uncertain native transcript", and continue-fresh "requires acknowledgement that partial effects may already exist" plus "a direction to inspect current workspace state". R5 line 125's escape, "A durable terminal frame tied to the same turn ID may establish that outcome without re-dispatch", cannot fire, because no process ever started.

Consequence: the worker appends `attempt-started`, then the machine reboots before hcn is spawned. Nothing ran. The conversation is blocked, the cheap remedy is prohibited, and the only offered path discards the native session that R7 exists to preserve, behind an acknowledgement of effects that did not happen. Line 196's "Proven no execution" branch needs evidence the crash destroyed. The RFC declines exactly-once execution on purpose, which is sound, but it does not state that this window is a known cost, and it does not offer a spawn-confirmation marker that would narrow it.

---

### Cleared prior blockers

Checked in revision 2 and found resolved. A later reviewer need not repeat these.

- **F1, held-input scheduling.** Line 204 now reads "skipping held inputs exactly as RFC 14 requires", and the head-of-line sentence is gone. The conversation-wide block is scoped to an uncertain external attempt only, and is separated from a pre-dispatch comparison hold. RFC 14's automatic release path is reachable again.
- **F2 and F7, the context export.** R8 line 159 places the bundle "copied outside the record, following ADR 0008's offered-attachment path discipline", forbids offering the record directory or any path inside it, makes retrieval a CLI subcommand whose argument is the bundle location rather than a record root or token, and states it "performs no HTTP request and provides no unauthenticated server endpoint". Path traversal and symlink escape tests are required. ADR 0008 is now in the normative references at line 318.
- **F3, log-derived eligibility against sidecar remedies.** Terminology line 39 defines eligible input as execution facts combined with "current folder metadata, saved preferences, capability evidence, ownership, and artifact state under the append lock", and adds "A historical hold records an observation, not an immutable truth." R5 line 123 gives the location and settings save a lock-taking, validated, atomic sidecar replacement, followed by a reconciliation request, with a server sweep covering the crash window. The contradiction is gone. What remains is F2 above, which is a different sentence.
- **F4, identity addressing.** R1 line 55 routes every read, attachment, artifact write, settings, input, and launch through one identity-to-directory index. It re-verifies metadata under the record lock before mutation, returns not-found on a missing ID and E-HUB-01 on an ambiguous one, and states "Never reconstruct a record path by joining the ID to the root or implicitly mint a replacement." R9 line 165 stops existing-record routes from creating.
- **F5, coverage storage.** Partly cleared. R7 line 149 now specifies the writer (executor only, under the append lock), the key (harness plus actual native session ID), the payload (source range, supplying attempt or turn ID, acknowledgement evidence), idempotency, offered-but-unconfirmed retention in `attempt-started`, and the uncertain-range rule. What remains is the list gap, F1 above.
- **F6, comparison hold recovery.** Line 127 keeps E-COMP-07 and RFC 14's newer-artifact and explicit-source-attachment triggers, forbids a generic Retry or Resume, persists suppression with the managed hold, and scopes E-HUB-06 to non-comparison context preparation. Line 182 states the explicit-action rule does not override RFC 14's event-driven recovery. What remains is F4 above.
- **The revision-1 clearing of two-line append atomicity is correctly withdrawn.** Revision 2 lines 121 and 287 reject it on the grounds the prompt names: exception rollback cannot reach abrupt process loss after one complete line reaches disk. The single-envelope replacement holds at evidence level 3. `src/store/log.ts:164-180`: `validEntry` checks only `{v, at, src}`, and `knownEntry` narrows against `ENTRY_SOURCES` at `src/store/log.ts:143-151`. An entry with `src: "managed-input"` is envelope-valid and unknown, so an old reader carries its bytes, never folds it, and cannot enqueue the prompt. Line 295's further requirement is also needed and correct: the current delivery cursor is a byte offset over good bytes (`src/modes/host.ts:1368-1370`, `collectEffects` and `advanceCursor` on `batch.goodBytes`), so an old reader advances past a managed entry it skipped. That is why "Their delivery cursor MUST NOT control managed eligibility; compatible readers rebuild it from the managed facts" is required.
- **Applied-disposition recovery.** Line 121 derives the new authorized attempt from execution facts "even if the input already has an applied disposition", and forbids enqueuing another input or a second initial-applied disposition. Line 125 forbids automatically repeating possible side effects. Line 182 preserves the original input identity and records a new attempt. Identity is kept without silent replay.
- **Alias, budget, and tool-isolation prerequisites.** Explicit. R3 line 97 carries hcn's alias map through Lucid's harness vocabulary and driver-choice projection, resolves before first start, saves the concrete result, and forbids recreating aliases above the seam. R8 line 155 requires a supported input bound and accounting method, executable and model provenance, native-resume budget handling, and enforceable tool-free or read-only modes through hcn's public contract. It forbids a mirrored model table, and gates default managed execution on deterministic contract validation of the built-in Claude/Opus route.

### Limits

- Revision 2 only. Revision-1 Major findings F8-F20 and suggestions S1-S8 were not independently re-verified. Their dispositions at lines 265-285 were read, not tested.
- No source audit beyond four targeted snippets: `src/store/log.ts:143-180` and `:545-573`, `src/protocol/reducer.ts` seq minting by grep only, `src/modes/sequencer.ts:85-109`, and `src/modes/host.ts:1345-1371`. No claim above asserts that no other caller exists.
- Graph discovery was unavailable this session. `codebase-memory-mcp` reported CONNECTION_CLOSED at startup.
- Nothing was executed except the structural validator. No finding reached evidence level 4 or 5. No live harness run, no service started, no file edited.
- RFC 14 was consulted only at the two lines cited, line 182 for suppression scope. Its other sections were not re-read.
- The browser client, hcn's own source, and `docs/skill-chat-substrate.md` were not read.

Review attribution: Claude Opus 5 via hcn, high effort. Run in-session. No subagent or delegated route was used.

Review attribution: Claude Opus 5 through hcn, high effort, route opus-5@claude.

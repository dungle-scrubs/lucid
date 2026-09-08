## Review: RFC-19 "Codex native context management", version 1 (Draft)

**Reviewed:** `docs/rfc/19_codex-native-context-management.rfc.md` v1, status Draft, against this worktree.
**Deviation from the review-rfc skill:** no `docs/rfc/19_*.review-v1.md` artifact written; the caller asked for a returned review with no file edits.

Every finding below is graded on the evidence ladder. Level 2 means I pointed at code or library source. Level 3 means I followed execution through it. Nothing here reached level 4 or 5, because this session has no shell.

### Structural results (verbatim, `/tmp/lucid-codex-rfc-validation.log`)

```json
{
  "passed": true,
  "errors": [],
  "warnings": [
    "Line 65: \"optional\" appears normative but is not capitalized"
  ]
}
```

Line 65 sits in Open Questions ("the earlier optional policy recommendation"). That is an adjective, not RFC 2119. False positive.

---

### Findings

**R1 - high - §Terminology, §Motivation, §Design. The premise that the harness owns compaction and rejects what it cannot accommodate does not hold for the one request shape lucid produces.** (level 2)

`/tmp/lucid-codex-01534-source/codex-rs/core/src/session/turn.rs:167-170` carries an in-source TODO: pre-turn compaction runs before context updates and the new user message are recorded, and estimating pending incoming items to compact preemptively is not done. `run_pre_sampling_compact` fires at `turn.rs:171`, before the prompt is in history. Lucid's native route submits one large staged user message - the whole rendered record plus every current artifact's bytes (`src/modes/managed-preparation.ts:285-292`). That is the case Codex 0.153.4 does not pre-compact for. Auto-compaction is real (`turn.rs:10-13, 425-446`), but it protects an accumulating thread, not a single oversized submission. §Terminology line 25 and §Motivation should separate what is delegated (in-thread growth) from what is not (the staged request itself). This is not a reason to block Codex. It is a reason the guarantee is narrower than the RFC states.

**R2 - medium - §Error Handling, §State Machine. An over-window native failure has no convergent recovery; the only offered action re-sends more.** (level 3, traced)

A failure arriving after any message, token, tool, or question event sets `mayHaveRun` (`src/modes/managed-execution.ts:150-153`). `deriveAttemptOutcome` then returns `failed-after-start` (`src/protocol/execution.ts:509-520`), and `recoveryPolicy` offers `["continue-fresh"]` only (`src/protocol/execution.ts:124-126`). `continue-fresh` forces `native.kind = "fresh"` (`managed-preparation.ts:118-122`), and a fresh capture starts at boundary 0 instead of `confirmedContextThrough` (`managed-preparation.ts:129-134`). The next prompt is larger than the resumed one that just failed. With preflight and summarization removed on this route, nothing makes the next attempt smaller. §Security line 53 mentions the rejection. §Error Handling specifies no terminal state, no distinct reason code, and no "this cannot fit" signal to the user. The RFC should say what a repeated over-window native failure becomes.

**R3 - medium - §Design line 37. Eligibility is decided per harness and executable, never per model; the native route drops lucid's only model-agreement check.** (level 2 and 3)

On the preflight route `countContext` compares the model the harness reports against the selected model and returns `model-divergence` (`src/harness/context-accounting.ts:56-61`), which becomes an E-HUB-03 settings hold (`src/modes/context-preparation.ts:34-46`). The native route runs no count, so that check disappears. `inspect --runtime` only proves hcn accepted the `--model` flag (`src/harness/hcn-runner.ts:166-184`). The declaration is harness-wide (`hcn-codex-adapter/src/knowledge/codex.ts:87`) while the descriptor lists five models with different windows (`codex.ts:63`). The RFC requires exact executable and version agreement and says nothing about the model. Either state plainly that model agreement is unverified on this route, or require it.

**R4 - medium-low - §Design line 35. The guard compares `modes` by exact array equality, so a widened hcn declaration silently disables Codex.** (level 2)

`src/harness/inspection-facts.ts:4-13` requires `modes.length === 1 && modes[0] === "headless-turn"`. "Unknown kinds or modes ... MUST retain preflight behavior" reads as a membership test. If hcn later declares `modes: ["headless-turn", "headless-session"]`, headless-turn support is unchanged, but lucid reverts Codex to preflight - blocked - with no diagnostic. Either write the exact-array rule into the RFC, so the hcn side knows never to widen the array, or specify membership plus all-modes-known.

**R5 - medium-low - §Error Handling line 49. The rollout sentence covers E-HUB-03 holds only, one line after the RFC mentions E-HUB-06.** (level 3, traced)

`managedCandidates` re-admits a held execution only for E-HUB-03, E-HUB-04, and E-COMP-07 (`src/store/managed-readiness.ts:62-66`). E-HUB-06 holds wake only through an explicit retry authorization (`src/protocol/execution.ts:111-121`; default actions `["retry"]` at `managed-preparation.ts:106-110`). The common case is fine: hcn returns `unsupported-adapter` for a null `contextInspection` (`hcn-codex-adapter/src/cli/inspect-context.ts:56-57`), which `measured()` maps to E-HUB-03. But a Codex prompt held under E-HUB-06 - probe timeout, transport, cancelled - will not move when settings are re-saved. Say the rollout covers E-HUB-03, and that E-HUB-06 holds need retry.

**R6 - low - §References line 69. `docs/drivers.md` now states both policies for the same selection.** (level 2)

`docs/drivers.md:269-270` still reads "Its verified accounting adapter currently supports Claude headless-turn. Other selections stay held until accounting is supported." The amendment at `docs/drivers.md:289-298` says Codex headless-turn runs without accounting. The RFC claims drivers.md is amended but supplies no replacement text for the contradicting sentences.

**R7 - low - §Implementation Plan. The `HCN_MIN_VERSION` bump that the "older hcn builds" clause depends on is missing.** (level 2)

The version floor is enforced once, at binary resolution (`src/harness/node-deps.ts:61-62`, `src/harness/version.ts:12` = `"0.6.4"`); the headless-turn route never rechecks it. An older hcn omits the field, so Codex reverts to preflight - blocked - and nothing points the user at the hcn version. The plan says the local server consumes the verified checkout, but not that the floor moves when the package release lands.

**R8 - low - test coverage. The Error Handling claim is the one part with no oracle.** (level 2)

`test/modes/managed-preparation.test.ts:798-849` covers mode gating, `accounting === null`, and offer retention. `:851-895` covers the fence under unverified, settings-changed, and cancelled. No test exercises a native context failure at runtime and asserts the resulting outcome kind and recovery actions - the exact claim at RFC line 39 and `drivers.md:295-297`.

**R9 - low - §Design line 37 wording.** "MUST render the complete selected context" conflicts with the resume trim: capture starts at `confirmedContextThrough` (`managed-preparation.ts:129-134`, `src/protocol/context-coverage.ts:138-142`). `drivers.md:292` uses the precise word: "complete **captured** context". Match it, or a reader will implement full-history-on-resume. (level 2)

---

### Cleared

- **Native resume keeps the session ID.** Codex emits the same `thread_id` on `exec resume` as on establish: `01a08089-5396-7bb0-bf7a-bc07b83b1eb2` appears in both `hcn-codex-adapter/test/fixtures/codex-0.153.4/establish.ndjson:1` and `resume.ndjson:1`. So `contextCoverage`, keyed by harness and sessionId (`context-coverage.ts:136-142`), carries across turns, and RFC line 39 is achievable. (level 2, from a recording)
- **Preflight routes stay strict.** The flag is read only from the descriptor dump (`hcn-runner.ts:246-252`). Every non-Codex descriptor omits it, so `prepareContext` runs unchanged (`managed-preparation.ts:285-292`). No env override, no global bypass, no harness-name table in the mode layer.
- **Exact version agreement.** `verifiedExecutable` compares for equality, not ordering (`inspection-facts.ts:30-40`), and gates the native branch through the existing check at `managed-preparation.ts:242-243`. Codex carries `verifiedAgainst: "0.153.4"`.
- **Ordering and fence.** capture → comparison → candidate recheck → settings → native continuity → inspect → render → `writePreparedExecution(..., captured.stamp)` matches §Design. `managed-preparation.test.ts:851-895` asserts attempt 0 and no orphan offer under all three abort conditions.
- **Prompt preservation.** Input text lives in the log, and no native failure path rejects or rewrites it. `refusePrepared` (`src/modes/host.ts:603-625`) ends the source with a terminal error and leaves the input queued for replay. (level 3)
- **Rollout mechanism works.** Re-saving unchanged settings bumps `revision` (`driver-preference.ts:179`), which is inside the E-HUB-03 prerequisite hash (`managed-readiness.ts:20-24`), so those holds become candidates again. (level 3)

One shape difference, below the finding threshold: the native branch calls `render()` bare (`managed-preparation.ts:287`) instead of through `createContextPreparer`'s normalizer (`context-preparation.ts:297-306`). A render failure that is not a `ContextPreparationError` escapes preparation instead of becoming a durable E-HUB-06 hold. `host.ts:1077-1084` re-wraps it one level up, so the prompt still survives. Only the shape of the failure changes.

### Not reviewed

- **Nothing was executed.** This session has no shell: no `bun run check`, no validator re-run, no live Codex. Every finding is level 2 or 3.
- Commit `c4dad85`, cited in §References, is unverified.
- The Codex over-window error path beyond `turn.rs`; hcn's own gates and skill audit; `docs/adr/`.
- **The implementation landed in this worktree during the review.** `src/harness/inspection-facts.ts`, `hcn-runner.ts:246-252`, `managed-preparation.ts:285-292`, `docs/drivers.md:289-298`, and the tests all appeared mid-pass. Findings are against the RFC text; where code exists, I checked the RFC against it. A re-read may show more has moved.

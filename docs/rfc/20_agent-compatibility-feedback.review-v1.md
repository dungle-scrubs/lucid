# Review: RFC-20 Agent compatibility feedback, version 1

## What was reviewed

- RFC: [20_agent-compatibility-feedback.rfc.md](20_agent-compatibility-feedback.rfc.md), version **1**, status **Draft**, all sections read.
- SHA-256: `eb164a115dbd9c8120400908c1dc77ca682b782819c4fcb9261575b08ae6e5ab`.
- Reviewer: **opus-5@claude**, one independent reviewer from a different family than the RFC author. The same reviewer reconsidered its initial findings after the parent checked the evidence. Codex consolidated this document from that review and its final dispositions; it did not revise the RFC.
- Source basis: checkout `6757d5259a3a56202394f2c302d371e9e0648f2b` plus existing local changes. Current source was read directly because graph coverage is stale.
- Fixed user scope: error/warning feedback, manual package repair, runtime restart, and existing retry behavior. No updater, Check again, Ready/Resume flow, automatic switching, or changed execution/recovery policy.

The final pass retains **eight findings: four moderate and four low**. No high-severity finding survived verification. Original finding identifiers are retained so the verification history remains clear. Findings below identify specification decisions or ambiguities; they do not claim the unimplemented feature has failed an end-to-end test.

## Structural results

Validator output, verbatim:

```json
{
  "passed": true,
  "errors": [],
  "warnings": []
}
```

Command: `npx --no-install tsx /Users/kevin/dev/skills/skills/engineering/draft-rfc/scripts/validate-structure.ts docs/rfc/20_agent-compatibility-feedback.rfc.md`.

## Findings

### F3 - The no-repeat-check rule conflicts with existing recovery refresh

**Severity: moderate. Evidence: rung 2 for source; rung 3 for the traced polling interaction, not runtime-proven.**

**Location:** RFC §Check boundaries and lifetime, line 82; §Introduction, line 23; §Presentation and repair text, line 129.

Line 82 requires an identity-keyed observation shared across requests and forbids repeated probes from periodic reads. The Introduction and presentation section preserve existing recovery behavior. The RFC does not identify an existing component affected by both requirements: `src/server/recovery-availability.ts`.

That component probes fresh support at line 58 and, when applicable, native-resume support at line 76. It caches the result for 1500 ms at lines 36-37 and 93. `src/server/server.ts:586-587` calls it during a conversation read when an execution entry offers recovery actions. The conversation polls every 500 ms (`src/server/client/app.tsx:119`). With an unchanged selection, polling can therefore trigger another inspection after the TTL.

The cache is **per server and key**, shared across tabs through `createHubSettings` (`src/server/server.ts:214`, `src/server/hub-settings.ts:170`). The initial review's per-tab amplification claim was incorrect and is withdrawn.

Applying the RFC's process-lifetime memo to recovery availability changes when existing recovery controls become available. Leaving its TTL intact violates an unqualified reading of the no-repeat-check requirement.

**Suggested resolution:** state whether the new diagnostic memo excludes recovery-availability probes or replaces their refresh policy. Name the component and preserve or explicitly account for the existing recovery behavior. Do not let a general caching requirement silently decide this.

### F4 - Closed-panel notice placement and announcement ownership are unspecified

**Severity: moderate. Evidence: rung 2, not runtime-proven or browser-rendered.**

**Location:** RFC §Presentation and repair text, lines 113-115.

Line 113 puts selection notices beside the selected driver information while requiring them to remain discoverable with the conversation panel closed. Today the selected driver controls and their settings error sit in the composer (`src/server/client/app.tsx:1211-1225`), inside the conversation pane. Closing it applies `aria-hidden` and `inert` (`src/server/client/conversation-panel.tsx:53-59`). A notice added only beside those controls is inaccessible while closed.

The requirement can be implemented, but it leaves a visible design choice unresolved: move the notice outside the panel, duplicate it there, or expose a notice through the panel toggle. The phrase “the existing accessible error mechanism” at line 115 also names no concrete owner. The current code has individual alert/status elements and live regions, rather than one shared announcer.

**Suggested resolution:** identify the closed-panel location and the owner of announcement deduplication. A separate shared announcer is one option, not a requirement inferred by this review. Preserve the settled requirement that a notice does not reopen the panel or move focus.

### F5 - “Package-local” is too broad to determine the correct repair

**Severity: moderate. Evidence: rung 2 for the ambiguity; rung 4 for the existing resolver cases covered by the parent's baseline tests. The proposed repair text was not runtime-tested.**

**Location:** RFC §Authority and version policy, line 61; §Presentation and repair text, line 117.

Line 117 recommends updating Lucid and its pinned dependency for “package-local HCN.” The resolver has six source labels: `env`, `package-dependency`, `node_modules`, `node_modules(executable)`, `node_modules(cwd)`, and `path` (`src/harness/node-deps.ts:45-71`). The wording does not distinguish Lucid's dependency from another directory's dependency.

In particular, `node_modules(cwd)` resolves HCN under the process working directory (`src/harness/node-deps.ts:68-69`). If higher-priority candidates are absent, that can be an unrelated project's package. Updating the installed Lucid package need not change that selected executable. The ambiguity can recreate the wrong-installation advice this feature is intended to remove.

**Suggested resolution:** define repair categories from resolver provenance. Identify the owning installation or folder for each `node_modules*` result instead of treating every local package as Lucid's bundled dependency. Continue showing the selected absolute path when available.

### F7 - Diagnostic and admission evidence need a rule if verified versions disagree

**Severity: low. Evidence: rung 2; divergence is theoretical and not runtime-proven.**

**Location:** RFC §Authority and version policy, lines 63-65.

Line 65 requires detected and verified versions from the same runtime inspection, while preserving existing execution gates. Today the runtime dump's `verifiedAgainst` is used for resume validation but is not retained on runtime facts (`src/harness/hcn-runner.ts:215-226`, `src/harness/runner.ts:46-49`). The general `facts.verifiedAgainst` comes from a separate cached descriptor inspection (`src/harness/hcn-runner.ts:232-236,262`). Managed preparation and recovery availability compare the executable against that cached value (`src/modes/managed-preparation.ts:246`, `src/server/recovery-availability.ts:60,78`).

Adding the missing runtime field is ordinary implementation work, already implied by the RFC. The remaining question is which evidence explains an admission refusal if the cached and runtime verified values differ. A notice could otherwise name a different comparison than the one that caused the refusal. Normally both observations come from the same HCN installation and agree.

**Suggested resolution:** specify how gate evidence and diagnostic evidence stay consistent, or how their disagreement is reported. Do not silently change admission policy to resolve a presentation discrepancy.

### F8 - Opening a saved interactive selection has no explicit diagnostic policy

**Severity: moderate. Evidence: rung 2, not runtime-proven.**

**Location:** RFC §Check boundaries and lifetime, lines 75 and 78.

The saved-selection row covers the selected **managed** harness. The interactive row covers a human-owned source **attaching**. Neither explicitly covers opening or changing a saved `interactive` preference.

That is a supported preference (`docs/drivers.md:121-123`, `src/server/hub-settings.ts:32`). Runtime inspection accepts only the two headless profiles (`src/harness/runner.ts:189-193`). The existing recovery helper substitutes `headless-turn` for an interactive preference when assessing recovery (`src/server/recovery-availability.ts:47`), which is a different purpose from inspecting a living interactive source.

An implementer can either omit a selection diagnostic or copy that substitution and report a headless route as though it described the selected interactive process. These produce different feedback.

**Suggested resolution:** explicitly state that a saved interactive selection gets no native-executable selection diagnostic from this probe, while applicable HCN runtime notices remain available and attachment keeps its own checks. Do not infer the running interactive process's version from PATH or a substituted profile.

### F9 - Sanitization scope for the existing settings error needs clarification

**Severity: low. Evidence: rung 3, traced but not runtime-proven.**

**Location:** RFC §Diagnostic contract, lines 90 and 105; §Security Considerations, line 159.

The new `compatibility` list shares a response with `conversationSettings.error`. Raw inspection stderr currently becomes a `HarnessRefusal` message (`src/harness/hcn-runner.ts:188,244`), passes through `resolveSettings` (`src/server/hub-settings.ts:43`), and is copied into that existing field (`src/server/hub-settings.ts:156-164`). It is returned by the conversation endpoint and rendered as the settings error.

The RFC defines a diagnostic broadly enough to include this field, but its concrete schema names only the new list. One reading applies the new length/control-character rules to both surfaces; another leaves the existing message untouched. Preserving existing **fields and status behavior** at line 105 does not require preserving their raw text values. The initial review's stronger preservation-conflict claim is withdrawn.

**Suggested resolution:** say explicitly whether all compatibility-related error messages, including the existing settings error and execution reason, use the same safe rendering contract. Preserve unrelated errors' classifications.

### F10 - Retained startup errors can contradict a later successful worker

**Severity: low. Evidence: rung 3 for process separation; the repaired-without-restart scenario is not runtime-proven.**

**Location:** RFC §Check boundaries and lifetime, lines 84-86; §Error Handling, line 155.

The browser retains its installation observation until restart. Managed workers are independent processes (`src/cli/managed-worker.ts:13-15`) and construct a runner with their own installation check (`src/cli/runtime.ts:386`). If packages are repaired without restarting the browser runtime, a later worker can succeed while the browser retains an error saying agent work cannot start.

The RFC covers a worker whose failure differs from the browser observation, but not this success case. It already declares changing packages under a running runtime unsupported; this finding does not reopen that decision or request a refresh control. It asks how retained feedback identifies itself as a past observation.

**Suggested resolution:** label the notice as the runtime's startup observation and clarify that later worker success does not refresh it. Avoid an unconditional present-tense claim that current work is impossible when the notice represents earlier evidence.

### F11 - Pin drift has no defined equality rule

**Severity: low. Evidence: rung 4 for the comparator results below; no proposed drift detector exists to runtime-test.**

**Location:** RFC §Authority and version policy, line 63; §Diagnostic contract, line 102.

The normative phrase “differs from the pin” does not specify exact string equality or the existing numeric comparison. `assertHcnVersion` returns trimmed output (`src/harness/node-deps.ts:79`), while `compareVersions` normalizes and truncates it (`src/harness/version.ts:16-31`).

The parent invoked the real `compareVersions` with pin `0.6.5`. It returned zero for `v0.6.5`, `0.6.5 (build 12)`, `hcn 0.6.5`, and `0.6.5-rc.1`. Exact string comparison differs for each. The reviewer also ran the pinned binary's version probe, which reported bare `0.6.5`; current pinned output does not expose the ambiguity.

**Suggested resolution:** define accepted version syntax, normalization, and equality for the drift warning. Keep that decision distinct from the existing floor policy. In particular, do not inadvertently erase a prerelease distinction or treat malformed output as a verified match.

## Implementation notes and withdrawn objections

The reviewer reconsidered these against the rule that code failing an already-clear proposed requirement is not itself an RFC defect.

| Original finding | Final disposition |
|---|---|
| F1: synchronous startup probe | Implementation note. Lines 80 and 135 already forbid blocking record reads. A new async helper or off-thread probe can satisfy this without changing every constructor. The isolated `spawnSync` probe proves only that primitive's blocking behavior, not a failure of this RFC. Pending diagnostics sharing an empty-list representation is a minor residual the reviewer did not press because line 105 forbids an all-compatible claim. |
| F2: hub does not fetch defaults today | Implementation note. Line 107 already mandates runtime feedback on hub entry. The client needs a fetch or equivalent route; the existing absence does not contradict the specification. The reviewer recommends making that wiring explicit in the implementation ticket. |
| F6: handshake failure drops installation identity | Implementation note. Lines 63, 90, 109, 117 and 147 already require the richer facts. Update the constructor call at `src/harness/hcn-runner.ts:421`, typed error fields, and the test at `test/harness/hcn-bin.test.ts:115-117` that currently expects generic `bun install` advice. |
| F12: `minimum` versus HCN floor | Withdrawn as a finding. The mapping is understandable; an explicit glossary mapping is editorial only. |
| F13: driver documentation mentions 0.6.4 | Withdrawn as an RFC finding. The phrase “pinned hcn 0.6.4” is stale against the current pin, but capability-introduction references and illustrative RFC examples are not themselves contradictions. Step 4 already covers driver-document updates. |

## Cleared

- The structural validator passes with no errors or warnings. All **18 local links** resolve.
- The stated distinction between an HCN floor, an exact package pin, and harness verification matches the inspected code. A pin warning need not add an execution gate.
- The Motivation accurately describes loss of version details in runner initialization and managed preparation. The remembered incident is correctly left unidentified.
- HCN's pinned README documents `inspect --runtime` as a version-only probe with executable and verified-version facts, not a model turn. This is rung 2 documentation evidence, not a live native-harness test.
- Extensible model vocabularies are preserved by the proposed rule and by `src/server/hub-settings.ts:51`.
- The proposed ownership and trust boundaries align with ADR 0005, 0008, and 0009. No updater, refresh button, automatic switching, or new input-recovery flow appears in the draft.
- The existing outer E-HUB-03 startup hold can carry a richer message (`src/cli/runtime.ts:273-297`). This needs no new execution state.
- The parent ran `bun test test/server/unavailable-hcn.test.ts test/harness/hcn-bin.test.ts`: **10 passed, 0 failed, 28 assertions**. These prove current executable-resolution cases and healthy/damaged record readability with unavailable HCN; they do not test the proposed diagnostics.

## Not reviewed and evidence limits

- No section of the RFC was skipped. This was a specification review, not a review of an implementation diff or a build/no-build verdict.
- No browser rendering, focus behavior, announcement behavior, or 390/768/1440 viewport verification was performed. F4 is source evidence about the current panel, not a screenshot finding.
- The full test suite and compiled build were not run. The reviewer did not run the parent's baseline tests. Its own probes were the pinned HCN version command and an isolated `spawnSync`/`sleep` probe. No real task, model turn, or package update was used to test the feature.
- Graph coverage was unavailable to the reviewer. The parent subsequently checked 28 referenced paths: 15 were not tracked by the index, 12 had changed metadata, and one matched. Current-source reads support the findings; the graph does not establish completeness. Bounded text searches support the reported omissions.
- Only the pinned HCN README was inspected for its public runtime-inspection contract; its shipped implementation was not audited. `src/modes/context-preparation.ts` was not read in full by the reviewer, so classification of every accounting failure is not cleared.
- React and CSS standards were loaded by the parent during evidence checking. No broader component or styling audit was performed.
- The original review and the same reviewer's final dispositions remain under ignored `artifacts/reviews/rfc-20-v1/` as `report.json` and `followup-report.json`. The parent added evidence checks and consolidated wording, retaining the final reviewer severity and finding identifiers.
- The RFC and its status were left unchanged. This document requests clarification of the findings; revision remains a separate action.

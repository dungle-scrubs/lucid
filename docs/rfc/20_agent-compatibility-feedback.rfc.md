---
number: 20
title: "Agent compatibility feedback"
type: feature
status: Implemented
author: Kevin Frilot
date: 2026-09-08
version: 2
---

# RFC-20: Agent compatibility feedback

## Abstract

Lucid can refuse agent work when its HCN installation or selected harness does not meet its execution requirements, but the feedback can omit the versions and the reason. This RFC makes those failures explainable and adds a warning when the selected HCN differs from Lucid's dependency pin. Feedback identifies the affected operation, the observed and required versions where known, and the installation that needs attention. The user repairs the installation, restarts the runtime, and tries again through the existing workflow; this feature adds no update or recovery controls.

## Introduction

Lucid serves one person working with coding agents and reviewing their documents. The person needs to know why an agent cannot run without losing access to the document or interpreting internal logs. This feature holds that product scope: it explains the compatibility checks of an existing workflow.

The scope includes Lucid's selected HCN executable, the selected harness executable, and compatibility refusals for the requested model or operation. It includes CLI diagnostics and browser feedback. It does not establish that an installed version is the newest available release.

The user owns package updates. Package installation, automatic upgrades or downgrades, registry polling, automatic model or harness switching, a Check again button, and a new Ready/Resume flow are out of scope. Existing input recovery and execution rules remain in force. This RFC does not alter dependency release policy, relax executable verification, or add a model catalog to Lucid.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

| Term | Meaning |
|---|---|
| Harness | The agent CLI, such as Claude Code or Codex. A model is a separate selection. |
| HCN | The normalizer invoked by Lucid through its harness boundary. |
| HCN pin | The exact HCN dependency version declared by the running Lucid release. |
| HCN floor | The minimum HCN version accepted by Lucid's existing runtime check; exposed as `hcn.minimum` in diagnostics. |
| Selected executable | The executable resolved for the relevant process and working folder, not an arbitrary global installation. |
| Verified harness version | The version HCN reports as verified for its harness adapter. This is evidence of adapter support, not a claim about the newest release. |
| Diagnostic | A warning or error describing a compatibility observation and its effect on an operation. It does not authorize execution. |
| Runtime restart | Restarting the Lucid process that owns the installation observation. A browser reload alone does not restart that process. |

Other terms follow [CONTEXT.md](../../CONTEXT.md), including conversation, record, artifact, profile, and driver preference.

## Motivation

The current code already contains the necessary distinctions:

- `resolveHcnBin` selects an override, package-local dependency, or PATH executable. `assertHcnVersion` checks it against `HCN_MIN_VERSION`; the session handshake also checks its reported HCN version. These checks enforce a floor, not equality with the dependency pin.
- HCN runtime inspection reports the selected harness path, detected version, verified version, and native-resume support. Managed preparation requires exact executable/version verification before dispatch.
- `createHubSettings` reduces runner-construction failures to a generic repair message. Managed preparation reduces a version mismatch to "The selected executable is unverified." The browser cannot explain the missing facts from those strings.
- The existing unavailable-HCN test preserves conversation reads and avoids repeated probes. Diagnostic improvements must retain that behavior.

These are source observations, not a reproduction of the user's remembered incident. RFC 19 records a separate capability gap: Codex lacked the context-accounting mechanism Lucid required. The feedback must distinguish that unsupported operation from version drift.

## Design

### Authority and version policy

The harness boundary MUST own executable resolution, version observations, and interpretation of HCN responses. Browser, server, and mode code MUST NOT shell out to native harnesses independently or mirror HCN descriptors, flags, verified-version tables, or model vocabularies.

Lucid MUST obtain the HCN pin from its own release manifest, carried into both packaged and compiled distributions. It MUST NOT infer the pin from a neighboring checkout or the detected HCN installation. The HCN floor remains separate, with its existing meaning; this RFC does not require the two values to stay equal.

The HCN observation MUST identify the resolution source and executable used by the existing resolver. If PATH or an executable name needs resolving to obtain an absolute path, resolution and invocation MUST use that same result. An unavailable absolute path is reported as unknown. Diagnostics MUST NOT inspect unrelated installations or invent paths.

A detected HCN version that differs from the pin but passes existing runtime requirements MUST produce a warning. That difference MUST NOT add an execution block or be described as proven incompatibility. Versions below the floor remain errors under the existing gate. A session handshake reporting a version below the floor remains an error even if the earlier executable probe passed. Diagnostics MUST retain which observation produced the failure.

For pin equality, Lucid MUST trim surrounding whitespace, remove at most one leading lowercase `v`, and require the remaining entire string to match [SemVer 2.0.0 syntax](https://semver.org/). It MUST compare normalized strings exactly, including prerelease and build metadata. This is release identity, not SemVer precedence. Thus `v0.6.5` matches pin `0.6.5`, while `0.6.5-rc.1` and `0.6.5+build.12` differ. Output such as `hcn 0.6.5` or `0.6.5 (build 12)` is unknown for this comparison and produces inspection unavailable, never a match. The existing floor comparator and its admission result MUST remain unchanged; malformed evidence adds only a warning if that gate admits execution. Pin equality MUST NOT reuse the floor comparator that discards suffixes.

Harness diagnostic comparison MUST use the executable and verified-version evidence from the same HCN runtime inspection, retaining that inspection's `verifiedAgainst`. A missing version is unknown, not version zero. A different harness version MUST be described as unverified, not necessarily broken. Where the existing operation requires exact verification, that operation remains blocked. This RFC MUST NOT apply that gate to additional operations.

When an existing admission check runs, its diagnostic evidence MUST also retain the verified version actually used, even when it came from a cached descriptor observation. If that value disagrees with the runtime inspection, the explanation MUST label both values and name the comparison that determined admission. The diagnostic is inspection unavailable due to inconsistent evidence, with error severity only when an existing check refuses the operation, otherwise a warning. A disagreement MUST NOT change the gate, silently replace its evidence, or claim a verified match. The `verified` and `admissionVerified` facts below keep those observations distinct.

Successful version checks MUST NOT imply support for every model, mode, native session, authentication state, or context operation. Existing structured capability or model refusals remain distinct. An unlisted model on an extensible HCN vocabulary MUST NOT be rejected merely because it is absent from the list.

### Check boundaries and lifetime

| Boundary | Observation and feedback |
|---|---|
| Lucid browser runtime starts | Resolve and inspect HCN once. Retain the result for the process lifetime. Publish any runtime diagnostic; continue serving records. |
| A CLI command starts an HCN-backed driver | Use that process's existing initialization check and emit the detailed result before agent work. A warning preserves the existing exit behavior. |
| A saved selection is opened or changed | Inspect the selected managed harness when its actual working folder and settings are available. Surface a selection diagnostic before another prompt where possible. |
| A saved interactive selection is opened or changed | No native-executable selection probe or version diagnostic. Do not substitute a headless profile. Applicable HCN runtime notices remain visible but refer to managed agent work, not the human-owned agent. Existing settings validation remains in force. |
| A managed worker starts or reconnects a native session | Preserve the existing fresh runtime inspection and execution checks. Their result, not cached browser feedback, determines whether the operation can proceed. |
| An artifact is created, viewed, edited, or saved | No additional compatibility probe. These document operations do not by themselves select or start a harness. Existing diagnostics remain visible. |
| A human-owned interactive source attaches | Do not run a replacement process or apply an HCN execution gate to attachment. A PATH probe cannot establish the version of an already-running agent. Existing attachment failures keep their own classification. |

HCN startup inspection MUST NOT prevent the browser listener or record reads from becoming available. The browser runtime MUST run that probe asynchronously or off its request-serving thread; wrapping a synchronous spawn in a promise does not satisfy this requirement. Its version probe MUST finish or time out within five seconds, bound each output stream to 4 KiB, and clean up a timed-out child. Selection inspection SHOULD reuse the harness boundary's existing timeout, cancellation, output-limit, and cleanup facilities. Page entry MUST NOT invoke context accounting, send a model prompt, or run a smoke test for diagnostic purposes. HCN's version-only runtime inspection supplies executable observations.

The browser-facing selection observation MUST be memoized by selected HCN identity, harness, model, effort, provider, profile, working folder, and native-resume identity when applicable. Concurrent requests for the same observation MUST share the probe. Periodic record reads and multiple tabs MUST NOT spawn repeated diagnostic checks. A changed selection permits a new observation; late results for an older selection MUST NOT replace current feedback. Missing settings or a missing folder keep their existing errors and do not trigger a probe with guessed defaults.

The existing `createRecoveryAvailability` probes are outside this diagnostic memo. Their current trigger conditions, per-server/key 1500 ms cache, fresh/resume checks, interactive-to-headless recovery assessment, and resulting actions MUST remain unchanged. The new memo MUST NOT suppress those probes, and their refreshes MUST NOT refresh the retained compatibility notices. Their compatibility-related reasons use the safe factual explanation contract below.

The worker's existing execution inspection is also outside that memo. If the worker finds a different result, its failure message MUST describe its own observation. A later successful worker MUST NOT refresh the browser runtime's retained startup observation. Notices MUST identify their observation time and origin rather than claim that old evidence proves current work impossible. A newer browser observation MUST NOT rewrite a historical failed attempt.

Updating files underneath a running Lucid process is not a supported refresh mechanism for this feature. Restarting the owning runtime discards its diagnostic memo and repeats initialization. The feature MUST NOT add periodic process probes, automatic repair retries, a refresh endpoint, or a Check again control. This restriction does not remove existing recovery or execution checks.

### Diagnostic contract

The harness boundary SHOULD expose typed installation facts and typed failures so callers do not classify errors by matching English text. Known structured HCN refusal reasons MUST be preserved. Unstructured output is insufficient evidence for a more specific compatibility claim and falls back to inspection unavailable.

Responses from `GET /api/defaults` and `GET /api/conversations/:id` MUST add a `compatibility` list. Each diagnostic has the following fields; unknown fact values are null rather than guessed strings:

| Field | Type and contract |
|---|---|
| `code` | Stable identifier from Error Handling. |
| `scope` | `runtime` for HCN installation issues; `selection` for the selected harness or operation. |
| `severity` | `warning` or `error`, using the operation-specific policy below. |
| `operation` | Plain description of the affected operation, such as starting managed agent work. |
| `origin` | `runtime-start`, `selection-check`, `execution-check`, or `session-handshake`, identifying where the observation occurred. |
| `observedAt` | UTC timestamp in ISO 8601 form, fixed when the observation settles; reads do not change it. |
| `message` | Safe plain text explaining the observation and effect. |
| `remedy` | Safe plain text identifying the repair and runtime restart. It is not an executable action. |
| `hcn` | Facts object with keys `pin`, `minimum`, `detected`, `path`, `source`, and `lookupRoot`. Each value is a string or null. `lookupRoot` identifies the package or folder used by resolution, not inferred package ownership. |
| `harness` | Null for an HCN-only issue; otherwise a facts object with keys `name`, `detected`, `verified`, `admissionVerified`, and `path`. Each value is a string or null. `verified` belongs to the runtime inspection; `admissionVerified` is the existing gate's comparison value, or null when no admission comparison was performed. |

Both endpoints MUST retain their existing fields and status behavior. Record reads remain successful when HCN cannot initialize, including the existing damaged-record read path. Runtime diagnostics MUST remain available even when no valid selection exists. An empty list means no issue was observed for the checks performed; it MUST NOT render a global "all agents compatible" claim.

The browser shell MUST request `GET /api/defaults` on entry to the hub or a conversation, including direct conversation links, independently of opening the new-conversation dialog. That request MUST await the shared bounded startup observation asynchronously before returning its runtime diagnostics. Other record reads MUST NOT wait for that observation; while it is pending they omit its diagnostics and make no healthy-status claim. The shell displays the settled defaults result when it arrives. This needs no repeated startup probes or pending-status control. A selection diagnostic belongs only to its selection, while runtime diagnostics are available throughout that runtime's browser surface.

An execution refusal MUST retain the existing outer error code and outcome classification, including E-HUB-03 where currently used. Its safe message MUST include the same factual explanation even if that path cannot carry the additive browser diagnostics object. Session-version failures MUST carry the found version, required floor, resolved installation identity, and handshake origin through the typed failure. Diagnostic codes are presentation identifiers, not new durable execution states or recovery actions.

### Presentation and repair text

The browser MUST render one compatibility notice region below the hub header or conversation toolbar, outside the collapsible conversation panel. Both runtime and selection notices belong there; selection notices identify the selected driver and affected operation. Hiding the panel MUST leave the region visible, focusable where needed, and in the accessibility tree. Each distinct applicable problem gets one persistent notice. Settings and execution errors MAY retain their existing locations, but the same observation MUST NOT produce a second compatibility notice inside the composer.

The first sentence MUST state the affected operation, observation origin, and cause. Retained notices use wording such as "At Lucid startup" or "When this driver selection was checked"; an attempt failure describes why that attempt did not start. Known version facts MUST be available in the notice; its timestamp, executable paths, lookup root, and resolution source SHOULD appear in expandable details. Severity MUST be conveyed through text and accessible semantics.

The shell MUST own one polite live region outside the conversation panel for compatibility announcements. It announces each newly applicable warning or error once per document lifetime without moving focus or reopening a panel. Deduplication MUST use the diagnostic code, severity, origin, selection identity, operation, and installation/version facts, excluding timestamps and poll renders. Existing error surfaces MUST NOT announce that same compatibility observation again. Navigating to a new document starts a new announcement lifetime.

Repair text MUST refer to the selected installation using these resolver categories:

| `hcn.source` | Repair target and required provenance |
|---|---|
| `package-dependency` | Lucid's resolved HCN dependency. Recommend repairing or updating Lucid and its pinned dependency; retain the dependency package root. |
| `node_modules` | The module-relative lookup folder and selected executable. Identify that folder's HCN installation; do not infer it is Lucid's distributed dependency. |
| `node_modules(executable)` | The executable-relative lookup folder and selected executable. Identify that folder's HCN installation. |
| `node_modules(cwd)` | The working-folder lookup root and selected executable. Identify that project's HCN installation; updating Lucid elsewhere may not affect it. |
| `env` | The `LUCID_HCN` override and resolved executable. Advise repairing that target or correcting the override. |
| `path` | The executable selected through PATH. Identify its resolved absolute path when available; do not guess a package owner. |

These facts MUST come from the existing resolution, without scanning other installations. An unknown source or lookup root MUST stay unknown and use neutral advice to repair the identified executable. Lucid MUST NOT imply that updating an unrelated global HCN changes its selected dependency or claim a newer package already fixes an issue without evidence. A harness newer than the verified version calls for HCN support and a corresponding Lucid dependency update, if available; an older harness can instead need updating to the version already verified.

Examples use illustrative versions, not a permanent support table:

> At Lucid startup, the selected HCN reported 0.6.3, below the 0.6.5 minimum for managed agent work. Update the selected installation, restart Lucid, and try again.

> At Lucid startup, the selected HCN reported 0.6.6; this Lucid release pins 0.6.5. This difference does not by itself block agent work. Use a matching Lucid/HCN installation and restart Lucid after changing it.

> This attempt did not start because the selected Codex executable was unverified. It reported 0.154.0; the admission check required 0.153.4. Update HCN and Lucid when support is available, then restart Lucid and try again.

> When this driver selection was checked, HCN did not recognize the selected model for managed agent work. Check the model name; if it is a newer model, update the selected HCN installation and Lucid as needed, then restart Lucid.

No diagnostic adds an Install, Update, Check again, Ready, or Resume button. Existing settings and input recovery controls remain unchanged. A restart or successful observation MUST NOT, through this feature, submit, duplicate, resume, or discard input. Existing execution recovery owns that behavior.

## State Machine

This feature adds an observation lifetime, not a conversation lifecycle:

1. A runtime starts with no installation observation and starts its bounded HCN probe. The browser can serve records while the result is pending.
2. The probe settles with facts or an inspection failure. The runtime retains and presents applicable diagnostics until it exits.
3. Opening or changing a managed selection requests its memoized observation. Only the current selection's result is presented.
4. An execution attempt runs its existing checks. A refusal follows the existing outcome and carries a detailed explanation; a warning cannot independently refuse the attempt.
5. Runtime exit discards presentation observations. Restart begins at step 1. Existing recorded outcomes retain their historical messages.

Timeout and malformed output settle as inspection unavailable, never success. A stale selection result is ignored for presentation. Inspection alone MUST NOT append a conversation event, change a driver preference, acquire execution authority, or create a new attempt. An actual refused attempt can still record its normal outcome.

## Error Handling

| Diagnostic code | Severity and meaning | Repair |
|---|---|---|
| `hcn-version-too-old` | Error for HCN-backed operations when the existing executable or session version floor fails. | Identify found version, required floor, and selected installation; update or repair it and restart. |
| `hcn-version-drift` | Warning when a known HCN version differs from the pin and passes existing requirements. This does not certify full compatibility. | Identify the difference and installation source; align packages and restart after a change. |
| `harness-version-unverified` | Error for managed operations that already require exact verification; warning when reporting the observation outside such an operation. | Show detected and verified versions and the selected path. Explain which package needs support or updating without claiming that a release exists. |
| `inspection-unavailable` | Error when an existing required inspection refuses the operation; otherwise a warning about unavailable or inconsistent diagnostic evidence. | Distinguish missing executable, timeout, failed version probe, malformed response, or disagreeing verified-version observations when known. Repair the named installation and restart. Unknown versions remain unknown. |
| `selection-unsupported` | Error for an existing explicit model, profile, or capability refusal. Matching versions do not remove it. | Name the unsupported selection or operation. New-model support can require an HCN and Lucid update; a typo or unsupported profile needs corrected settings. |

An HCN floor failure suppresses the redundant HCN drift warning. Independent HCN and harness observations can coexist, but a failed HCN initialization MUST NOT manufacture an unverified-harness diagnostic. Authentication, usage limits, missing native sessions, missing folders, and oversized context retain their existing classifications; they MUST NOT be relabeled as package-version problems.

The browser SHOULD retain the notice until runtime restart or a changed selection makes it inapplicable. It MUST NOT promise that restarting alone repairs incompatible packages. Version-only checks perform no automatic retry within an observation. Existing execution attempts and newly selected settings retain their own invocation behavior.

## Security Considerations

HCN and harness output crosses a process boundary and is untrusted data. Diagnostic facts MUST be shape-validated, length-bounded, stripped of terminal control characters, and rendered as text. Raw stderr, argv, prompts, configuration contents, environment values, credentials, and native session IDs MUST NOT be exposed as diagnostic details. The selected executable path, resolver's source label, and lookup root are the only installation-location facts exposed; other environment content is not needed.

These rules MUST cover all compatibility-related messages: the new list, existing settings errors, API errors, recovery reasons, and execution messages. Keeping an existing field or status MUST NOT preserve unsafe raw process text. Structured facts generate the safe message; unstructured failures use a generic inspection-unavailable explanation. Existing unrelated error classifications remain unchanged. Historical stored events are not rewritten; any compatibility message projected from them MUST use the same safe presentation rule.

Browser diagnostics MUST use the existing same-origin, token-protected API boundary. Artifacts MUST NOT receive diagnostic authority or acquire a way to run installation commands. Diagnostic probes MUST use the normal selected executable and argument handling, not shell interpolation. They MUST NOT request elevated privileges, contact a package registry, or invoke a model.

Failure of the diagnostic layer MUST preserve record access and existing execution checks. It MUST NOT turn unknown support into permission to dispatch or make a version warning block unrelated document operations. Startup probing MUST remain bounded so an unhealthy executable cannot hang the browser runtime.

## Alternatives Considered

- **Reject every HCN version that differs from the pin.** Exact equality is simple, but Lucid currently enforces a floor. Adding rejection would change execution policy and classify an unverified difference as incompatibility. This RFC adds a warning instead.
- **Check when an artifact is created.** Creation can occur without an HCN-backed agent. Startup and the selected operation provide the relevant installation and working-folder context.
- **Compare against global versions or the newest published release.** Those versions may not be the executables Lucid uses. The selected process and its HCN evidence are authoritative here.
- **Install updates or offer Check again and Resume controls.** The user explicitly chose manual repair followed by runtime restart and the existing retry workflow. Extra controls widen the feature without serving that request.
- **Keep generic settings errors.** This preserves today's surface but discards facts needed to repair the correct installation.

## Implementation Plan

After RFC review and acceptance, create implementation tickets in this order:

1. Preserve installation facts and structured failures inside the harness boundary. Carry the release pin into package and compiled builds. Verify all six resolver sources, normalization and exact pin equality, unchanged floor behavior, async startup and probe limits, and runtime/admission evidence disagreement with fake processes. Retain handshake version and installation facts; replace the test's generic `bun install` expectation with source-specific advice. Do not proceed if this changes existing admission policy.
2. Add memoized diagnostics to the existing responses and safe explanations to existing error paths. Verify that missing or slow HCN leaves healthy and damaged records readable, concurrent defaults requests share the startup probe, polls share diagnostic probes, and changed selections discard stale results. Prove that the recovery helper retains its TTL and actions, saved interactive preferences add no native probe, and later worker success leaves a time-qualified startup notice. Preserve existing error codes and outcomes.
3. Render notices and repair details with the shell-entry defaults request. Verify direct hub and conversation entry, the closed conversation panel, keyboard access, announcement deduplication across existing error surfaces, and readable details at 390, 768, and 1440 pixel widths. Confirm that no installation or recovery controls appear.
4. Update the current driver and interface contracts after implementation, including stale claims about the current HCN pin. Preserve historical capability-introduction versions and labelled illustrative examples. Run `bun run check`, `bun run build`, and `git diff --check`. Use package/compiled resolution tests and a local fake-HCN browser scenario to verify the released forms. A live model call is unnecessary for this feedback contract.

The implementer owns these steps; the user owns installation changes. No record migration is required. Rollback removes the additive diagnostic projection and presentation while retaining existing compatibility checks. A regression in record access or execution admission blocks rollout. This draft does not approve implementation or modify HCN's package version.

## Open Questions

No unresolved user-scope questions remain. Check boundaries, warning/error policy, and inline notice placement above are proposed design choices for RFC review, not shipped behavior. The exact historic incident is unconfirmed and is not required to implement or validate this contract.

## Review responses

Version 2 answers the [independent version 1 review](20_agent-compatibility-feedback.review-v1.md). It retains the agreed feedback-only scope. The review remains unchanged; these responses are revision decisions, not an independent review of version 2.

| Point | Response in version 2 |
|---|---|
| F1 - synchronous startup (implementation note) | Made asynchronous or off-thread startup explicit; defaults awaits the shared bounded probe while record reads stay available. Added verification to steps 1 and 2. |
| F2 - hub defaults fetch (implementation note) | Required the defaults request at shell entry on both hub and direct conversation routes, independently of the creation dialog. |
| F3 - recovery refresh conflict | Excluded `createRecoveryAvailability` from the diagnostic memo and retained its 1500 ms cache, checks, profile conversion, and actions. |
| F4 - closed panel and announcements | Chose one notice region below the header or toolbar, outside the panel, and one shell-owned polite announcer with explicit deduplication. |
| F5 - repair provenance | Defined all six resolver categories and a lookup root; only `package-dependency` identifies Lucid's resolved dependency. |
| F6 - handshake identity (implementation note) | Required typed handshake failures to retain found/required versions, installation identity, and origin; included the repair-text test update. |
| F7 - divergent verified evidence | Retained runtime and admission versions separately; disagreement explains the actual gate result without changing admission. |
| F8 - saved interactive selection | Explicitly omitted native-executable probes for saved interactive preferences; retained managed HCN notices and existing settings/attachment checks. |
| F9 - safe existing error fields | Applied the safe-message contract to settings, API, recovery, and execution compatibility errors as well as the new list. |
| F10 - stale startup wording | Added origin and observation time, historical wording, and the rule that worker success does not refresh the startup notice. |
| F11 - equality rule | Defined minimal normalization and exact SemVer string identity, retaining prerelease/build distinctions; left the floor comparator unchanged. |
| F12 - floor field (editorial) | Mapped HCN floor explicitly to `hcn.minimum` in Terminology. |
| F13 - stale driver pin (implementation note) | Made current-pin documentation correction explicit in step 4 while preserving historical and illustrative versions. |

## References

### Normative

- [Product scope and vocabulary](../../CONTEXT.md) - document workflow, harness boundary, and interactive ownership.
- [Drivers and harness selection](../drivers.md) - existing verification, preparation, failure, and recovery contracts.
- [HCN owns harness differences](../adr/0005-hcn-owns-harness-differences.md) - ownership of descriptors and capability evidence.
- [Browser and agent content have separate authority](../adr/0008-browser-and-agent-content-have-separate-authority.md) - browser and artifact trust boundary.
- [A preference is not an event or a claim about reality](../adr/0009-a-preference-is-not-an-event-or-a-claim-about-reality.md) - preserve settings and distinguish observations from execution.
- [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) - requirement levels.
- [Semantic Versioning 2.0.0](https://semver.org/) - accepted version syntax; this RFC separately defines exact identity for the pin warning.

### Informative

- [HCN resolution](../../src/harness/node-deps.ts) and [version floor](../../src/harness/version.ts) - current executable selection and admission check.
- [HCN runner](../../src/harness/hcn-runner.ts), [harness interface](../../src/harness/runner.ts), and [inspection validation](../../src/harness/inspection-facts.ts) - descriptor/runtime observations and session version checks.
- [Hub settings](../../src/server/hub-settings.ts) and [driver choices](../../src/server/driver-choices.ts) - current degradation and memoization.
- [Recovery availability](../../src/server/recovery-availability.ts) - existing refresh policy excluded from the diagnostic memo.
- [Managed preparation](../../src/modes/managed-preparation.ts) - the existing executable refusal before execution.
- [Unavailable HCN regression](../../test/server/unavailable-hcn.test.ts) and [HCN resolution tests](../../test/harness/hcn-bin.test.ts) - record-read preservation and executable provenance.
- [Codex native context management](19_codex-native-context-management.rfc.md) - a capability mismatch that version comparison alone cannot explain.
- [Installed HCN documentation](../../node_modules/@dungle-scrubs/harness-cli-normalizer/README.md) - primary documentation inspected for pinned HCN 0.6.5; runtime inspection runs a version probe without executing the task. This local reference is available after dependency installation.

Source assessment used the current checkout at `6757d5259a3a56202394f2c302d371e9e0648f2b` plus existing local changes. The code graph reported changed or untracked coverage for relevant paths; material claims were checked directly in current source. This is drafting evidence, not an end-to-end verification result.

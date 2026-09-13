# Review: RFC-26 Interactive artifact conversation continuity, v5

## What was reviewed

- Path: `docs/rfc/26_interactive-artifact-conversation-continuity.rfc.md`
- Version: `v5`, status `Accepted`, dated 2026-09-11.
- Delta: `changes.diff` (v4 to v5 only: HCN `hcn interactive` gains optional `--startup-prompt <text>`; new `Reconnect startup instruction` subsection; v5 review-response paragraph).
- Companion reads: `26_interactive-artifact-conversation-continuity.review-v1.md`, `.review-v2.md`, `.review-v3.md` (F1-F10, N1-N7, R1-R3 dispositions carried, not reopened); `structure.txt`; `docs/architecture.md`, `docs/drivers.md`, `docs/skill-chat-substrate.md`, `docs/native-codex.md`, `src/modes/native-reconnect.ts`, `CONTEXT.md` (all inside the curated snapshot; direct reads, unindexed).
- Task-supplied facts taken as caller input, not snapshot evidence: native Codex idle resume defers SessionStart until the first user turn; native `resume --help` supports an optional prompt; full listener bootstrap after that turn is pending; current HCN strict resume rejects all prompts.

## Structural results

Supplied validation (`structure.txt`), quoted verbatim (not re-executed; shell is disabled in this session):

```json
{
  "passed": true,
  "errors": [],
  "warnings": []
}
```

No structural objection re-derived by hand.

## Findings (v5 scope only)

### V5-1 (minor): Lucid send-vs-omit condition for the startup prompt is unstated

- Section: Design 9, `docs/rfc/26_interactive-artifact-conversation-continuity.rfc.md:198` crossed with `:212`.
- What is wrong: `:198` defines the HCN option as optional ("Omitting the option retains idle resume") and requires `unsupported-interface` before spawn for interfaces without verified startup support. `:212` states unconditionally that "Lucid supplies one fixed startup instruction for a newly admitted reconnect launch." The RFC never states when Lucid omits (e.g., interface without verified support, to avoid a guaranteed refusal) versus always sends. Sending on an unsupported interface guarantees a pre-spawn refusal; omitting on supported Codex CLI leaves the idle terminal without SessionStart.
- Why it matters: the two implementable readings diverge (always-send vs send-only-when-supported), at the exact seam whose purpose is deterministic admission. Fail direction is safe (held, before spawn), but UX and retry behavior differ.
- Evidence rung: 2 (whole-document read; textual absence).

### V5-2 (minor): Startup-specific HCN refusals have no Design 8 / Error Handling mapping

- Section: Design 9 `docs/rfc/26_interactive-artifact-conversation-continuity.rfc.md:198` (`invalid-request`, `unsupported-interface` for startup) crossed with `:202` (refusal taxonomy), `:228-230` (projection states, action IDs), `:266` (reason families).
- What is wrong: `:202` binds a missing `openInteractive` to `operation-unavailable`. Prompt-caused refusals (`invalid-request` for empty/NUL/oversized/duplicate/option-confusion; `unsupported-interface` for unverified startup support) are not bound to a projection `state`, a reason family (`operation-unavailable` vs `resume-refused`), or an action set (`retry-resume` vs instructions-only). The Design 8 table has no startup row, and Error Handling lists no startup-specific reason.
- Why it matters: the UI contract (line 137: browser and CLI must not independently infer actions) leaves the startup-refusal presentation to implementer choice. Safe direction (held, status-only) is implied by lines 214-216 but not named for this refusal pair.
- Evidence rung: 2 (whole-document enum-to-table comparison).

### V5-3 (minor): Fixed-instruction budget and "existing command formatter" are unverified in this snapshot

- Section: Design 9 `docs/rfc/26_interactive-artifact-conversation-continuity.rfc.md:198` (8192-byte, NUL-free bound) crossed with `:212` ("encoded as shell data by Lucid's existing command formatter").
- What is wrong: no snapshot file:line for the formatter was found (snapshot search for `command formatter` returns only the RFC line itself), so the shell-encoding claim, the encoded-vs-raw budget accounting, and long-install-path overflow behavior cannot be checked here. There is no named Lucid pre-spawn length/NUL check; the only stated enforcement is HCN-side `invalid-request` before spawn.
- Why it matters: if the fixed text plus encoded paths ever exceeds 8192 bytes, the launch fails closed (safe: no spawn, held reservation), but the Lucid-side reason and whether the fixed text is itself acceptance-tested against the bound are unnamed. This is an acceptance gap, not an unsafe path.
- Evidence rung: 2 for the snapshot absence (search result reported, not a repo-wide claim); severity judgment is rung 1.

### V5-O1 (observation): Re-send after proven pre-start refusal vs "MUST NOT repeat the startup prompt"

- Section: Design 9 `docs/rfc/26_interactive-artifact-conversation-continuity.rfc.md:214` crossed with `:118`, `:149`, `:204`.
- What is said: `:214` bars repeating the startup prompt (after a consumed invocation / control failure). `:204`/`:118` license a new attempt ID and new notice after proven pre-start refusal (no child). A prompt-caused `invalid-request`/`unsupported-interface` is proven pre-start (no child), yet resending the same fixed instruction under a new launch ID reads literally as a "repeat."
- Reading adopted: the bar covers second turns, second sessions, and inference after uncertainty (all explicitly forbidden in `:214-216`); a repaired, explicitly admitted retry with a new ID is the `:149` `retry-resume` path, not a duplicate. The RFC does not say this sentence for the reconnect-startup case. No action proposed beyond one clarifying sentence when the author next touches the section.
- Evidence rung: 1 (reading of assembled ordering); cited lines are rung 2.

## Cleared (checked, not repeated next pass)

- HCN vs Lucid ownership is correct and consistent: HCN normalizes the optional prompt through a descriptor-owned argument template and supervises only the process it starts (`:198`); Lucid owns instruction content and record selection (`:210`, `:212`); HCN stores no conversation/reconnect state (`:198`). Consistent with `CONTEXT.md:100-101` (HCN owns harness invocation shape; Lucid never mirrors it). Rung 2.
- No second native argument registry: strict resume only, no fork/fresh/model-switch/caller argv (`:198`); strict-resume validation stays ID-and-folder-only (`:174`); Design 1 prohibition (`:62`) intact. The prompt carve-out is bounded (one nonempty UTF-8 string, 8192 bytes, no NUL) and explicitly not a general argv channel. Rung 2.
- No duplicate session/prompt/feedback by construction in text: one consumed HCN invocation; MUST NOT submit a later turn, repeat the prompt, or infer receipt after control failure (`:214`); startup turn is visible native history but "is not a Lucid feedback input and MUST NOT advance any delivery cursor or settle an offer" (`:212`); same conversation MUST NOT be intentionally started in two places (`:128`); startup race does not launch a second session or replay the prompt (`:216`). Rung 2.
- Provenance/release race held outcome is deliberate and fenced: early selection gets the existing held result; no callback waits on the launch source while holding the registration lock; no model polling turn to renew listening (`:216`). This matches the task constraint and is not a polling license. Rung 2.
- Unsafe invocation surface is fail-closed in text: option-like prompt text, duplicates, and invalid text yield `invalid-request` before spawn; unverified interfaces yield `unsupported-interface` before spawn; prompt text never appears on the control pipe; HCN makes no receipt/adherence claim (`:198`); malformed control yields `launch-uncertain`, never synthesized refusal (`:200`). Rung 2.
- Per-interface gating retained: CLI evidence does not prove desktop or another harness; startup support alone does not activate an unverified interface; acceptance list names boundary, zero-spawn, exact session/folder, unchanged settings, single invocation, race, and hook/selection/attachment cases (`:218`). Native end-to-end acceptance remains required (`:238`). No full native acceptance is claimed. Rung 2.
- Current seam cannot yet send a prompt, so v5 cannot execute prematurely: `src/modes/native-reconnect.ts:74-89` calls `openInteractive` with `cwd/harness/interface/launchId/resume/signal/dispatch` and no prompt field; missing `openInteractive` yields held `operation-unavailable` (`:46`). Invoking a prompt-rejecting HCN with a prompt would refuse before spawn (held), not launch unsafely. Rung 3 (direct source read).
- v4 dispositions stand: `closed` row present (`:147`, R1); per-interface subagent provenance is an acceptance gate and test case (`:174`, `:190`, R2); notice derives from the single durable launch-intended fact (`:204`, R3). Rung 2.

## Not reviewed

- Validator re-execution; `structure.txt` quoted without independent run (no shell).
- Native Codex idle-SessionStart timing and `resume --help` prompt syntax: caller-verified per task; no native transcript or `--help` fixture inside this snapshot was used to corroborate them.
- Full listener bootstrap after the startup turn (SessionStart, registration, selection, attachment): pending per task; the RFC correctly gates it behind acceptance (`:214-218`).
- HCN `interactive` implementation and fixtures: pending prerequisite (`:202`); the snapshot seam shows the pre-prompt call shape only.
- Startup behavior on Claude/Pi/Muse/desktop: no per-interface evidence in snapshot; RFC defaults them to unsupported until verified.
- Prototype interaction, browser composition, full test suite, environment/config/history/credentials, and any path outside the curated snapshot: not read, per task scope.
- No rung-4 reproduction was performed or is claimed.


Reviewer: muse-spark-1.3-contributor@muse. Review input is the retained v5 snapshot; the author applies dispositions in v6.

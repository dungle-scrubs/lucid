# RFC 28 v1 review

Reviewer: muse-spark-1.3-contributor@muse. Draft version 1. The full reviewer report follows unchanged.

## Author-run structural check

The reviewer did not use the supplied structural result. The author ran the validator before review; its output is reproduced verbatim here:

```json
{
  "passed": true,
  "errors": [],
  "warnings": []
}
```

## Reviewer report

# Review: RFC-28 v1 - Pi native extension bridge and strict session locators

What was reviewed: [28_pi-native-extension-bridge-and-strict-session-locators.rfc.md](/Users/kevin/dev/lucid/artifacts/evidence/interactive-artifact-wayfinder/rfc28-v1-review/docs/rfc/28_pi-native-extension-bridge-and-strict-session-locators.rfc.md:1) - version 1, status Draft. Single careful pass. No edits made.

## Structural results

Validator not run. The review-rfc skill requires `validate-structure.ts` via shell; this session has no shell/network and the draft-rfc skill directory is outside the curated snapshot, so there is no verbatim validator output to report. Manual frontmatter observation only (not a substitute): lines 1-9 carry number 28, title, type protocol, status Draft, author Codex, date 2026-09-13, version 1. Required-section and RFC 2119-keyword checks are unverified.

## Findings (severity-ranked)

### F1 (blocking protocol gap): critical wire revision for `nativeLocator` is deferred, and the current parser would silently ignore it

Sections: Versioning (lines 110-112), Message Formats (lines 64-66); Open Question 2 (lines 130-131).

- `src/protocol/connection.ts:30-38` - `NativeBinding` has no locator field.
- `src/protocol/connection.ts:569-595` - `parseNativeBinding` picks known fields and returns them; extra fields are ignored, not refused. A locator added as a plain extra property inside the existing `bound` kind would be silently dropped by an old reader, which is exactly what line 112 prohibits.
- The draft fixes the required behavior (old readers refuse, old records unchanged, no inferred location) but leaves "the exact critical wire revision and HCN locator encoding" to later protocol/reader tests.

Standing: source code + spec contradiction (draft's own prohibition vs its deferred mechanism).

Fix: specify the revision before slice 4 writes any locator record. Name the envelope (execution payload version bump vs new `connection` kind vs versioned `bound` body), the parser refusal rule (unknown locator shape refuses the envelope without mutation, consistent with RFC-26 Design 9 refusal behavior), and the HCN `--session-file` encoding. Until then slices 1-3 must not persist `nativeLocator`.

### F2 (blocking protocol gap): HCN Pi strict lookup/launch is normative but undefined at the seam

Sections: Message Formats (lines 66-70); Implementation Notes slice 4 (line 121).

- `hcn/src/knowledge/interactive.ts:15` - `pi-cli` resume is `null` (unavailable).
- `hcn/src/execution/interactive-preflight.ts:49-98` - preflight is Codex-only (Codex record path, folder check, `codexCli.bin`). There is no Pi header check, no session-dir resolution, no Node entry/interpreter resolution in snapshot.
- The draft requires HCN to "verify a bounded regular native Pi session header, exact ID, stored folder, and an unambiguous native lookup in that file's directory" (line 66) and to "resolve the supported Node entry point and interpreter without a shell" (line 70), but gives no bound value, no header schema version, no ambiguity definition, no directory derivation under `PI_CODING_AGENT_SESSION_DIR` / `--session-dir` override (`pi/docs/environment-variables.md:80-82`), and no entry-point algorithm. The task brief confirms HCN interpreter support is not established by the native report.

Standing: source code (absence of Pi support where the draft places MUSTs) + observed native report scope limit.

Fix: define the exact `hcn` Pi grammar (extend `parseInteractiveRequest` / `interactiveArgv` or name the new operation), header acceptance (e.g. `SessionHeader` `type/id/cwd`, version handling per `pi/dist/core/session-manager.d.ts:5-12`, byte/size bounds), session-directory resolution order (explicit `--session-file` dir vs `SessionManager.list(cwd, sessionDir?)` semantics at `pi/dist/core/session-manager.d.ts:349`), ambiguity rule (more than one header-ID match in that directory fails before creation), ephemeral/missing-file refusal, and Node entry + interpreter resolution without shell (which file, which PATH lookup, shebang-wrapper refusal). Map each to the existing `InteractiveRefusal` taxonomy. Keep the lane unavailable until built; the draft already does this, but the normative MUSTs should be marked provisional on that definition landing.

### F3 (blocking protocol gap): the 45s `agent_end` wait primitive is underspecified

Sections: Protocol Overview steps 4-5 (lines 40-43), State Machine (lines 76-84); Open Question 3 (line 132).

- `pi/docs/extensions.md:569-581` - `agent_end` fires per low-level run while Pi may still auto-retry, auto-compact and retry, or run queued follow-ups; `agent_settled` is the settled signal.
- `pi/docs/extensions.md:1028-1029` - `ctx.signal` is typically defined during active turn events and usually `undefined` in idle/session contexts. Step 4 waits after the response ended on "agent_end's verified native cancellation signal" without saying which signal object survives the run, who owns the 45s timer, or how Esc reaches a wait when no turn is active.
- The native report establishes 45s expiry and native Esc cancellation as observed outcomes (`native-prerequisites.json:9-12`); per the brief it does not establish the API-field mechanism. OQ3 admits the deadline/signal forms are being verified independently.

Standing: spec contradiction (candidate API docs vs proposed use) + observed native report (outcomes only).

Fix: name the wait owner and primitive (whose AbortSignal, Esc wiring via terminal input vs `ctx.signal` vs `ctx.abort()`), choose `agent_end` vs `agent_settled` with retry/compaction/follow-up handling, define "missing signal holds feedback" operationally, and define expiry/cancellation evidence (which fact revokes readiness, per lines 81-82) without inferring receipt.

### F4 (major, no RFC-26 contradiction): Pi tool operations as CLI equivalents need an explicit per-operation mapping

Sections: Terminology line 33, Protocol Overview step 3 (line 39), Message Formats (lines 49-58).

RFC-26 requires CLI operations with exact validation, transactions, and lock order (`docs/rfc/26_interactive-artifact-conversation-continuity.rfc.md:51-62`, `196-230`), while its Pi lane already anticipates extension-API delivery (`26:140`, `26:222`). RFC-28's "Pi equivalent of the RFC 26 CLI operations" with "ordinary shell environment values do not authorize" (line 39) is therefore a transport refinement, not a contradiction - provided equivalence is exact. The gap: no table maps each tool op to its CLI counterpart's validators, append transactions, registration-before-append lock order, idempotency/readback rules (exact receipt/response identities, response-requires-receipt, resume-listen refuses mismatch and never creates a record). Also step 5's "sendUserMessage with follow-up delivery and template expansion disabled" does not pin Pi's options: `deliverAs` `steer` vs `followUp` vs `nextTurn`, `triggerTurn`, `expandPromptTemplates: false` default (`pi/docs/extensions.md:1432-1437`, `1462-1467`), and the streaming-without-`deliverAs` throw (`pi/docs/extensions.md:1467`).

Standing: spec contradiction (risk only; equivalence claimed but not pinned).

Fix: add a per-op equivalence table (tool op, RFC-26 CLI op, validators reused, transaction and lock order, idempotency), and pin `sendUserMessage` arguments including expansion off, command dispatch off, and the streaming case.

### F5 (major): direct-child helper trust needs its two-part composition stated

Sections: Protocol Overview steps 2-3 (lines 38-39), Message Formats (lines 60-62), Security Considerations (lines 102-106).

- `src/store/native-registration.ts:73-104` - current authority is caller-ancestry plus an adapter `verifySession`; `src/cli/native-context.ts:20-30` shows the Codex adapter (role marker plus session/thread equality).
- RFC-28's helper checks its direct parent's kernel identity over an inherited pipe and trusts callback provenance "only from the installed extension entry point" (lines 60, 102). For Pi the helper's parent is the Pi process itself, so the parent check proves which process started the helper, not which role (TUI parent vs RPC/child/SDK) that process is in. Role must come from `ctx.mode` (`pi/docs/extensions.md:968-974`: `tui`/`rpc`/`json`/`print`), `hasUI` (lines 972-974), and session-manager state - plus the still-unproven subagent negative controls (see F6). Model-invoked receipt/respond intentionally run in the same process, so parent match cannot authorize content; only generation/offer/epoch revalidation does (lines 42, 62).

Standing: source code + spec (composition missing, not contradicted; line 37 gating and OQ1 are consistent with RFC-26).

Fix: state the rule explicitly - parent-PID proves process, `ctx.mode`/provenance proves role, generation/offer/epoch proves the specific work; none substitutes for another. Forbid treating a parent match as role proof.

### F6 (acceptance gate, correctly held): Pi child/SDK provenance is still unproven - keep it blocking activation, not draft approval

Sections: Protocol Overview step 1 (line 37), Security Considerations (lines 104-105), Open Question 1 (lines 130-131), Error Handling (lines 92, 98).

RFC-26 Design 9 requires each lane to establish its subagent marker before enabling registration, else stay unavailable with `subagent-provenance-unverified` (`26:226`, `26:280`). The snapshot supports the need: process markers are inherited by children, not session-specific, and absent under SDK (`pi/docs/environment-variables.md:13-18`); shell session variables are injected per command into LLM-callable tools, disable-able, and absent from `!` commands (`environment-variables.md:22-49`, `64-73`); no extension-tool subagent marker appears in the supplied docs. RFC-28 carries the refusal reason and makes a failing negative control block activation rather than relax the rule. No contradiction found.

Standing: spec (RFC-26 condition) + source docs (marker gaps).

Fix: enumerate the required negative probes (TUI parent vs bash-child tool invocation with same session ID vs SDK-embedded invocation vs RPC) and the exact refusal for each; keep OQ1's "failing control blocks activation" as a release gate. Distinguish from F1-F3: this is native acceptance evidence, not draft text to finish first.

### F7 (major): locator capture rules omit bounds and directory/ambiguity semantics

Section: Message Formats (lines 64-66).

Grounded parts: `getSessionFile(): string | undefined` (`pi/dist/core/session-manager.d.ts:209`), header `cwd` (`session-manager.d.ts:10`), `SessionInfo path/id/cwd` (lines 125-139), `SessionManager.list(cwd, sessionDir?)` (line 349). Consistent with the HCN descriptor's two-flag distinction: `--session` requires existing, `--session-id` creates (`hcn/src/knowledge/pi.ts:58-74`); the draft's "MUST NOT use `--session-id`" (line 68) agrees with it. The native report establishes exact-ID custom-directory resume with prior context loaded and missing-UUID refusal without creation (`native-prerequisites.json:3-8`). Gaps: "absolute bounded path" states no byte bound; "unambiguous native lookup in that file's directory" defines neither the filename convention (`<ISO>_<uuid>.jsonl` per `hcn/src/knowledge/pi.ts:110-116`, verified 0.84.2 vs installed 0.85.1 drift note) nor what counts as a conflicting match (fork parent pointers, branch copies, same ID across dirs); custom-dir override interaction with the cwd-slug template is unstated.

Standing: source code + observed native report (partial grounding).

Fix: bound the path, enumerate header checks and session-dir resolution order, define ambiguity as more than one ID match in the scoped directory failing before creation, and restate ephemeral/unsupported-header/missing-file/folder-refusal mapping. Note the 0.84.2-vs-0.85.1 descriptor drift as a re-verification item.

### F8 (minor): per-operation helper lifecycle vs replacement/reload ordering

Sections: lines 45, 60-62, 118, 121.

The no-reuse-across-replacement rule matches Pi's stale-`SessionManager` warnings (`pi/docs/extensions.md:1268`, `1291-1300`) and the shutdown/replacement lifecycle (lines 432, 449, 518-526, 1265). Unstated: who supervises each helper (spawn, reap, kill signal, timeout), cleanup ordering relative to `session_start(reason: new/resume/fork)` re-registration, pipe inheritance across `reload` (which re-emits shutdown/start while the old command frame continues, lines 1317-1324), and whether a 64 KiB pipe overrun truncates or refuses.

Standing: spec (Pi lifecycle docs).

Fix: specify supervision, kill/await ordering, reload behavior, and overrun refusal.

## Cleared

- Scope discipline: same-person/same-session purpose, no general IPC, no history import, no model-selected ownership, RFC-27 preservation, and "no automatic runtime activation" (lines 19, 23, 112, 124) are consistent with RFC-26/27 acceptance gates.
- TUI-only eligibility direction (line 37) matches `ctx.mode`/`hasUI` semantics; RPC/JSON/print/headless exclusion is the right default.
- `--session-id` prohibition (line 68) agrees with the HCN descriptor's create-on-missing semantics.
- No-shell helper invocation, closed tool object with unknown-field rejection (lines 39, 49, 60), existing lock order reuse (line 106), no second executor/listener socket (line 126), and delivery-uncertainty no-replay (line 84) preserve RFC-26 ownership.
- The native report is not overclaimed: its scope line (`native-prerequisites.json:18`) withholds binding/extension/receipt/HCN-launch conclusions, and the draft's slices 3-5 demand that evidence before enabling anything (lines 118-124).

## Not reviewed

- Validator output (no shell, above); line-level RFC 2119 casing audit.
- Remainder of `src/protocol/connection.ts` below line ~800 (reducer/fold paths), `execution.ts`, HCN `run.ts`/`stream-turn.ts`, Pi `session-format.md` full text (only the `.d.ts` was supplied), and raw native probe logs (only the summary JSON was supplied). The structural dependency graph was treated as stale per instructions and not used.

## Implementability

Not yet implementable end-to-end. Blocking protocol gaps (F1 critical revision, F2 HCN Pi grammar/header/dir/interpreter, F3 wait primitive, F4 per-op mapping) must be settled in the draft; native acceptance gates (F6 provenance probes, slice 3-5 recordings, F7 re-verification on 0.85.1) must then pass on native before any lane enables. Slices 1-2 are closest to ready; slices 3-4 depend on the deferred decisions.

# RFC 28 v5 review

Reviewer: muse-spark-1.3-contributor@muse. Draft version 5, commit de15a62. Verdict: accept with minors. The full reviewer report follows unchanged, except that git-ignored prototype paths are cited as findings and absolute links are made relative. v6 answers it in "Response to v4 review".


Target: `docs/rfc/28_pi-native-extension-bridge-and-strict-session-locators.rfc.md` v5 (commit de15a62, branch `rfc/28-pi-bridge-v3`), against the v4 review (M1-M7, N1-N7), RFC 26, ADR 0005, Pi 0.87.1 source, hcn `fix/pi-store-root`, and Lucid code. Review only; no files edited. No `*.jsonl`, `sessions/`, `.env`, or credentials read.

Standing of claims below: **documented** (owning source says it), **observed** (probe output shows it), or **unverified** (not established). Silence is reported as such.

## Q1 - Does v5 close each v4 finding?

| Finding | Status | Evidence |
|---|---|---|
| M1 verified-with-no-agent-events | Closed | Outcome table row 1 now requires "at least one" agent event ([rfc](28_pi-native-extension-bridge-and-strict-session-locators.rfc.md:387)). |
| M2 agent events undefined | Closed | Defined below the table: every hcn kind except `identity`, `progress`, `error`, `failure`, `done`; unknown kinds count ([rfc](28_pi-native-extension-bridge-and-strict-session-locators.rfc.md:391)). The exclusion set matches [events.ts](../../src/protocol/events.ts:36) vocabulary, and unknown-counts-as-agent-event matches `classOfEventKind`'s lossless default ([events.ts](../../src/protocol/events.ts:97)). |
| M3 attestation path | Closed | One file per attempt: `<record private directory>/pi-attestation/<attempt ID>.json`, exclusive create (step 7). |
| M4 multi-extension semantics | Closed | R13 verified in Pi source (see Q2). `-ne` rejection reasoned in step 10. Denial is order-independent: any `handled` in the chain drops the prompt. |
| M5 session_start-throw-before-write | Closed in logic, schema gap | Step 9 puts checks in `try`/`catch` and writes `refused` with `verification-failed`. But the attestation schema lists only `session-id-mismatch \| folder-mismatch \| session-empty` ([rfc](28_pi-native-extension-bridge-and-strict-session-locators.rfc.md:377)). See D1 (minor). |
| M6 nested resume of parent session | Closed in text, caveats | Step 2 ancestry rule refuses it; gate case (b) added. RFC 26 itself demands this: adapters "MUST reject subagent provenance even where a callback carries the parent's session ID" (26:210). Soundness caveats, see D4 (minor). |
| M7 bind refusal | Closed | Step 3 claims the refused bind and saves the refusal beside the publication; mirrors [claude.ts](../../src/cli/hooks/claude.ts:214). |
| N1 per-operation table | Closed | Lines 409-412 attach the ancestry and session rules plus both refusal reasons to every row. |
| N3 empty bound session | Closed | Step 9 states the construction argument (bind commits from a Bash tool call, so user message + tool call exist). |
| N4 folder spelling | Closed | Step 9 accepts original spelling or real-path equality, i.e. refuses only when both disagree - exactly what N4 required. Record keeps original spelling, consistent with RFC 26:210. |
| N5 G2 row overclaim | Closed | G2 row now distinguishes missing/factory-throw (R1,R2 stop Pi) from handler-throw (contained by deny-by-default). |
| N6 slice 1 status | Closed | Stated as branch-committed with release, pin bump, and fixture re-capture pending. The fix is present in this checkout ([pi.ts](hcn source)). |
| N7 attempt format | Closed | Step 7: attempt ID through RFC 26's validator, 64 lowercase hex nonce from a cryptographic source, unparsable value treated as failed check. |

## Q2 - R13 and R14 against Pi source

R13 (first-`handled`-wins, throw-skip, every user path through `emitInput`): **right, with one overbroad sentence.**

- Documented: `emitInput` is commented "Transforms chain, `handled` short-circuits" and returns on the first `{action: "handled"}`; a throwing handler is reported via `emitError` and skipped (Pi `dist/core/extensions/runner.js:1096-1126`). Observed: round-3 `input-throws-bas-gate` shows the "input boom" extension error on stderr while the prompt ran (20 attempts in the round-3 prototype).
- Documented: `sendUserMessage` calls `prompt()` with `source: "extension"` (`agent-session.js:1547-1575`), `prompt()` runs `_runInputHandlers` → `emitInput` before any streaming branch or model call (`agent-session.js:1229-1234`, `1166-1178`). So extension idle-injection also passes the gate. Step 10's "none can undo it" holds: once any handler returns `handled`, later handlers never run and `prompt()` returns early.
- Overbroad: "Every user-message path goes through `emitInput`." Extension slash-command dispatch runs **before** input handlers (`agent-session.js:1216-1225`), and a command handler reaches the model via `sendMessage` → `sendCustomMessage` (comment at 1217, binding at 2398) with no `input` event. Queued `nextTurn` custom messages also piggyback onto the next approved prompt (1302-1306). Practical impact is nil - the headless resume prompt never starts with `/`, and both paths require same-user extension code, which the RFC's trust model already places outside the boundary. See D2 (minor): qualify the sentence.

R14 (`sendCustomMessage` + `triggerTurn` bypasses `input`): **right.** Documented: the `triggerTurn` branch calls `_runAgentPrompt` directly with no `_runInputHandlers` call (`agent-session.js:1502-1508`); the streaming steer/followUp branch likewise bypasses it (1494-1501). Step 10's classification claim holds for the case that matters: a bypass turn that reaches the model emits `message`/`token`/`tool` records (hcn's pi descriptor confirms token granularity from `assistantMessageEvent` text deltas, [pi.ts](hcn source)), which are agent events under the M2 definition, so a refused attestation plus a bypass turn lands on row 3 (uncertain), never row 2. Symmetric check: refused attestation plus a bypass turn against a dead provider emits no agent events, and row 2 then correctly reports "did not reach the model." The table is robust in both directions.

Outcome table overall: rows 1-3 are the right shape, and row 2 is achievable in principle (a refused run emits the session record, which hcn announces as `identity`, plus `failure`/`done` - all excluded). But no evidence enumerates a refused run's **full hcn kind list** against the M2 exclusion set, because P1 predates M2. See D3 (minor): slice 2 must record it.

## Q3 - Step 2 ancestry rule

**Sound for homogeneous installs; does not wrongly refuse a normal `lucid` command.**

- Mechanism documented: Pi's Bash tool builds child env from `process.env` at spawn (`bash.js:122-131`), deletes the five `PI_*` vars, then re-sets them from the calling session - so a nested `pi --resume <parent-id>` inherits the parent's session ID while running as a descendant process. R9 observed: the bundled subagent spawns `pi --mode json -p --no-session` as a separate process (`examples/extensions/subagent/index.ts:300`).
- Nested resume case: chain is `parentPi → sh → childPi(node) → sh → lucid`. The owner (parent Pi) is an ancestor, but the child Pi's `node` runtime sits between command and owner, so the JS-runtime clause refuses. Correct, and it implements RFC 26:210's MUST-reject rule.
- Normal case: `lucid` (a compiled binary, base name `lucid`) under `sh`/`bash` presents no `node`/`bun`/`deno` and no owner-executable between command and owner. Passes.
- Two caveats, see D4 (minor): (a) JS-launcher indirection (`bunx`/`npx`/`yarn`/`pnpm`/`node script`) interposes a refused runtime - document the direct-binary requirement; (b) mixed npm/compiled-Pi installs can slip the check (npm owner's executable is `node`, a standalone nested `pi` binary is neither `node` nor the owner's executable) - pin the homogeneous-install assumption or compare resolved executable identity plus base-name `pi`. The probed homogeneous case is sound; failure direction is refusal except for the exotic mixed case.

R8's env-deletion rationale is additionally confirmed: `getShellEnv()` spreads all of `process.env` (`dist/utils/shell.js:115-126`), so factory-time deletion hides Lucid vars from every tool the model spawns. R10 confirmed: Pi's own `process.exit` calls are 0, 1, 129 (plus 143 for SIGHUP); exit 3 is unused. R11 confirmed: `passthrough: "after-argv"` with the no-separator comment ([pi.ts](hcn source)).

## Q4 - New defects, RFC 26 contradictions, Response tables

No RFC 26 contradiction found. Amendment 1 adds a distinct "pre-model" category without redefining RFC 26:240's "pre-start" pair; its retry rule (same input/session, new attempt ID, new notice, no auto-retry) matches 26:154, 26:240, 26:308. Binding retention across replacement matches 26:76. `pi-cli` stays out of `STOP_TRANSPORTS` ([native-listening.ts](../../src/cli/native-listening.ts:53)), matching Amendment 2. The attestation approach (Lucid-private marker, no hcn change) complies with ADR 0005. Response-to-v2 and Response-to-v3 rows audited accurate, except the D2 qualification below.

New findings, all minor (every failure direction is refusal or uncertain hold - safe):

- D1 (minor): attestation `reason` enum omits `verification-failed` used by step 9, and names no reason for an unparsable `LUCID_PI_ATTEMPT`. Required fix: add `verification-failed` (and the malformed-attempt reason) to the schema at line 377.
- D2 (minor): step 10's "Every user-message path goes through `emitInput`" and "classifies it as uncertain, never as a proven refusal" overstate - extension-command dispatch and `nextTurn` piggyback bypass `emitInput`, and the uncertain classification holds only in the refused-attestation case (a verified attestation plus a foreign bypass turn still lands row 1, acceptable under the same-user trust model but unstated). Required fix: qualify both sentences; no design change.
- D3 (minor): row-2 achievability at hcn level is unverified - no refused run's full kind list has been checked against the M2 exclusion set. Required fix: slice 2's four live cases (control, raced, folder mismatch, second-extension) must record full kind lists and confirm row-2 match; run the second-extension case in both load orders since handler order is registration order.
- D4 (minor): ancestry-rule caveats from Q3 (JS launchers; mixed npm/standalone installs). Required fix: document the direct-binary requirement and pin the homogeneous-install assumption (or compare resolved executable identity plus base-name `pi`).

Carry-over note, not a new finding: reload-while-helper-waits kill ordering remains unprobed future work (slice 4), already gated; person-input-during-delivery is now adequately mapped (followUp queue, outstanding-offer fence, no replay).

## Verdict: accept with minors

v5 closes every v4 finding - M1-M4, M7, N1, N3-N7 fully; M5/M6 with the minor schema and assumption gaps above. R13/R14 check out against Pi source. The ancestry rule is sound for the evidenced case and does not refuse normal `lucid` use. No blocking or major defects, no RFC 26 contradiction, no Response-table overclaim beyond D2's wording. Required fixes before implementation: D1 (schema enum), D2 (coverage wording), D3 (kind-list enumeration in slice 2, both extension orders), D4 (launcher guidance + install-homogeneity assumption).
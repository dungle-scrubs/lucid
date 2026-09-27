# RFC 35 v1 review

Reviewer: muse-spark-1.3-contributor@muse. Draft version 1, commit 24db959. Verdict: accept with minors. The full reviewer report follows unchanged, except that links to git-ignored probe logs are cited as probe logs and absolute links are made relative or named. v2 answers it in "Response to v1 review".


Review-only. No file was edited. All claims below were checked against primary sources: Pi 0.87.1 dist and docs, hcn 0.7.4 source, Lucid source at commit 24db959, the probe logs, and RFC 26 / 27 / 28 v6 / ADR 0005.

## Q1. Is the Pi settings source (step 4) a faithful copy of Pi's restoration rule?

Yes, with three edge-case fixes required. The core paraphrase (S8, step 4) matches Pi's code exactly:

- `buildSessionPath` starts from the selected leaf, else the last entry, and walks `parentId` to the root ([session-manager.js:124-145](Pi 0.87.1 dist/core/session-manager.js)).
- `getSessionContextSettings` starts thinking at `"off"`, lets each `thinking_level_change` replace it, and lets each `model_change` and each role-`assistant` message replace the model, so the last writer wins ([session-manager.js:146-161](Pi 0.87.1 dist/core/session-manager.js)).
- Leaf selection cannot disagree: on open, `_buildIndex` recomputes the leaf as the last non-header entry in file order ([session-manager.js:732-753](Pi 0.87.1 dist/core/session-manager.js)), and the live projection reads from that leaf ([session-manager.js:1084-1090](Pi 0.87.1 dist/core/session-manager.js)). A TUI-navigated leaf with no later append (`branch()` without append, [session-manager.js:1157-1162](Pi 0.87.1 dist/core/session-manager.js)) is forgotten by Pi itself on reopen, so hcn's "last entry" rule reproduces Pi, not just approximates it.
- Branches: siblings off the walked path are ignored by both. Compaction: the settings function walks the raw path, not the compaction-projected list (`buildContextEntries` is separate, [session-manager.js:201-229](Pi 0.87.1 dist/core/session-manager.js)), so `compaction`, `branch_summary`, `context_edit`, `usage`, `label`, and `session_info` entries are settings-inert on both sides. Forks get new session IDs (`forkFrom`), so the header-ID check excludes them.

F1 (minor). Missing parent: step 4 says a missing parent is `settings-unavailable`. Pi's walker silently stops and uses the partial path (`index.get` returns undefined, loop ends, [session-manager.js:137-144](Pi 0.87.1 dist/core/session-manager.js)). The RFC is stricter than Pi, in the safe direction (hold instead of resume). Required fix: label this an intentional strictness, not Pi behavior.

F2 (minor). Field-less settings writer: if the last `model_change` or assistant message lacks `provider`/`model` fields, Pi sets the model to `{undefined, undefined}` and falls back downstream. The RFC does not say whether hcn skips such an entry (which would bless a snapshot Pi will not reproduce) or refuses. Required fix: specify fail-closed - a settings-setting entry with missing or empty provider/model fields is `settings-unavailable`, never skipped. Reachability is nil for bound sessions (live Pi always attributes assistant messages; probes confirm), so this stays minor.

F3 (minor). "The first entry MUST be the session header" overstates Pi: `loadEntriesFromFile` skips blank and malformed lines, so the header must be the first *parsed* entry ([session-manager.js:325-369](Pi 0.87.1 dist/core/session-manager.js)). Corrupt-line tolerance also diverges (Pi skips the line and loads; a strict hcn reader refuses and Lucid holds), which is the safe direction. Required fix: say "first parsed entry" and note the hold-on-malformed behavior as intentional.

## Q2. Is a flagless fingerprinted resume sound as RFC 26/27 settings preservation for Pi?

Yes for the session-file triple (provider, model, effort). The probes confirm the mechanism the RFC relies on: flagless resume restores recorded values ([log.ndjson:1-18](probe log)), `--model` overrides leak into later resumes through assistant-message attribution while `--thinking` overrides are ephemeral ([log.ndjson:7-18](probe log), [log2.ndjson:4-9](probe log)). That asymmetry is exactly why flagless-plus-fingerprint is preferable to explicit flags, and it corroborates the rejected alternative. hcn's launch-only defaults (resolver never runs on resume, [plan-turn.ts:329-348](hcn src/cli/plan-turn.ts)) plus the probe spawn lines ([hcn-plain.err:1](probe log), [hcn-fresh.err:14](probe log)) confirm a fingerprinted resume spawns with no selectors to pollute the session. The fingerprint also closes RFC 28's P1 race one layer earlier: file removal between inspect and spawn fails re-inspection, so hcn refuses before spawn, with verify-after-open still behind it.

F4 (minor). The fingerprint covers the session file only. Ambient Pi configuration is outside it: `defaultThinkingLevel`/`defaultModel`/`defaultProvider`, system prompt, `defaultTools`, skills, extensions, the models registry, `defaultProjectTrust`, and `trust.json` ([settings.md:5-40](Pi 0.87.1 docs/settings.md)). These are identical between the TUI and the headless resume (same machine, same config) but can drift between inspect and spawn. Required fix: state the boundary - the snapshot is session-file settings; ambient configuration is out of fingerprint scope under the same-user, same-machine boundary, and Lucid passes no config-altering flags on the resume path.

F5 (minor). The `"else off"` fallback for sessions with no `thinking_level_change` is unverified against Pi's startup default (`defaultThinkingLevel` defaults to `"medium"`, [settings.md:13](Pi 0.87.1 docs/settings.md)). The probes show creation records the startup level (`tl:medium` on a fresh session, [log2.ndjson:10-12](probe log)), and bound sessions always have message history, so the fallback is unreachable in the bound lane. Required fix: either probe an entry-less resume or anchor `"else off"` to that bound-session invariant in the RFC.

F6 (minor). Two inspect-to-spawn gaps are unnamed: newly installed or changed extensions (discovery is on by default; extensions can register tools, vote on `project_trust`, and trigger turns outside the `input` gate per RFC 28 R13/R14) and trust-state edits. Required fix: name them in Security Considerations with the existing mitigations (attestation gate, same-user boundary, re-inspection).

## Q3. Is `continuation` the right transport selector? Is the absent-field default safe?

Yes to the mechanism, with a qualification on the default. Per ADR 0005, hcn owns harness differences and Lucid must not mirror descriptors or branch on harness names ([0005-hcn-owns-harness-differences.md](../../docs/adr/0005-hcn-owns-harness-differences.md)). An hcn-owned field is the conforming design, and holding on unknown values (Error Handling table) is the correct closed-world rule. This is also load-bearing today: Lucid maps *any* fingerprint to the Codex approval transport ([managed-execution.ts:250-265](../../src/modes/managed-execution.ts)), so without the branch the Pi lane cannot run.

F7 (minor). "A snapshot without it is a Codex snapshot from an older hcn" is stated unconditionally. Required fix: qualify it - absent means `native-approvals` for Codex snapshots only; a non-Codex snapshot with absent or unknown `continuation` is `invalid-native-settings` and held. Unreachable under the pin (the Pi source is born with the field), but transport confusion must fail closed in the spec, not just in current version arithmetic.

F8 (minor). The Lucid acceptance rule for permission-less snapshots is implied but not stated. Today `nativeContinuationSettings` rejects anything without a recorded user-reviewed read-only profile ([native-settings.ts:47-54](../../src/harness/native-settings.ts)), so the Pi lane needs an explicit change. Required fix: spell out that permission-less snapshots are accepted iff `continuation` is `"resume"`, and that absent `permissions` is never read as a grant (the MUST NOT is stated; the positive rule is not).

## Q4. Is `--extension` beside a fingerprint consistent with the fingerprint's purpose?

Yes. The fingerprint's purpose (RFC 27) is settings evidence plus refusal of caller selectors that would alter the restored run; hcn enforces that today only for Codex ([verified-native-settings.ts:20](hcn src/execution/verified-native-settings.ts), [native-settings-argv.ts:27-28](hcn src/interpretation/native-settings-argv.ts)). `-e` is code loading, not a selector: it loads even with discovery off and is repeatable ([cli.md:150-153](Pi 0.87.1 docs/cli.md)), and it runs under RFC 28's same-user trust model behind the attestation gate. The RFC already constrains the Lucid side (only the file it wrote) and refuses `--extension` on other harnesses pre-spawn. No contradiction with the rejected "passthrough beside a fingerprint" alternative: passthrough can carry selectors; the materialized extension file cannot.

F9 (minor). The refused-beside-fingerprint set for Pi names only model, effort, provider, and passthrough (step 7). The analogues of RFC 27's access/sandbox refusals for Pi - `--tools`, `--system-prompt`, `--append-system-prompt`, `--skill`, discovery toggles - are unspecified. Lucid never passes them on bound resume, so only non-Lucid callers could reach the gap, and Pi has no approval policy to subvert. Required fix: enumerate the full refused set for the fingerprinted Pi path or justify why the triple plus passthrough suffices.

## Q5. Project trust: is "narrow only" correct, and acceptable under RFC 26?

Correct, and acceptable. Pi's decision order is CLI override, then extension vote, then saved decision, then `defaultProjectTrust`, with non-interactive modes skipping unless the default is `"always"` ([security.md:59-80](Pi 0.87.1 docs/security.md)). Case analysis: no override is passed, so the resume sees the saved-or-default decision. A process-scoped TUI grant that was never saved resolves to skip under default `ask`/`never` (narrower); a saved decision is identical on both sides; default `always` loads on both sides (same). There is no case where the headless run loads more than the resume-time decision allows. RFC 26 requires exact identity and folder for headless admission ([26:146-156](26_interactive-artifact-conversation-continuity.rfc.md)) and has no trust-grant preservation requirement; Pi has no approval channel to preserve, so narrowing is the safe direction and needs no new authority.

F10 (minor). The RFC does not say why it passes neither `--approve` nor `--no-approve`. Required fix: one line - `--no-approve` would break saved-yes sessions including provider/tool extensions that sessions may depend on (RFC 28 step 10), and `--approve` would widen.

F11 (minor). The project `sessionDir` setting is read before trust resolution ([security.md:31](Pi 0.87.1 docs/security.md)), so a hostile folder could redirect storage. The defense is layered (hcn's own store resolution per RFC 28 slice 1, the fingerprint, verify-after-open), but the RFC never cites it. Required fix: cite the layering.

## Q6. Contradictions with RFC 26/27/28, or overclaims

No contradictions found. The RFC is consistent with staged implementation (RFC 27 keeps other interfaces held until their lane; this RFC is the Pi lane), layers with rather than replaces RFC 28's outcome table (fingerprint pre-spawn gate plus verify-after-open post-open gate), and its versioning story is safe in both directions (old hcn answers `unsupported-harness` so Lucid holds; old Lucid without `--extension` still runs the RFC 28 passthrough path against new hcn on unfingerprinted resumes).

F12 (minor). "It adds no new user-visible capability" overclaims: bound Pi notes will now be answered by the original session where they previously held. Required fix: rephrase to "no capability outside RFC 26's accepted scope."

F13 (minor). "A flagless resume cannot widen settings" and "the fingerprint proves the file did not change" need their qualifier: session-file settings and the session file respectively (see F4). Required fix: qualify both sentences.

F14 (minor). "Tests with recorded-shape session files" is ambiguous against the never-hand-write-fixtures rule. Required fix: state that Pi session fixtures are files captured from real Pi runs (e.g. the dead-provider probes), composed inline only where no recording shows the shape, and marked as such.

## Verdict

**Accept with minors.** The design is sound and its central claims verify against Pi's source: the restoration rule is faithfully copied, flagless-plus-fingerprint preserves the session triple without polluting it, `continuation` is the ADR 0005-conforming transport selector, `--extension` does not defeat the fingerprint, and trust narrows. Fourteen minor findings (F1-F14), no major, no blocking. The required fixes are all one-sentence to one-paragraph spec edits: fail-closed rules for field-less entries (F2) and non-Codex absent `continuation` (F7), the permission-less acceptance rule (F8), the ambient-config boundary (F4), the full Pi refused set (F9), trust justifications (F10, F11), and wording corrections (F1, F3, F5, F6, F12-F14).

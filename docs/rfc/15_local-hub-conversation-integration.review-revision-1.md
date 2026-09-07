# Review: RFC-15 Local hub conversation integration

## What was reviewed

| Field | Value |
|---|---|
| RFC | `docs/rfc/15_local-hub-conversation-integration.rfc.md` |
| Revision | 1 (frontmatter `revision: 1`) |
| Status | Draft |
| Type | feature |
| Date on document | 2026-09-07 |
| Reviewed | Whole document, lines 1-279 |
| Reviewer role | Independent cross-family reviewer, single careful pass |

Inputs read: `artifacts/planning/hub-discovery-resolution.md`, `hub-startup-resolution.md`, `hub-config-resolution.md`, `hub-title-resolution.md`, `hub-resume-resolution.md`; `/tmp/lucid-hub-session-resume/research/native-session-resume.md`; `CONTEXT.md`; `docs/architecture.md`; `docs/drivers.md`; ADRs 0001, 0002, 0003, 0004, 0005, 0008, 0009; RFC 14 revision 4 (Repeat-safe browser submission, Current content and restoration, hold and scheduling rules, Alternatives).

Source inspected: `src/cli/record-addressing.ts`, `src/store/store.ts`, `src/store/conversation-host.ts`, `src/store/log.ts`, `src/store/driver-preference.ts`, `src/store/deliver.ts`, `src/server/server.ts`, `src/server/driver-choices.ts`, `src/protocol/reducer.ts`, `src/protocol/frames.ts`, `src/modes/host.ts`, `src/modes/honor.ts`, `src/cli/harness.ts`, `src/cli/runtime.ts`, `src/harness/hcn-runner.ts`, `src/harness/runner.ts`, `test/protocol/reducer.test.ts`.

**Tool limitation.** The codebase-memory MCP server failed to connect this session (`CONNECTION_CLOSED`), and the graph CLI has repeatedly failed initialization against an active unverified generation. Every source claim below comes from direct file inspection, not from graph completeness. Call-site sweeps are best-effort. An unfound caller is not proof that none exists.

No live model ran. No tests were run. No files were edited. The uncommitted RFC 14 implementation in the working tree was read, not modified.

Evidence grades below use the evidence ladder in `~/.agents/skills/blast-radius/references/EVIDENCE-LADDER.md`. Level 1 is an assertion, level 2 a code citation, level 3 a traced execution path, level 4 an executed script, level 5 confirmation in the running system. Nothing here reached level 4.

## Structural results

```
$ bun /Users/kevin/.agents/skills/draft-rfc/scripts/validate-structure.ts docs/rfc/15_local-hub-conversation-integration.rfc.md
{
  "passed": true,
  "errors": [],
  "warnings": []
}
```

## Findings

### Blocking

---

**F1. R5 / State Machine (line 196) reverses RFC 14's held-input scheduling rule and re-adopts the alternative RFC 14 rejected.** Evidence level 2.

RFC 15 line 196: "Inputs remain ordered by accepted sequence; a held head input blocks later inputs from overtaking it. Existing comparison delivery guards remain in force."

RFC 14 line 180: "A held input MUST be skipped when choosing the next queue input. Other eligible inputs, including ordinary inputs, run in their original acceptance order."

RFC 14 line 281 records the rejection: "**Stop the whole queue behind missing comparison context:** preserves strict ordering but prevents a later ordinary request from producing a document that releases the hold. Skip only held inputs and keep acceptance order among eligible inputs."

Two problems, not one. First, the sentence contradicts itself: it asserts head-of-line blocking, then says the comparison delivery guards, which mandate skipping, remain in force. Second, head-of-line blocking makes RFC 14's only automatic hold-release path unreachable. RFC 14 releases a hold when a strictly newer artifact head appears. The usual way a newer head appears is a later input producing a revision. Block that input behind the hold and the hold never clears.

**Concrete failure:** a comparison note is accepted. Dispatch preparation fails `E-COMP-07` because the document exceeds the transport limit. The input is held at the queue head. The person types "shorten the document" as the next prompt. Under RFC 14 that ordinary input runs, produces a smaller v+1, and the newer head releases the hold. Under RFC 15 line 196 it never runs. The conversation stops with no recovery action, because RFC 14 line 178 forbids adding a Retry or Resume for held delivery.

Implementation cannot reconcile this. One of the two normative statements must be withdrawn, and RFC 14 is the accepted document.

---

**F2. R8 (line 152) places an agent-readable export inside the record. This contradicts ADR 0008 and the offered-path discipline, and the security claim on line 219 cannot be enforced at that location.** Evidence level 2.

R8: "Provide an agent-readable, conversation-scoped context export in the record's private derived area, plus a read-only CLI route for bounded retrieval of omitted messages and referenced content."

Security Considerations (line 219): "Agent-visible context exports MUST exclude record secrets, browser tokens, credentials, and unrelated records."

ADR 0008 (`docs/adr/0008-browser-and-agent-content-have-separate-authority.md`): "Attachments offered to an agent are copies outside the record, so a context path does not reveal the record directory." Its revisit clause: "Revisit each boundary only with a concrete threat model and equivalent tests; do not widen authority for convenience."

`src/store/deliver.ts:9-21` states the reason in operational terms: "A named attachment is **never** offered at its path inside the record. `secret` sits beside `files/`, and `secret` is the credential that authenticates a driver to the host - so naming an inside-record path is not a location leak to be weighed against convenience, it hands over the ability to attach to the conversation." And: "The agent reads the filesystem itself, so the only control is which path lucid says out loud."

**Concrete failure:** the export lands at `<root>/<conversationId>/<derived>/context.md`, and that path is named to the harness. The agent reads `../../secret` with an ordinary file read. It now holds the attach credential. It can attach as a source, forge frames, and take the epoch. The `MUST exclude` on line 219 constrains the export file's contents. It does nothing about what sits beside the file, and the location is the whole exposure.

RFC 15 does not list ADR 0008 in its normative references, does not state that ADR 0008 is being revised, and gives no threat model or replacement discipline. Either the export goes outside the record like every offered attachment, or ADR 0008 is revisited with the tests its revisit clause requires.

---

**F3. R5 says the log reducer derives eligibility, but the two most common hold causes live outside the log, and the Held-to-Pending transition has no fact to carry it.** Evidence level 2, traced to level 3 for the `driver.json` half.

R5 line 118 fixes the fact vocabulary: `requested`, `held`, `retry-authorized`, `fresh-authorized`, `attempt-started`, `attempt-ended`. It states: "The log reducer derives eligibility; an in-memory queue is not authority."

The State Machine (line 193) lists a transition the vocabulary cannot express: "Held | Applicable retry, fresh, or **folder remedy** authorized for current attempt | Pending". There is no `folder-authorized` or `settings-authorized` kind. `POST /api/conversations/:id/location` (line 167) must "Resolve a location hold for the referenced input only after validating its expected state", and the RFC does not say what it appends.

The settings half collides with an accepted ADR. `E-HUB-03` holds an input for invalid saved settings. The remedy is `POST /api/conversations/:id/driver`, which writes `driver.json`. CONTEXT.md line 88: driver preference is "Never in the log." ADR 0009: "The person's driver choice lives in an atomically replaced file. The log says what actually ran." A log-derived eligibility function cannot see the fact that resolves an `E-HUB-03` hold. The same holds for `workingDirectory`, which R2 puts in `meta.json`, also outside the log.

Line 120 gestures at an answer: "Recheck all dispatch prerequisites after any folder, settings, or recovery change." That is re-derivation from non-log state, which line 118 says is not authority. The two statements cannot both hold.

**Concrete failure:** a submission is held `E-HUB-04`. The person selects a folder. `meta.json` gains `workingDirectory`. No log entry is written. The worker, or the server's reconciliation pass, folds the log, sees `requested` followed by `held`, and derives "held". The input never becomes eligible. The person selects the folder again with the same result. The only remedy the UI can offer is one the model forbids: `retry` is scoped to "a known failure", and a folder selection is not one.

The RFC needs either a durable authorization fact for the folder and settings remedies, or an explicit statement that eligibility derives from the log plus named sidecar state, with the staleness rule for a `held` fact whose cause no longer holds.

---

**F4. Conversation identity comes from metadata (R1), but every addressing path in the code and in R9 resolves a record by directory basename, and the store tolerates a mismatch.** Evidence level 3.

R1 line 52: "The hub MUST enumerate published record directories under that root and derive their identity from saved conversation metadata. A basename or display title MUST NOT substitute for the saved identity. Duplicate identities MUST produce an explicit conflict, not an arbitrary choice."

R9 line 158: "IDs are opaque validated path components."

The code does the opposite, on purpose. `src/cli/record-addressing.ts:104-117` `verifyRecord` tolerates a basename mismatch by design: "Identity lives in `meta.json`, not the path (a moved record still opens under its own id), so basename mismatches are tolerated." `conversations().dirFor(id)` is `join(root, conversationId)` (line 192). `src/store/conversation-host.ts:157-161` reads the conversation id out of `meta.json`, not out of the path. Every server route resolves through `dirFor` (`src/server/server.ts:233, 373, 417, 469, 534, 574, 683`).

**Concrete failure A:** a record directory named `old-name` whose `meta.json` says `abc`. R1 lists it as `abc`. The person clicks it. The browser opens `/c/abc`. `GET /api/conversations/abc` resolves `dirFor("abc")`, finds no `log.ndjson`, and returns `status: "no record"` with an empty transcript. The hub has rendered a live conversation as empty.

**Concrete failure B, worse:** the person types into that empty view. `POST /api/conversations/abc/input` calls `conversations(rootDir).ensure("abc")` (`src/server/server.ts:782`), which mints a second record at `<root>/abc` with a fresh secret. The root now holds two records claiming identity `abc`, which R1 says must be reported as a conflict. The hub created that conflict by following its own contract.

**Concrete failure C:** genuine duplicate identities. R1's conflict rule covers discovery only. `dirFor` still resolves one of them by name, so read, save, restore, input, and driver writes all pick a winner while the list shows a conflict.

R1 needs a mapping rule from saved identity to directory, and the conflict rule needs to cover every addressing path, not the listing alone.

---

**F5. Context coverage is durable state with no specified storage, writer, or ordering discipline.** Evidence level 1 for the gap, level 2 for the surrounding constraints.

Terminology (line 38): "**Context coverage**: the record range confirmed supplied to a particular native session. This is not the executor's delivery cursor." R7 (line 142) gives it semantics: scoped to the native session, an exclusive sequence boundary, advanced only on evidence of consumption, with uncertain ranges that "cannot be skipped as if confirmed." The State Machine (line 191) treats a coverage update as an outcome of a completed turn. Line 196 rules that "A context coverage update or metadata mutation MUST NOT itself mark an input applied."

Nothing says where it lives. It is not in R2's metadata table. It is not among R5's six execution-fact kinds. It is not the delivery cursor, which Terminology excludes. It must survive process loss, because R7 exists to hold continuity across process, model, and harness changes, and because an uncertain range must stay uncertain after the crash that made it uncertain.

**Concrete failure:** a headless-turn worker resumes claude session `S`, supplies record range `(120, 180]`, and dies before the turn's terminal event. With no defined durable representation, the next worker either re-supplies from 120, which duplicates context in a resumed session and breaks R7 line 144 ("MUST NOT create duplicate user inputs"), or assumes coverage to 180, which advances on process spawn and breaks R7 line 142. Both branches are prohibited, and the RFC gives no third.

R5's fact family is the natural home, but it is keyed by input ID and attempt, while coverage is keyed by harness and native session ID. That mismatch is the design decision the RFC has not made.

---

**F6. RFC 15's recovery model and RFC 14's hold-recovery model state opposite rules, and E-HUB-06 duplicates E-COMP-07 with the opposite contract.** Evidence level 2.

RFC 15 line 175: "Retries require explicit user action after a known failure; there is no failure timer loop."

RFC 14 line 182: "Within one source participation, the failed preparation suppresses further attempts for that input until a strictly newer artifact head than the one recorded at failure is observed. **That observation permits one bounded preparation attempt at the next delivery boundary.**" RFC 14 line 178 states that this is not user-driven: the recovery guidance "does not add a Retry or Resume action for held delivery."

RFC 14 requires an automatic bounded re-attempt on an event that is neither a folder, settings, nor recovery change, which are the three triggers RFC 15 line 120 lists for rechecking prerequisites. RFC 15's model has no way to fire it.

The error tables collide too. `E-HUB-06` (line 209): "Required context cannot be prepared | Preserve pending input; retry after context availability is restored." `E-COMP-07` (RFC 14 line 255): "Required dispatch context unavailable, comparison delivery unsupported, or document exceeds transport limit | Hold accepted input pending; show the observed cause and applicable recovery guidance; await defined recovery trigger." A held comparison input whose document is too large satisfies both. RFC 15 line 154 says "Existing RFC 14 comparison context requirements take precedence over generic summarization", which covers summarization but not code selection or recovery-action selection.

**Concrete failure:** the transcript shows the same held note under both codes, or the hub offers a Retry that RFC 14 forbids, or the RFC 14 trigger fires an attempt that RFC 15's "no failure timer loop" rule was written to prevent. Which one happens is left to the implementer.

A second hazard follows. RFC 14's suppression is scoped to "one source participation." An RFC 15 headless-turn worker exits at idle and relaunches through the server's reconciliation pass, which R1 sets at no slower than five seconds. Each relaunch is a new source participation, so it resets RFC 14's suppression and produces a spawn-and-fail loop at the reconciliation cadence. Whether a `held` fact makes the input ineligible for launch is the detail that decides this, and R5 does not say.

---

**F7. R8's token-free access mechanism contradicts R9's blanket authorization rule, and the ambiguous word is "route".** Evidence level 2.

R9 line 158: "All routes use the server's existing same-origin custom-token authorization."

R8 line 152: "plus a read-only CLI route for bounded retrieval of omitted messages and referenced content. The access mechanism MUST work without the browser token."

"Route" names an HTTP endpoint everywhere else in the document, including the R9 table two paragraphs later. If R8 means an HTTP route, R9's MUST is violated and the server gains an unauthenticated loopback endpoint that projects conversation content. `src/server/server.ts:208` currently gates every `/api/` path on the token. An exempt path is reachable by any local process, and by a remote page through a subresource load that carries no `Origin` header, because `src/server/server.ts:188` rejects only requests whose `Origin` is present and foreign.

If R8 means a CLI subcommand, the sentence is fine and the word is wrong. The document must say which. The security consequence of the two readings is not the same.

A CLI subcommand does not satisfy R8 by itself either. It must name the record, which reopens F2.

### Major

---

**F8. R6's launch boundary does not require a sanitized child environment, and `LUCID_HARNESS` in the server's environment silently pins the harness for every worker it starts.** Evidence level 2.

R3 line 92 states the rule: "The hub passes its resolved selection explicitly; inherited process environment MUST NOT replace it." R6, which owns the launch interface, never mentions the environment.

`src/cli/harness.ts:54-59`: `resolveStartupHarness` sets `pinned: true` when `process.env.LUCID_HARNESS` is non-empty. `src/modes/honor.ts:141` passes that through `spawnOf(startupPref, deps.initialHarness, deps.harnessPinned)`. `docs/drivers.md:65-67` states the consequence: "an explicit `--harness` or `LUCID_HARNESS` wins over the preference and pins that dimension for the process lifetime."

**Concrete failure:** the person starts `lucid2 serve` from a shell where `LUCID_HARNESS=codex` is exported. Every hub-launched worker inherits it, pins codex, and ignores the per-conversation saved harness. R7's native-session rules then apply codex's session map to a conversation whose recorded session belongs to claude, so "Returning to a previously used harness uses its own recorded native session" resolves to the wrong harness. Nothing in the record explains why, because the pin is not a preference and leaves no trace.

R6 should state that a worker is spawned with an environment the server controls, and name `LUCID_HARNESS` and `LUCID_ROOT` as the two that must not leak in.

---

**F9. R4's "fallbacks on discovery" contradicts the migration rule against eagerly rewriting records, and would write during a read-only listing pass.** Evidence level 2.

R4 line 110: "Existing records without titles receive deterministic fallbacks on discovery."

Migration (line 246): "Existing records remain discoverable and readable without eagerly rewriting every record. Add metadata and completed preferences on creation, explicit edits, or first start as specified above."

"Receive" has two readings with different costs, and the document does not choose. If the fallback is persisted, discovery writes `conversationTitle`, `titleOrigin`, and `titleRevision` into every legacy record's `meta.json`. That is the eager rewrite the migration section forbids, and it happens under the append lock (R2 line 69) during an operation R9 describes as paginated summaries. If the fallback is derived at read time, R4's later rules break: "A generated result can replace only the fallback revision from which it was scheduled" needs the fallback to be a persisted revision, and R2 describes `titleOrigin` as metadata "present with a title".

**Concrete failure:** a root on a read-only mount, or a root the person browses while a terminal session holds the append lock. Listing 200 legacy records either fails, blocks on 200 lock acquisitions, or returns 503 under R1's own error contract, for an operation R9 calls a read.

---

**F10. Title generation has no owner process and no defined behavior when the conversation's settings are unresolved or its first input is held.** Evidence level 1.

R4 line 108 requires "one separate tool-free naming operation through hcn with the conversation's resolved model and effort", scheduled after the first durable text prompt, that "MUST NOT ... delay the user's turn", with attempt consumption persisted "before each model launch".

R3 line 92: "The settings bundle MUST be validated before the first start and persisted before dispatch." R3 line 98: "Persist the completed bundle on first submission/start, not on open."

R6 line 124: the server "MUST NOT hold the executor lease, construct another harness driver, or dispatch source effects inside an HTTP handler", and a launch request "names an existing conversation and eligible input".

Three gaps follow. First, no section names the process that runs the naming operation. R6 constrains the server, and the worker is scoped to an eligible input. Second, when the first submission is held, `E-HUB-04` for an unknown folder or `E-HUB-03` for invalid settings, there is no resolved model, so R4's precondition is unmet. The RFC does not say whether generation is held, skipped permanently, or deferred. R4's one-time rule ("Generating a title is a one-time operation") makes "skipped permanently" a live outcome, and probably an unintended one. Third, attempt consumption must persist before launch, which is a `meta.json` write under the append lock per R2, from a process the document has not named.

**Concrete failure:** a legacy record with damaged `driver.json`. R3 line 98 keeps it readable and blocks execution. The first text prompt arrives and is held `E-HUB-03`. The fallback title displays. The person fixes the settings and the turn runs. Does generation ever fire? R4 schedules generation after the first durable text prompt, which has passed. R4 also says a later trigger uses "the original first prompt where available". Both readings are defensible, and they produce different products.

---

**F11. Three existing endpoints mint records as a side effect, bypassing R2's atomic-publication MUST and R9's creation receipt.** Evidence level 2.

R2 line 69: "A new record MUST publish its identity and known folder association atomically before it is discoverable." R9 line 171: "The exact durable creation receipt is an immutable part of the new record metadata: creation ID and normalized creation request. It is included in atomic directory publication."

`src/server/server.ts` calls `conversations(rootDir).ensure(id)` at lines 659 (`POST /driver`), 731 (`POST /attachments`), and 782 (`POST /input`). `ensure` calls `createConversationRecord`, which writes `meta.json` as `{v: 1, conversationId}` and nothing else (`src/store/store.ts:49`). R9's table keeps `POST /api/conversations/:id/input` and `POST /api/conversations/:id/driver` as live routes and says nothing about their creation side effect.

**Concrete failure:** the browser posts a driver preference to an id that does not exist. A record is published with no `workingDirectory`, no `projectDirectory`, and no creation receipt. It is now indistinguishable from a legacy record: it appears under No project, and R2's legacy path asks for a working folder on its first prompt. A conversation created today through the hub inherits the migration path written for records created before the feature existed. The same route is the one R9 designates for saving settings, so choosing a model in a URL with a typo silently creates a record.

The RFC should say whether implicit creation survives, and if it does, that those paths carry the same publication contract.

---

**F12. Orphaned creation-staging directories carry a valid `meta.json` and would read as duplicate identities.** Evidence level 2.

R1 line 52: "Incomplete staging directories are not published records. Duplicate identities MUST produce an explicit conflict, not an arbitrary choice."

`src/store/store.ts:43-50` creates staging at `mkdtempSync(join(rootDir, ".create-"))` and writes a complete `secret`, `log.ndjson`, and `meta.json` inside it before `renameSync(staging, paths.dir)`. A crash between the writes and the rename leaves `<root>/.create-XyZ123/` with a valid `meta.json` naming a conversation id. The `rmSync` cleanup on line 52 runs only for a caught exception, not for process death.

The RFC states the rule and gives discovery no way to apply it. There is no marker file, no stated naming convention discovery may rely on, and no reaping pass.

**Concrete failure:** creation of `conv-7` crashes after the staging writes. The person retries, and `conv-7` is created successfully. Discovery now finds two directories whose metadata claims `conv-7` and reports a conflict under R1. A healthy conversation cannot be opened because of a crash artifact from a previous attempt, and the RFC gives no remedy. E-HUB-01's recovery is "Explain location/conflict; preserve other readable records; no guessed record."

If the intended rule is "skip dot-prefixed directories", say so. That is a contract discovery and the mint must share.

---

**F13. `attempt-ended` cannot record an outcome the State Machine names.** Evidence level 2, internal to the document.

R5 line 118: "`attempt-ended` records completed, pre-start-failed, or interrupted/uncertain outcome."

State Machine line 192: "Running | Failed/interrupted turn end | Uncertain or **failed-with-known-outcome**, retaining actual partial output and explicit recovery."

A turn that started, ran, and failed with a known terminal outcome is not `completed`, not `pre-start-failed`, and not `interrupted/uncertain`. The distinction matters: line 120 says an `attempt-started` fact without a confirmed outcome is classified uncertain and must not repeat side effects, while a known post-start failure can be described precisely and may permit a different recovery. `E-HUB-07` covers only "External outcome uncertain/interrupted", so a known post-start failure has neither a fact value nor an error code.

---

**F14. The migration's attach-time compatibility declaration is a source-protocol change the RFC neither specifies nor references, and R7 reverses a deliberate reducer rule without naming it.** Evidence level 2.

Migration line 248: "The migration needs an explicit compatible-driver declaration at attach and admission/dispatch checks; merely accepting unknown entries is not proof that an old driver honors them."

R5 line 118 says execution facts "use an internal versioned log-entry family, separate from source-protocol frames", so the declaration cannot ride there. It must ride on the `attach` frame, which is a source-protocol change: a new field, its validation, and the host's behavior when it is absent. `src/protocol/frames.ts:294-304` shows the decoder builds `attach` from named fields and drops unknown ones, so the change is forward-tolerant. The RFC names no field, no default, and no refusal.

Separately, R7 line 136 requires capturing native session identity "for both interactive and headless sources, attributed to the correct harness." `src/protocol/reducer.ts:549-551` does the opposite on purpose: "R008: interactive never resumes, so a harness on it is ignored rather than stored. Storing it would put ids in the map that no source may use." `test/protocol/reducer.test.ts:1530-1541` pins it as "an interactive attachment attributes nothing", with the comment "lucid does not own that process and must never offer its id to anyone."

R7 line 136 answers the ownership half of R008's reasoning ("Identity capture MUST NOT confer ownership over a living terminal process") and not the mechanism. The RFC should state that R008 is revised, and how the id is stored so a live terminal's session cannot be handed to a concurrent worker.

`docs/skill-chat-substrate.md` is the source-protocol contract and appears in neither reference list, though this RFC changes two things it owns.

---

**F15. R3's alias resolution depends on a field the harness seam discards on purpose, and the shipped default `model = "opus"` cannot be resolved through the current projection.** Evidence level 2.

R3 line 94: "hcn's public inspection owns canonical model IDs, aliases, effort vocabularies, and capability provenance. Resolve aliases before the first start or deliberate model change and save the concrete result."

`src/harness/runner.ts:56-60` defines `HarnessVocabulary` as `models`, `efforts`, `extensible`, `provider`, with the comment: "`vocabulary.models`, aliases resolved: hcn's list is already the canonical ids, and `vocabulary.aliases` maps pet names onto it, so the list is served as it stands." `src/harness/hcn-runner.ts:106-113` confirms the projection drops `vocabulary.aliases`.

hcn exposes the map and the seam throws it away. The default config in R3 lines 84-87 ships `model = "opus"`, an alias, and R3 line 94 requires resolving it to `claude-opus-5` before the first start. With the current projection there is no alias data above `src/harness/`, and ADR 0005 forbids re-deriving it: "Do not mirror its descriptors, flags, or model registry locally."

The RFC names hcn as the owner, which is correct, and does not state that `HarnessVocabulary` and `driverChoices` must carry the alias map. Without that, R3's central mechanism, resolve once and save concrete, has no data source.

---

**F16. R9's `/driver` route does not say whether whole-bundle replacement survives, and under the existing contract it silently clears a pinned concrete model.** Evidence level 2.

R9 line 166: "`POST /api/conversations/:id/driver` | Atomically save validated selected settings including profile and concrete model."

`docs/drivers.md:43-45`: "It replaces the bundle; omitted optional fields are cleared." `src/store/driver-preference.ts:145-167` implements that: `writeDriverPreference` builds the file from the fields present in the request and writes it whole. The comment on line 133 is explicit: "The whole preference, not a patch: a field left out is a field cleared."

R3 spends four paragraphs on never losing a saved concrete model: "An update to what `opus` names MUST NOT change a saved conversation", "Once a concrete saved model becomes unavailable, do not silently follow its old alias to a replacement." Replace-whole-bundle is the mechanism most likely to lose it.

**Concrete failure:** the person changes only the effort on a conversation pinned to `claude-opus-5`. The browser posts `{harness, effort}`. The model is cleared. The next start finds no saved model and falls into R3's legacy completion path (line 98), which fills either from "the last actual driver for the same harness" or from current user defaults. Current user defaults resolve `opus` afresh, possibly to a different concrete model than the one the person pinned. The pin the RFC works hardest to protect is lost by changing an unrelated dimension.

---

**F17. R7's resume requirement has no harness gate, and the pi and Muse limits from the research live only in Verification prose.** Evidence level 2.

R7 line 138: "Every headless turn with a usable native session SHOULD resume it." No harness carve-out. R6 line 128 extends it to terminal takeover: "the next eligible submission can use headless-turn and its captured same-harness native ID and cwd."

Verification line 256: "pi spelling drift and inaccessible Muse details from the research remain compatibility limits to resolve before advertising those specific native-takeover paths."

The research is more specific than the RFC's summary. `native-session-resume.md` records that hcn 0.6.1 renders pi's recall as `--session-id` while current pi documentation describes `--session <path|id>`, that installed pi compatibility is unverified, and that Muse's interactive and automation pages returned Not Logged In, so "current native continuity and missing-ID behavior remain unverified beyond hcn's contract." It also records that hcn's pi and Muse preflight refuses an uncomputable session path with `invalid-option-value`, exit 2, failure class `rejected`, which is the same class `src/modes/host.ts:842-916` currently reads as a refused resume.

A limit stated in a Verification paragraph does not constrain an implementation slice. The normative body should carry it: no native takeover for a harness whose resume path has not been confirmed against the installed binary. As written, slice 5's "Verify A-to-B-to-A continuity" passes against fake hcn for all four harnesses and ships an advertised pi takeover that has never run.

A second gap follows. Error Handling line 213 correctly refuses to read a broad `rejected` as proof of a missing session: "otherwise report the cause as unknown." R9 line 173 defines offers for two cases only: "A pre-start temporary resume failure offers Retry when applicable. A permanently missing native session offers Continue in a new session if a fresh launch can work." An unknown-cause `rejected` is neither, and line 213 closes with "Never offer an action known not to work." What is offered when the cause is unknown is undefined.

---

**F18. R6 declares a revision to CONTEXT.md, `docs/architecture.md`, and ADR 0001, and no implementation slice carries it.** Evidence level 2.

R6 line 132: "This revises the server boundary stated in CONTEXT.md, docs/architecture.md, and ADR 0001."

The Implementation Plan's six slices (lines 235-240) name no documentation work. RFC 14 slice 3 ends "Update each changed current artifact, source, driver, and design contract in this implementation commit."

The affected text matters and currently states the opposite. CONTEXT.md line 27: "The optional browser server is a local reader and appender, not the conversation driver." `docs/architecture.md:4-5`: "The browser server and other writers may append human input without becoming drivers." ADR 0001: "an optional browser server reads and appends to them. There is no coordinating daemon or socket transport."

ADR 0001's revisit clause is not satisfied on its own terms: "Revisit only if the product's users and scope change to require remote or multi-user coordination." The scope has not changed, so this is a revision the ADR's trigger does not authorize. That may be acceptable, because the ADR's substance covers transport and authorization and R6 preserves both. The RFC should say so rather than assert a revision the ADR does not contemplate. R6's defense, "No global coordinating daemon or additional message bus is introduced", turns on the word "global": a hub server that reconciles every five seconds and spawns per-conversation workers is a coordinating process, and a local, invocation-scoped one. Saying that plainly is stronger than the current sentence.

---

**F19. Browser-selectable working directories widen the failure bound past what Security Considerations claims.** Evidence level 2.

Security Considerations line 221: "The maximum failure impact is bounded to the selected local conversation and the workspace capabilities explicitly granted to its harness. This RFC introduces no broader harness tool grants."

R9 line 167: `POST /api/conversations/:id/location` saves "an explicitly selected valid working directory." R6 spawns a worker that runs a harness with that cwd. Before this RFC, the working directory of a lucid-driven harness is the directory the person ran the terminal command in. After it, the browser token chooses it.

The tool-grant claim is accurate: no new grants. "The workspace capabilities explicitly granted to its harness" now applies to a workspace the browser picks, which is any directory on the machine. The bound has moved, and the sentence reads as though it has not.

The mitigation may be that the token is loopback and same-origin, which is the existing boundary for input submission. That is a defensible position, and it is not the statement on line 221. Say what changed.

---

**F20. R1's reconciliation is scoped "while the hub is active", and R6 relies on it as the fallback that prevents a stranded input after a tab closes.** Evidence level 1.

R1 line 54: "a periodic reconciliation no slower than five seconds **while the hub is active**."

R6 line 130: "Closing a browser tab MUST NOT stop accepted work. ... A headless-turn worker can drain eligible work and exit at idle; it MUST release ownership and reconcile with incoming durable work so an idle-exit race cannot strand input. **The server's periodic reconciliation is the fallback.**"

R6 line 126 names a second pass with different scope: "At server startup and on its reconciliation pass, request workers for eligible accepted hub inputs with no executor."

The document uses "reconciliation" for a discovery refresh and for a launch sweep without saying whether they are one pass or two, or what "active" means: a server that is running, or a server with a connected tab. That distinction decides whether the safety net exists at the moment R6 promises it does.

**Concrete failure, if "active" means a tab is open:** the person submits, closes the tab, the worker hits its idle-exit race, and no pass runs until the tab reopens or the server restarts. The input sits accepted and unstarted, which is the outcome line 130 forbids.

### Suggestions

- **S1. "Eligible" carries the launch contract and is undefined.** It appears in R5's derivation ("The log reducer derives eligibility"), R6's launch contract ("eligible accepted hub inputs with no executor"), and the State Machine's Pending guard. Terminology does not define it. Given F3, the definition is where the folder-and-settings question gets settled. Evidence level 1.
- **S2. R3 narrows the approved XDG rule.** RFC line 77 falls back to `~/.config` only "when the variable is unset or empty", then states "XDG paths MUST be absolute" without saying what a relative `XDG_CONFIG_HOME` does. The approved decision (`hub-config-resolution.md`) says "Follow the XDG absolute-path rule", which treats a relative value as unset. Name the behavior. Evidence level 2.
- **S3. Two codes for one failure on one endpoint.** `E-HUB-02` covers "idempotency payload conflict". RFC 14 line 146 assigns `E-COMP-06` to "Reusing an accepted ID with different text" on the same `/input` route, and `src/server/server.ts:789` already maps `E-COMP-06` to 409. Say which applies when the payload carries comparison metadata. Evidence level 2.
- **S4. "Acceptance uncertain" sits in a state machine declared to derive from durable facts.** Line 179: "State is derived per accepted input from durable execution facts and existing dispositions." An input whose acceptance is uncertain has no durable fact by construction. It is a browser-side state and reads oddly beside the eight that are not. Evidence level 1.
- **S5. The revision of the refusal fallback is not scoped.** R3 line 100 and R9 line 173 replace `docs/drivers.md:75-79`'s rule ("A refused change keeps the current driver answering the input") with pending-input semantics. The RFC does not say whether a terminal-launched driver on the same record keeps the old behavior. Two drivers with opposite refusal semantics on one record is a defect with no owner. Evidence level 2.
- **S6. R2 cites a discipline that does not exist as one mechanism.** Line 69: "use the existing atomic file-replacement discipline under the record's append lock." `writeDriverPreference` (`src/store/driver-preference.ts:168-182`) does atomic replacement with no lock. `transaction` (`src/store/log.ts:1068`) holds the append lock for log bytes only. The combination is constructible, and `collectEffectsUnderAppendLock` shows the lock is reachable on its own. Calling it existing misstates what is there, and the `titleRevision` compare-and-swap in R9 depends on the lock half actually being taken. Evidence level 2.
- **S7. R1's paginated listing and R9's creation reconciliation pull in opposite directions.** R9 line 171 requires reconciling a lost creation response "against published records", which is a search by creation ID across the whole root, while R1 bounds listing work through pagination. Say that reconciliation is a full scan and is bounded by something other than the page size. Evidence level 1.
- **S8. R7's central resume requirement is a SHOULD where the decision is firm.** Line 138: "Every headless turn with a usable native session SHOULD resume it." `hub-startup-resolution.md` states it without hedge: "Continue to resume the current native session on later headless turns, not merely once after process recovery", and slice 5 gates on "repeated-turn same-session recall". A SHOULD makes the oracle optional. If the hedge exists for the harness-verification reason in F17, write it as a scoped MUST rather than a global SHOULD. Evidence level 2.

## Cleared

Checked and found sound. A later reviewer need not repeat these.

- **Two-entry atomic append (R5 line 116).** `transaction` in `src/store/log.ts:1068-1128` takes a single `Buffer` and rolls back to the pre-append offset with `ftruncateSync`, falling back to `truncateSync`. Two NDJSON lines concatenated into one buffer append and roll back atomically with no change to the seam. The requirement is implementable as stated. Evidence level 3.
- **Forward compatibility of a new log-entry family (R5 line 118).** `validEntry` checks the envelope only, and `knownEntry` narrows on `src/store/log.ts:141-149`'s `ENTRY_SOURCES`. An envelope-valid entry with an unrecognized `src` is skipped, not treated as corruption. An older binary opens a record carrying execution facts. Migration line 246's "old unknown log entries remain carried" holds. Evidence level 2.
- **Record-root precedence (R1 line 50).** `src/cli/record-addressing.ts:187-189` resolves `rootDir ?? LUCID_ROOT ?? ~/.lucid2/records`. R1 inserts user config between `LUCID_ROOT` and the default and preserves the rest, matching `hub-config-resolution.md`. One resolver already exists for CLI and server to share. Evidence level 2.
- **Summarizing with a model whose budget the history exceeds (R8 line 150).** The apparent circularity is closed by "Bounded multi-pass summarization MUST handle histories larger than one request."
- **RFC 14 precedence over generic summarization (line 154).** RFC 14 line 166 requires the full current document at dispatch, and line 176 forbids truncation to release a hold. R8's "If required current artifact bytes or another mandatory context item cannot fit or be read, preserve the hold instead of silently dropping it" is consistent with both. The conflict is in the recovery model (F6), not in the context rule.
- **Never crossing native session IDs between harnesses (R7 line 138).** Matches `docs/drivers.md:83-87` and the reducer's per-harness `harnessSessions` map (`src/protocol/reducer.ts:700-709`). No change required, and Alternatives line 228 records the reasoning.
- **Terminology coverage.** Every term defined in Terminology is used later. No term used normatively is undefined except "eligible" (S1). No dangling route, error code, or execution-fact kind other than those named in F3 and F13.
- **Attach-frame forward tolerance.** `src/protocol/frames.ts:294-304` builds the frame from named fields and drops unknown ones rather than refusing, so the migration's attach-time declaration (F14) is mechanically safe to add in both directions. The gap is specification, not feasibility.
- **Loopback binding and same-origin token (Security line 217).** Matches `src/server/server.ts:167, 188, 206-210`. The 401 behavior on line 213 matches `src/server/server.ts:209` and RFC 14 line 260.
- **Alternatives Considered.** All seven entries correspond to positions taken in the decision documents. No straw alternatives. The registration, resume-button, auto-fresh-fallback, cross-harness-ID, alias-following, rename-on-topic-change, and second-database entries each trace to a recorded choice.

## Not reviewed

- **The browser client.** `src/server/client/**` was not read. R9's UI behavior, the hub's responsive layout at 390, 768, and 1440 CSS pixels, and the interaction between the RFC 15 hub view and RFC 14's inline comparison editor are unexamined.
- **RFC 14 outside the cited sections.** I read its Introduction, Version provenance, Repeat-safe browser submission, Current content and restoration, hold and scheduling rules, state machine, error table, Alternatives, and slices. Its layout, diff-algorithm, and coverage-disclosure sections were not read, so an RFC 15 conflict with those is not ruled out.
- **The uncommitted RFC 14 implementation.** The working tree carries `src/protocol/content-comparison.ts`, `src/protocol/comparison-note.ts`, `src/server/client/content-comparison.tsx`, `src/server/client/input-recovery.ts`, and modifications to `log.ts`, `server.ts`, and `reducer.ts`. I read the `E-COMP-07` filter at `src/server/server.ts:109` and the comparison admission path at `src/store/log.ts:1201-1224` in passing. I did not audit that work, and no finding above depends on it being correct or complete. It is concurrent work and was left untouched.
- **Test suites.** Nothing was executed. Every finding sits at evidence level 3 or below. None reached level 4.
- **hcn's own source.** `node_modules/@dungle-scrubs/harness-cli-normalizer` was not read. Claims about hcn's alias exposure, resume grammar, and failure classes come from the research report and from lucid's projection of `hcn inspect`, not from the package.
- **Graph-verified call-site completeness.** Per the tool limitation above, this review asserts nowhere that no other caller exists.
- **`docs/skill-chat-substrate.md`.** Identified as an affected but unreferenced contract in F14. Its content was not read, so the exact shape of the attach change is not assessed.

Review attribution: Claude Opus 5 through hcn, high effort, route opus-5@claude.

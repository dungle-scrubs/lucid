<!-- Second cross-family review of RFC-07, Draft 2026-08-26, after revision.
     Reviewer: gpt-5.6-sol@codex, effort high, repository access.
     Routed by choose-model excluding both the claude family (which wrote the
     RFC) and the meta family (which reviewed the first draft), so this is a
     third family and not the first reviewer marking its own homework. The
     registry again warned that no route meets the high-stakes minimums for
     `plan`.

     Unlike the first reviewer this one had a shell, and several findings reach
     level 4 on the evidence ladder by folding synthetic logs through the real
     store. It could not run the structural validator (no network for `npx`)
     and could not get a clean test run (sandbox EPERM on `mkdtemp`), and it
     reported both rather than working around them. Verbatim. -->

# Review: RFC-07 - Many artifacts in one record, and the history you can move through

## What was reviewed

- **RFC path:** `docs/rfc/07_many-artifacts-in-one-record-and-the-history-you-can-move-through.rfc.md`
- **Version:** Draft, dated `2026-08-26`, revised after the first review
- **Pass:** Second cross-family review
- **First review:** `docs/rfc/07_many-artifacts-in-one-record-and-the-history-you-can-move-through.review-draft-2026-08-26.md`
- **Normative context:** `CONTEXT.md`, RFC-06, and RFC-04
- **Source:** `src/store/log.ts`, `src/store/conversation-host.ts`, `src/server/server.ts`, `src/server/client/app.tsx`, `src/server/client/layout.ts`, `src/protocol/artifacts.ts`, `src/protocol/annotations.ts`, and `src/protocol/events.ts`
- **Additional source used to trace R10:** `src/protocol/reducer.ts`, `src/protocol/ledgers/input.ts`, and `src/store/errors.ts`
- **Evidence ladder:** `~/.agents/skills/blast-radius/references/EVIDENCE-LADDER.md`

The repository remained read-only. `git status --short` was clean after the review.

## Structural results

The requested command was run exactly:

```sh
npx tsx ~/.claude/skills/draft-rfc/scripts/validate-structure.ts docs/rfc/07_many-artifacts-in-one-record-and-the-history-you-can-move-through.rfc.md
```

It exited 1. Its output, verbatim:

```text
npm error code ENOTFOUND
npm error syscall getaddrinfo
npm error errno ENOTFOUND
npm error network request to https://registry.npmjs.org/tsx failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org
npm error network This is a problem related to network connectivity.
npm error network In most cases you are behind a proxy or have bad network settings.
npm error network
npm error network If you are behind a proxy, please make sure that the 'proxy' config is set properly.  See: 'npm help config'
npm error Log files were not written due to an error writing to the directory: /Users/kevin/.npm/_logs
npm error You can rerun the command with `--loglevel=verbose` to see the logs in your terminal
```

No current structural pass or failure was established. The previous review's successful validator result was not treated as a substitute for this run.

### Repository gate

`bun run check` was run.

- Biome completed with 10 warnings.
- Both TypeScript checks completed.
- `bun test` started and reported `293 pass`, `191 fail`, and `484 tests`.
- The observed failures were sandbox `EPERM` errors when tests called `mkdtemp` under the macOS temporary directory.
- The command exited 1.

No alternate temporary directory or remote machine was used because that would work around the denied filesystem operation.

## Disposition of the first review

“Resolved” below means the revised requirement addresses the specific prior finding. It does not mean the surrounding section has no new problem.

### Findings F-01 through F-12

| Finding | Disposition | Check |
|---|---|---|
| **F-01** | **Resolved** | `Data model`, lines 401-413, now separates additive fields from an additive `src` and states the one-way deployment consequence. A real `foldLog` probe also carried an `artifact-meta` entry without rejecting the log. **Level 4.** |
| **F-02** | **Resolved** | `Endpoints`, lines 455-466, states that catalog fields are additive, old clients ignore them, and new clients tolerate their absence. It also acknowledges that the new POST routes do not exist yet. The table has a new formatting and route-count defect, reported below. **Level 2.** |
| **F-03** | **Resolved** | `R1` and `Security Considerations`, lines 614-625, now distinguish current behavior from the future constraint and prohibit joining `artifactId` into a filesystem path. The chosen validator creates a separate compatibility defect, reported below. **Level 2.** |
| **F-04** | **Partly resolved** | `R4`, lines 171-214, now covers one pane, names both minimums, states the narrow-viewport fallback, and chooses a persistence shape. The ratio does not survive viewport changes without reconciliation, and the two persisted values can still violate the minimums. **Level 2.** |
| **F-05** | **Resolved** | `R2`, lines 142-145, and `R12`, lines 371-379, keep retired artifacts outside the active list and require both recovery paths. **Level 2.** |
| **F-06** | **Resolved** | `Data model`, lines 426-435, assigns refusal to the endpoint and tolerant ignore behavior to the fold. The two layers no longer contradict each other for an unknown artifact. **Level 2.** |
| **F-07** | **Resolved** | `Data model`, lines 436-444, supplies a 200-character stored bound, endpoint refusal, and display-only truncation. The provenance and counting unit of 200 remain unspecified, reported below. **Level 2.** |
| **F-08** | **Resolved** | `R6`, lines 236-254, now says explicitly that read-only behavior is page-only, names the clients that can bypass it, and describes the asymmetric compatibility cost. `E-ART-03` also states that the endpoint accepts the save. **Level 2.** |
| **F-09** | **Partly resolved** | `R10`, lines 319-339, specifies queue targeting, independent sending, and send order. Its account of `INPUT_QUEUE_MAX` is only conditionally true, and its queue cardinality contradicts R3 and R7. **Level 3.** |
| **F-10** | **Partly resolved** | `R9`, lines 288-317, now selects a line-oriented byte diff, supplies a threshold, and defines `E-ART-08`. The claimed catalog-to-unreadable-version path does not exist in the current store, and the state machine cannot represent an unreadable current version. **Level 3 overall; the fold and read behavior reached Level 4.** |
| **F-11** | **Resolved** | `Scope`, lines 70-80, now distinguishes behavioral affordances from downstream visual treatment. **Level 2.** |
| **F-12** | **Resolved** | `Terminology`, lines 88-91, lists only the inherited terms the RFC uses and says `orphan` and `note box` are unchanged. **Level 2.** |

### The seven claims

| Claim | Disposition | Check |
|---|---|---|
| **Claim 1 - catalog is complete and the client picks one artifact** | **Resolved** | The claim remains correct. `viewArtifactCatalog` derives all indexed artifacts at `conversation-host.ts:420-451`; the client selects `artifacts[artifacts.length - 1]` at `app.tsx:932-937`. **Level 3.** |
| **Claim 2 - unknown `src` compatibility and the field/source analogy** | **Resolved** | The false analogy was removed. The requested synthetic `artifact-meta` fold consumed all 131 bytes, produced no entry or refusal, and did not throw. **Level 4.** |
| **Claim 3 - `artifactId` is stable identity** | **Resolved** | `ArtifactHeader.id`, `AnnotationBatch.artifactId`, artifact indexing, and save routing still use it as identity. The title remains separate. **Level 3.** |
| **Claim 4 - old-version page guard plus stale-save tolerance** | **Resolved** | The two policies are now explicitly separated. The existing save route accepts stale `basedOn` and reports `supersededSince` at `server.ts:381-416`. **Level 3.** |
| **Claim 5 - the resize rule is implementable** | **Partly resolved** | The missing branches and constants were added, but persistence and clamping remain contradictory. **Level 2.** |
| **Claim 6 - the state machine covers reachable states and errors** | **Partly resolved** | `UNAVAILABLE`, the comparison guard, and two-pane independence were added. Initial unknown artifacts, external retirement from non-LIVE states, unreadable current versions, and `E-ART-04` remain uncovered. **Level 2.** |
| **Claim 7 - sandbox containment and title exposure** | **Resolved** | The frame remains `sandbox="allow-scripts"` without `allow-same-origin` at `app.tsx:572-580`. Title text would render outside that boundary, so text-only rendering remains the correct requirement. **Level 3.** |

### Verdict on the declined wording in F-02 and F-03

The refusal is right.

An RFC for an unimplemented feature necessarily names routes and behavior absent from current code. Absence alone is not codebase drift. Drift would mean the RFC claims that current code already behaves differently from how it actually behaves, or requires a change incompatible with an existing invariant without acknowledging it.

The useful parts of both findings were still valid:

- F-02 identified version-skew requirements for the catalog response.
- F-03 identified a future path-safety requirement and correctly observed that no current filesystem path contains `artifactId`.

The revision applies those parts. It was correct not to preserve the “drift” label.

## New findings

### N-01 - R1 rejects artifact identities the record already accepts

**Section:** `R1 - The URL names the artifact`, `Security Considerations`

**What is wrong:** R1 requires `artifactId` to be validated “on the same terms as `conversationId`” at lines 129-130 and 620-622. Those identity domains differ today:

- `isArtifactField` accepts any non-empty string of at most 128 UTF-16 code units without C0 or DEL control characters at `log.ts:157-161`.
- `validConversationId` permits only a restricted ASCII path-safe alphabet at `errors.ts:50-51`.

A synthetic real-code probe used `artifactId: "plan/日本語"`. `foldLog` accepted and indexed it, while `validConversationId` rejected it:

```json
{"artifactId":"plan/日本語","indexed":true,"validAsConversationId":false}
```

**Why it matters:** R1 makes previously valid artifacts unreachable through the browser routes. This is not only a new-input validation choice. It changes reachability for records the current artifact parser and fold already accept. Path safety should come from encoding and from never joining the ID into a filesystem path, not from silently narrowing the stored identity domain.

**Evidence:** **Level 4 - ran the real fold and validator.**

### N-02 - The second pane has no specified opening action, and the URL cannot name two panes

**Section:** R1, R2, R3, State Machine

**What is wrong:** R3 requires one or two panes, but no requirement defines the transition from one pane to two:

- R2 says selecting an artifact loads it “into an artifact pane”.
- R3 only says what happens when another artifact is opened after two are already open.
- No action says “open beside”, no close action is defined for an ordinary pane, and the State Machine only describes the state inside an already existing pane.

R1 also has room for only one `artifactId` and one `version`, while R3 gives each pane its own artifact and version picker. R1 nevertheless says the address bar should always name what is on screen. It cannot name both pane states without a rule for which pane owns the URL.

**Why it matters:** The required two-pane state is not reachable through a specified user action, and a two-pane view has no deterministic deep-link or history behavior. Implementers must invent active-pane, replacement, browser-back, and reopen behavior.

**Evidence:** **Level 2 - traced the normative transitions and found no opening or URL-ownership rule.**

### N-03 - The queue identity and the claimed bounds contradict each other

**Section:** R3, R7, R10

**What is wrong:** Three different queue models are normative:

- R3 says each pane has a queue keyed by `artifactId`.
- R7 says queues are per `artifactId@version`.
- R10 says the bound is per pane and therefore two panes hold only two queues and at most 40 notes.

The current client follows R7. `notesByVersion` is keyed by `${artifactId}@${version}` at `app.tsx:653-660` and `app.tsx:828-840`. Notes can therefore remain hidden on an older version while a new queue is built on a later version. Repeating this across versions permits more than two queues and more than 40 unsent notes.

R10 also misstates `INPUT_QUEUE_MAX`:

- `events.ts:16-30` defines it as eight **in-flight inputs**.
- The in-flight count rises only after an `applied` disposition and falls on `done`, at `input.ts:17-28` and `reducer.ts:760-790`.
- `enqueueInput` checks the existing in-flight count but does not increment it at `reducer.ts:920-952`.

An unsent note queue counts zero. A sent annotation batch is one input, however many notes it contains. It becomes one of the eight only after delivery is recorded. “Two full queues are two of the eight” is therefore only true after both batches have been sent and applied.

**Why it matters:** R10 does not fully fix the stated unbounded-note defect, and an implementer cannot know whether queue state follows a pane, an artifact, or an artifact version. Its admission-control explanation also names the wrong lifecycle point.

**Evidence:** **Level 3 - traced queue state from the React map through encoding, enqueue, applied disposition, and terminal event.**

### N-04 - `E-ART-08` is not reachable through the current catalog

**Section:** R9, `E-ART-08`, Data model

**What is wrong:** R9 and `E-ART-08` claim that an oversized artifact version is named by the catalog but unreadable through `viewArtifactVersion`.

The real store does this instead:

1. `foldLog` records an oversized entry in `artifactRefusals`.
2. It does not add that version to `artifactIndex` at `log.ts:527-549`.
3. `viewArtifactCatalog` derives every artifact and version only from `artifactIndex` at `conversation-host.ts:420-451`.
4. `viewArtifactVersion` also uses that same index at `conversation-host.ts:457-465`.

The pure probe produced:

```json
{"artifactIndexKeys":[],"artifactRefusals":[{"offset":0,"issue":"artifact-too-large","artifactId":"too-large","version":1}],"readable":false}
```

The version is unreadable, but it is also absent from the data source used by the catalog. No RFC requirement adds `artifactRefusals` to the catalog.

There is a second state problem if the catalog is changed to include refusals. “Current version” is defined as the highest version in the record. An oversized highest version would therefore be current but unreadable. Error Handling says `E-ART-08` is observable only from `VIEWING_OLD` and `COMPARING`. No state represents an unreadable current version.

**Why it matters:** The specified recovery cannot occur. Current code returns the same null used for a missing version, while a conforming catalog change would create a state the RFC does not model.

**Evidence:** **Level 3 overall - traced the catalog and read paths. The fold/index/read subclaim reached Level 4 through the real code.**

### N-05 - `UNAVAILABLE` does not make the state machine total

**Section:** State Machine, Error Handling, R12

**What is wrong:**

- An unknown artifact loaded from a URL starts unavailable. It cannot transition from `LIVE`, because it never had a document to make live.
- `UNAVAILABLE -> LIVE` through un-retire applies only to a retired artifact. The same exit is impossible for an unknown artifact because the metadata endpoint must refuse unknown IDs.
- Retirement can arrive from another page or process while a pane is in `VIEWING_OLD` or `COMPARING`, but only `LIVE -> UNAVAILABLE` exists.
- `UNAVAILABLE -> (pane closes)` on choosing another artifact conflicts with R2, which says selection loads that artifact into a pane.
- Error Handling says every error names its observable state, but the closing map omits `E-ART-04 queue-full`. That error arises in `LIVE` and should leave the pane there.
- `UNAVAILABLE -> LIVE (on: un-retire confirmed)` is ambiguous beside R12's explicit rule that un-retiring requires no confirmation.

**Why it matters:** The added state covers labels but not all entry and exit conditions. Different implementations can strand unknown pages, keep retired comparison panes open, or close a pane where another implementation replaces its content.

**Evidence:** **Level 2 - direct comparison of the normative machine, R2, R12, and Error Handling.**

### N-06 - The persisted ratio must be reconciled on every viewport change

**Section:** R4

**What is wrong:** R4 says an artifact split ratio “survives a viewport change with no reconciliation”, then requires both persisted values to be clamped to pane minimums.

Let:

- `W` be the available horizontal width,
- `C` be the conversation width,
- `A = W - C` be the width left for two artifacts, excluding grips,
- `r` be the stored ratio.

The artifact widths are `rA` and `(1-r)A`. Both meet `DOCUMENT_MIN = 320` only when:

```text
320 / A <= r <= 1 - 320 / A
```

That legal interval changes whenever the viewport or conversation width changes. For example, with `W = 1000`, `C = 280`, and `r = 0.9`, the two derived widths are 648 and 72. The ratio must be reconciled.

The conversation width also needs a two-document upper clamp of approximately `W - 640`, not only a minimum. The existing `clampConversationWidth` at `layout.ts:20-25` reserves room for one `DOCUMENT_MIN`, because only one document exists today.

When the viewport cannot fit all minimums, R4 says to reduce to one artifact pane but does not say which pane survives, whether the other pane's state persists, or how two panes return when room comes back.

**Why it matters:** The stored shape does not preserve the stated invariants by itself. Without an order of operations, two conforming implementations can clamp different values or discard different panes.

**Evidence:** **Level 2 - requirements and current constants inspected; no implementation exists to run.**

### N-07 - The new 200 and 360 thresholds are presented as derived but have no source

**Section:** Data model, R9

**What is wrong:**

- The title bound is 200 “characters”. The source precedent uses JavaScript string length at 128, but the RFC does not say whether 200 means UTF-16 code units, Unicode scalar values, grapheme clusters, or encoded bytes.
- The comparison threshold says 360 is `DOCUMENT_MIN` plus room for change marks. The difference is 40 CSS pixels, but no mark, gutter, line-number column, scrollbar allowance, measurement, or existing token supplies that 40.
- A repository search found no implementation or recorded decision for either threshold outside this RFC.

The RFC may choose policy numbers. It should name them as policy and define their measurement instead of presenting them as derived from existing values.

**Why it matters:** Endpoint and fold validation can disagree on title length, and comparison layout can switch at different widths depending on what an implementation counts inside a column.

**Evidence:** **Level 2 - current constants and repository references inspected.**

### N-08 - The Endpoints table is malformed and its route count is false

**Section:** Endpoints

**What is wrong:** The Markdown table ends after the metadata POST row at line 459. Prose at lines 461-464 interrupts it, and the GET-version and POST-save rows at lines 465-466 are no longer part of the table.

The prose says “The three routes marked new do not exist today”, but:

- No row is marked new.
- Only restore and metadata are new routes.
- The catalog GET route already exists and is being changed additively.

**Why it matters:** The section that should be the integration contract renders as one table, one paragraph, and two loose pipe-delimited lines. It also misstates current server behavior while defending the RFC against a drift finding.

**Evidence:** **Level 2 - checked the Markdown and current routes at `server.ts:271-347`.**

### N-09 - Invalid `artifact-meta` payload behavior is not defined at the fold

**Section:** Data model, Error Handling

**What is wrong:** The revision distinguishes endpoint refusal from tolerant folding when metadata names an unknown artifact. It does not define what the fold does when a known artifact receives malformed metadata:

- an empty, oversized, or control-character title,
- a non-string title,
- a non-boolean `retired`,
- an entry containing neither field.

`E-ART-07` covers endpoint refusal for an oversized title, but no error or fold rule covers these durable entries. The RFC specifically says the fold must remain total over hand-edited logs and logs written by defective builds, so this is part of the stated compatibility boundary.

**Why it matters:** One implementation may throw `corrupt-log`, another may ignore the whole entry, and another may apply the valid field while ignoring the invalid one. Those choices produce different catalogs from the same append-only record.

**Evidence:** **Level 2 - compared all metadata validation requirements and error rows.**

## Cleared

- `CONVERSATION_MIN` is exactly 280 and `DOCUMENT_MIN` is exactly 320 in `src/server/client/layout.ts:9-15`. **Level 2.**
- An envelope-valid `artifact-meta` entry is carried by the current fold rather than rejected. The probe consumed all 131 bytes, produced no reducer entry, and did not throw. **Level 4.**
- The revised field-versus-source compatibility explanation matches `validEntry`, `knownEntry`, `coerceArtifactEntry`, and `foldLog`. **Level 4.**
- R6's stale-save tolerance matches the current save endpoint. A stale `basedOn` is accepted and returned with `supersededSince: true`. **Level 3.**
- F-05's separation of active and retired discovery surfaces is now internally consistent. **Level 2.**
- `E-ART-05` now has a sound reachability explanation: a race or non-page caller can request restoration of what became current. **Level 2.**
- Shared document mode plus per-pane read-only behavior is now specified: one pane may remain live while the other refuses selection because it is old, comparing, or unavailable. **Level 2.**
- Title rendering as text, never HTML, URL material, selector material, or path material, matches the existing iframe trust boundary. **Level 3.**
- The first review's refusal terminology for F-02 and F-03 was correctly rejected while retaining the useful compatibility and security requirements. **Level 2.**

## Not reviewed

- **Structural validity:** The required validator could not fetch `tsx` because network lookup of `registry.npmjs.org` failed. No alternative invocation was used.
- **Complete repository gate:** Tests were denied temporary-directory creation with `EPERM`. The gate is not green or red on product behavior from this run.
- **Codebase-memory graph:** `codebase-memory-mcp` was denied while creating `/private/tmp/cbm-daemon-501` because `chmod 0700` returned `EPERM`. It was not retried elsewhere. Material source ranges were read directly.
- **Running browser behavior:** RFC-07 is unimplemented, so no Level 5 confirmation of routing, two-pane layout, comparison, restore, rename, or retirement was possible.
- **Visual quality of comparison:** No comparison implementation exists to inspect or run.
- **Performance:** Catalog cost with many artifacts and versions, diff cost for near-1 MB documents, and persistence update frequency were not measured.
- **External ticket lineage:** Tracker issues were not needed to decide the revised RFC's internal and source-level claims and were not consulted.
- **Repository changes:** None were made.
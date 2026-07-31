# Learnings from plans 02-07

Extracted 2026-07-31, before those plans were deleted (plan 08 M20).
127 decisions across six shipped plans. This is the durable record; the
plan databases they came from no longer exist.

The code carries most of the *how* in its comments. What a ledger holds
that code cannot is the **why**, and specifically the alternatives that
were rejected - which is the part a future reader would otherwise have to
rediscover by trying them.

## 02-portable-review-records

### D-001 - Canonical project folder

<cwd>/.lucid/ is the single Lucid folder in a project; artifacts AND their review records both live inside it

**Why:** User's stated rule: one folder per project holding everything Lucid stores there. Engine already supports it - sessionPaths() derives the record from dirname(artifact), so artifacts inside .lucid/ yield records at .lucid/<name>/ with no code change

### D-002 - Runtime state location

Machine-local runtime state lives in a per-record run/ subdirectory inside .lucid/, NOT in an external XDG or ~/.lucid/state tree

**Why:** Gitignoring already provides machine-scoping; externalizing adds orphan-GC burden, breaks the documented server.json discovery scan, and contradicts the self-contained folder rule. rm -rf .lucid stays a complete per-project uninstall

### D-003 - Ignore rule shape

The record's .gitignore names run/ instead of '*', so log.ndjson, versions/, pasted/ and fork seeds are committable by default

**Why:** The current '*' (session.ts:140) is what makes the stated goal impossible - it ignores the history it is meant to protect. Naming a directory also stops the rule drifting as new sidecars are added

### D-004 - Migration mechanism

A one-time explicit migration replaces the open-time rename; migrateLegacySessionDir and legacySessionDir are deleted, not retained

**Why:** The open-time rename is wrong-direction under .lucid canon (it evacuates records OUT of .lucid), so it cannot coexist with the new layout. It also mutates disk as a side effect of reading, can half-complete, and refuses to merge when both paths exist - leaving two divergent logs and picking neither

### D-005 - Discovery model

.lucid is treated as an ordinary artifact directory the scan descends into; the special-case .lucid branch in registry.ts and the .lucid-stripping in sessions.ts are removed

**Why:** Under the canon the generic <dir>/<stem>/log.ndjson rule already resolves correctly - resolveArtifactPath probes a log that exists and reads state.artifact. The only change needed is letting the walk enter one dot-directory

### D-006 - Concurrency model scope

Portability is single-writer for this RFC; merge-safe event ids and content-addressed snapshots are a named future direction, explicitly out of scope

**Why:** seq is position-allocated (maxSeq+1, log.ts:140) and version snapshots are position-named, so two machines editing offline collide. Fixing that is a protocol change; moving the folder is not. Shipping the layout first delivers the stated goal under pull-before-review discipline

### D-007 - Backward compatibility

No compatibility period or dual-layout support; clean break with a one-time migration

**Why:** Two known installs (pro and air), both fully inventoried at 28 records. A compatibility shim added for zero third-party consumers becomes permanent

### D-008 - OQ-5 snapshot retention: measured, and deferred with a threshold

No pruning in this RFC. MEASURED on pro across all 10 real records (log.ndjson-bearing, excluding node_modules/.venv): total 1,224 KB, mean 122 KB, largest 312 KB (hub/lucid/build-out-plan, 11 snapshots). Version snapshots are the only non-regenerable content in a record, so the cost of keeping them is a rounding error against the cost of losing one. Retention becomes a real question at a stated threshold - a single record over ~50 MB, or a project total over ~250 MB - and the RFC names that trigger rather than a mechanism.

**Why:** The question asked for a size measurement before deciding; the measurement says the problem does not exist yet at two orders of magnitude.

### D-009 - OQ-3 current.html moves to run/, and reconciliation stops treating absence as change

current.html lives in run/ (derived, ignored, never synced). The trap the question names is real and is fixed in the same change: openSession's reconciliation (src/core/session.ts:249) computes , so a missing current.html mints a spurious version - which is exactly what a fresh clone would produce on first open. Reconciliation MUST fall back to the latest COMMITTED snapshot in versions/ when current.html is absent, and only treat a genuine hash difference as a change. A missing derived file is not an edit.

**Why:** Measured the code path rather than reasoning from the layout: absence-reads-as-changed is what makes current.html look non-derivable, and it is a three-line fix, not a reason to commit a serve target that would race the local one.

### D-010 - OQ-7 fork seeds are rewritten to record-relative paths

Yes. MEASURED: src/launch/seed.ts:56,46 embeds  (absolute) and absolute pasted-image paths via join(parent.sessionDir, ...). It is the only content file in a record that hardcodes machine-absolute paths, so it is the only thing that breaks on arrival at the other machine. Seeds are written record-relative; the launcher resolves them against the record dir it reads them from.

**Why:** Confirmed against the writer rather than assumed - the question's premise was right, and the fix is local to one file.

### D-011 - OQ-6 orphaned hash-named HTML files are listed, never adopted

The migration does not touch them. MEASURED on pro: ZERO hash-named HTML files without a record (the 41 are an air-local artifact of recovery dumps). A file with no log.ndjson is not a review record - it has no history to port - so adopting it would mint an empty record for a file nobody is reviewing. The migration REPORTS them (path and mtime) and exits; deleting them is a human's call, per machine.

**Why:** Measured both machines' shapes differ, which is itself the argument: a migration that guesses at unrecorded files does different things on different machines.

### D-012 - OQ-3 current.html moves to run/ (restated with intact text; supersedes D-009)

current.html lives in run/ (derived, ignored, never synced). The trap the question names is real and is fixed in the same change: openSession's reconciliation (src/core/session.ts:249) computes changed = (current === undefined) OR (hash of file differs from hash of current), so a MISSING current.html reads as changed and mints a version - which is exactly what a fresh clone would produce on its first open, a spurious v+1 with identical content. Reconciliation MUST fall back to the latest COMMITTED snapshot under versions/ when current.html is absent, and treat only a genuine hash difference as a change. A missing derived file is not an edit.

**Why:** Measured the code path rather than reasoning from the layout: absence-reads-as-changed is what makes current.html look non-derivable, and it is a small local fix, not a reason to commit a serve target that would race the local one. Restated because a shell quoting error truncated D-009.

### D-013 - OQ-7 fork seeds rewritten record-relative (restated with intact text; supersedes D-010)

Yes. MEASURED: src/launch/seed.ts embeds the parent's ABSOLUTE artifactPath (line 56) and absolute pasted-image paths via join(parent.sessionDir, pastedRelPath(...)) (line 46). seed.md is the only content file in a record that hardcodes machine-absolute paths, so it is the only part that breaks on arrival at the other machine. Seeds are written record-relative; the launcher resolves them against the record directory it reads them from.

**Why:** Confirmed against the writer rather than assumed. Restated because a shell quoting error truncated D-010.

### D-014 - OQ-1 <cwd> is the nearest git root

The nearest git root, walking up from the artifact. That repo owns its .lucid/, so nested repos each keep their own records - which is the point: a record must live in the repo that will actually commit it. reviewsion (6 nested repos) and readyagent (2) therefore get one .lucid/ per repo, not one shared folder at the outer root. src/core/sessions.ts already has this walk as projectRoot(paths), which stats for .git and falls back to the artifact directory; the resolver reuses it rather than growing a second implementation. Fallback when no .git exists anywhere above: the artifact's own directory, so a loose artifact outside any repo still gets a record beside it rather than one in the user's home.

**Why:** Human decision. The portability story is git-shaped, so the folder that owns records should be the one git owns; projectRoot() already implements the walk.

### D-015 - OQ-2 .lucid/ is committable, never auto-committed

Committable, never auto-committed. The record's .gitignore names run/ so nothing in the content class is blocked, and that is the entire mechanism - Lucid never runs git, never stages, never writes .gitattributes, and never warns about untracked records. Whether .lucid/ is tracked is the repo owner's decision, expressed the way every other such decision is: by adding it or not. The RFC's obligation is only that choosing to commit REQUIRES no further edits, which the run/ rule delivers.

**Why:** Human decision. Lucid stays out of the repo's staging decisions; the RFC's job is to remove the blocker, not to make the choice.

### D-016 - OQ-4 fork children are flat siblings

Flat siblings in .lucid/. A fork child is a first-class artifact with its own full record (migration-plan-fork-9f2c1a.html beside migration-plan.html, each with its own record directory). Two reasons measured against the alternative: every record keeps ONE shape, so discovery, migration and the ignore rule have no special case; and a fork of a fork nests without bound under the nested alternative, while flat is flat at any depth. Provenance is not lost - it lives in the log (the fork event and the seed) rather than in the directory tree, which is where the rest of a record's history already lives.

**Why:** Human decision. One record shape beats visible provenance in the tree, and nesting is unbounded under fork-of-fork.

### D-017 - OQ-8 sequenced after 00-e2e-coverage completes

This plan waits for 00-e2e-coverage to reach complete. That plan is at implementing with 20 current-cutoff items left (Phase 5 M5.2-M5.6, Phase 6), and its remaining milestones actively add e2e tests and harness fixtures against the CURRENT record paths - this RFC moves every one of them. Landing mid-flight would mean rebasing roughly 30 in-flight tests onto moved paths, and the harness surface was deliberately frozen (D-014) precisely so fan-out milestones would not chase it. The cost of waiting is bounded and known; the cost of interleaving is unbounded rebase churn against tests that are still being written.

**Why:** Human decision. Bounded wait against unbounded rebase churn on tests still being written.

### D-018 - OQ-9 migration ships as a repo script, deleted after both machines run it

A repo script, not a CLI subcommand: scripts/migrate-lucid-layout.ts, beside the other repo scripts, deleted in a follow-up commit once both machines have run it. Three reasons. It must ship in the repo because it has to run on air as well as pro, so a local one-off file is not enough. It must NOT become permanent CLI surface because `lucid migrate` is a command whose correct answer is "nothing to do" forever after two runs, and a subcommand that exists to be a no-op is surface nobody can delete with confidence later. And it is idempotent and reporting-first by construction (it lists the orphaned unrecorded HTML per D-011 rather than adopting them), so running it twice is safe and running it once is auditable. If a third machine ever appears before the deletion commit, the script is still there; if one appears after, the layouts are already canonical and there is nothing to migrate.

**Why:** Agent decision with the reasoning stated for override: a one-time operation for two machines does not earn permanent CLI surface, but it does have to travel in the repo to reach the second machine.

### D-019 - Landing strategy: main, branch per phase, B-code and B-data inseparable, Opus adversarial reviewer

Merge target main; one branch and PR per phase, EXCEPT that Phase B's code and data milestones ship in one PR because either alone leaves the system broken (code alone orphans un-migrated records, data alone produces a layout the shipped code misreads - the RFC's hard sequencing constraint). Independent reviewer is an Opus adversarial agent per PR; MB.4's review brief explicitly includes attempting to construct a fixture tree whose reversal manifest cannot restore it byte-identically. Ship via tool-proxy github, squash. complete means merged, migrated on both machines, and parity-verified.

### D-020 - No spike: the RFC resolved its unknowns by measurement before DECOMPOSE

The nine resolved questions did the spike's job: snapshot retention was measured (D-008), the current.html reconciliation semantics decided from the code (D-012), fork-seed contents inspected (D-013), and the inventory of all 28 records is Phase A's first deliverable rather than an assumption. The genuinely dangerous part - the migration - is de-risked by construction (fixture-tree tests, rename-only, reversal manifest, dry-run default) rather than by a spike, because the failure mode is data loss and the mitigation is mechanism, not information. Advancing decompose -> converge directly.

### D-021 - Phase letters map to RFC phase numbers, stated in the plan

A=0, B=1+2, C=3, D=4, E=5, written at the top of the Phases section. Letters exist so gate references cannot be confused with RFC phase numbers.

### D-022 - The inventory dedups by realpath and separates ephemeral scratchpad records from the durable migration target

MA.1's sweep revealed two things the RFC's '28 records' estimate did not anticipate on this machine. (1) macOS symlinks /tmp -> /private/tmp, and defaultRoots scans both agent-scratchpad roots, so the same physical record was counted twice; the sweep now dedups by realpath(logPath) - the same realpath identity plan 05 (#41) gives sessions. (2) Most records under the scan are EPHEMERAL agent-scratchpad artifacts under the temp root; M5.5 established /tmp as non-durable (open refuses it), so those are not portable review history. The inventory marks each record  (under the realpath'd tmpdir) and reports durableCount separately. The migration TARGET is durable records only; ephemeral records are inventoried for completeness but the discovery-parity check must not depend on volatile temp dirs surviving. Measured on pro: 15 records total, 10 durable (2 sibling, 5 nested, 3 unknown-orphaned), 5 ephemeral. This is a scope refinement within MA.1, recorded rather than regressed - it sharpens 'all existing records' to 'all durable records' consistent with the established durable/volatile model.

### D-023 - The air inventory is deferred - that machine is off; Gate A-B proceeds on pro alone

Operator (Kevin): air is powered off. inventory-air.json is deferred and will be produced before air runs its OWN Phase B later. Gate A-B for the pro migration proceeds on inventory-pro.json alone. This is safe because the migration is per-machine and all-or-nothing per machine (D-007): pro migrates against pro's baseline, and air migrates against air's baseline whenever it comes online. The cross-machine portability acceptance (commit on one, pull on the other) waits until both have migrated, which is Phase D and inherently blocked on air anyway.

### D-024 - The 3 orphaned junk records are deleted; the migration target is the 7 real durable records

Operator (Kevin): trash the junk, migrate the real ones. The 3 unknown-layout records (~/dev/lucid/.lucid/{asdf,test,test2}) were orphaned - their artifacts gone, 2-3 events each, clearly test junk - and are DELETED (untracked local dirs, safe). The migration target is the 7 real durable records: artifact-first (54ev), walkthrough (41ev), build-out-plan (34ev), workspace-overview (26ev), lkdfddf (15ev), hello (13ev), yo-yo (2ev). Also noted, not deleted: 5 empty aborted-create stubs under ~/dev/lucid/.lucid (another-test, random, some-plan, something, yo) have no log.ndjson so are not records and not in scope; they may cause an occupiedByOthers false-refusal (R6) if their stem is reopened, which the migration handles by refusing with a name.

### D-025 - Air's inventory AND migration are DEFERRED tracked follow-up, not skipped - the plan is not fully complete until air migrates

Clarifying D-023 (the framing was 'skip', the intent is 'defer'). Air is powered off; ALL of air's work - inventory-air.json AND the full Phase B migration on air - is DEFERRED, not dropped. It is tracked follow-up: when air comes online, it runs the inventory, then its own Phase B against that baseline, then Phase D's portability acceptance (commit on one machine, pull on the other, full history renders) which inherently needs both machines migrated. The PRO migration proceeds and completes independently now (per-machine, all-or-nothing per machine, D-007), but the PLAN as a whole reaches 'complete' only when air has also migrated. A deferred-follow-up item in the progress report carries this so it cannot be forgotten.

### D-026 - MB.4 fork-seed rewrite

Fork seeds rewritten RECORD-RELATIVE, not absolute-repoint

**Why:** D-013 + invariant table require record-relative for portability (absolute paths break when the record travels). Executor: [oldArtifactAbs -> relative(newRecordDir,newArtifact)], [<oldRecordDir>/pasted -> pasted]; longest-prefix-first. Seed -> '../beta.html','pasted/a1.png', no absolute leak.

### D-027 - MB.4 container gitignore

Container bare-* .lucid/.gitignore is DELETED, distinct from record rewrite

**Why:** record/.gitignore '*'->'run/' rewrite; container <D>/.lucid/.gitignore bare-'*' -> DELETE (would hide whole committed .lucid tree). planContainerGitignore, deduped by container; reversal restores.

## 03-cross-project-tab-bar

### D-001 - Tab subject naming

A tab is an open ARTIFACT, not a session

**Why:** Consistent with artifact-first (D18). Code keeps sessionKeys/HubSession/openTab as legacy naming, noted in CONTEXT.md, the same accommodation the payload's session field already carries.

### D-002 - Worktree grouping

Two worktrees of one repo share ONE tab group; the worktree is a qualifier on the tab, not a group of its own

**Why:** Matches the hub's existing resolveProject grouping (daemon.ts:266); separate groups per worktree would multiply groups and widen the bar for the same artifact count.

### D-003 - Glossary structure

One CONTEXT.md, no bounded-context split; the four-way 'session' overload is resolved by explicit disambiguation

**Why:** Lucid is one small app and CONTEXT.md already disambiguates the overload in the Artifact entry; a CONTEXT-MAP split adds a file to keep in sync for no clarity gain.

### D-004 - Stale discovery claim in CONTEXT.md

Corrected CONTEXT.md's 'there is no global session registry (D-065)' - Model B shipped ~/.lucid/registry.json and the hub unions it with a root scan

**Why:** src/core/registry.ts declares itself the global pointer registry; daemon.ts:316 builds the listing from it. This RFC rests on that listing, so the glossary could not keep denying it exists.

### D-005 - Project scope

Remove activeProject entirely: no scope filter on the tab strip, no rescope-on-activate, no persisted project in the tab state

**Why:** The filter hid open tabs and mutated the strip under the human as they navigated; it is the single thing preventing artifacts from several projects coexisting.

### D-006 - Projects drawer

Delete the projects drawer and its scope badge

**Why:** The drawer exists only to switch scope; with scope gone it has no reason to be fixed chrome. Its discovery value is already covered by the pick screen's project headings.

### D-007 - Add folder placement

Move AddFolder onto the pick screen (and expose it as a palette command)

**Why:** It is the one drawer job that must survive: an empty listing is usually a wrong root, not an absent history.

### D-008 - Open whole project

Drop openProject; artifacts open one at a time

**Why:** Artifacts are heavy to review and nobody wants ten at once; without scope to contain it, bulk-open is a tab flood.

### D-009 - Tab grouping

Group tabs by project, with one inline leading label per group on a single-row bar

**Why:** Writes the project name once instead of per tab, and gives structural spatial memory. A second row would cost a third of the chrome's vertical budget on the less important half of the label.

### D-010 - Group order

Groups are ordered by when the project was first opened and never reorder

**Why:** Recency-ordered groups would shuffle the whole bar on every project switch, which is the failure mode the scope filter already had.

### D-011 - Singleton groups

A one-tab group renders with the same group chrome as any other

**Why:** Collapsing singletons into an inline-labelled tab creates two visual grammars for the same fact; the space win only had to hold on average.

### D-012 - Tab label

Tabs show the artifact title only; the per-tab project suffix and its name-collision check are deleted

**Why:** Project now lives on the group label, so repeating it per tab is the redundancy grouping was meant to remove.

### D-013 - Overflow handling

Horizontal scroll with edge fades; no overflow menu and no left/right buttons

**Why:** Buttons occupy fixed space at both ends permanently, which is the space grouping just bought. Edge fades signal more-content without a hit target.

### D-014 - Drag to reorder

No drag-to-reorder in this milestone

**Why:** Grouping supplies spatial structure directly, and a tab's group is a fact about its artifact rather than a preference, so drag collapses to within-group reordering - thin value for real interaction cost.

### D-015 - Scroll into view

Every path that activates a tab MUST scroll it into view: click, palette, digit shortcuts, bracket stepping, ?s boot, the CLI open-tab event, and close-promotes-neighbour

**Why:** With grouping a new tab joins its project's run rather than the right edge, so it can appear off-screen; without overflow menus there is no other way back to it. Highest-risk gap in the change.

### D-016 - Attention transport

Attention state moves onto the hub listing and rides a separate, smaller SSE event rather than widening the listing row

**Why:** Background tabs past the 10-stream LRU cap cannot report attention from their own stream, so badges would freeze. Keeping it off the listing row stops a volatile field forcing a full-listing rebroadcast every poll.

### D-017 - Attention derivation cost

Derive attention by folding each artifact's log, cached against the log file's mtime and size

**Why:** Precedent is readTitle, which already mtime-caches to keep a quiet hub from doing steady disk work; without it every 2s poll would re-fold every log under the roots.

### D-018 - Attention states

Four states, precedence: question waiting > agent working > finished-and-unseen > settled. Unseen clears on tab activation and its lastViewedAt persists alongside the tab set

**Why:** A turn finishing while the human is elsewhere is the case the current three states miss, and it must survive a reload. It also retires the approved tick showing forever.

### D-019 - Picker and palette

Share one session-list component owning fuzzy match, project grouping, recency and the open-vs-openable split; the palette mounts it over a backdrop with contextual command groups, the pick screen mounts it inline

**Why:** The palette's extra groups are all session-scoped and therefore empty on a new-tab page, so the two surfaces are identical in exactly the state that matters.

### D-020 - Picker filtering

Fuzzy filter with no debounce

**Why:** cmdk already ships fuzzy scoring and the project name is folded into each item value; filtering a few hundred in-memory rows is sub-millisecond, so a debounce would only add lag.

### D-021 - Picker recency

The shared list carries a recency band above the project groups

**Why:** With every project listed, the few artifacts a human bounces between should not require scrolling to the right heading.

### D-022 - OQ-1: the group label is inert

Kevin's call, per the RFC's recommendation: a pure label, no click behavior. Revisit after real use shows whether groups get long enough to need scroll-to or collapse.

### D-023 - OQ-2: off-screen attention rides the edge fade

Kevin's call: the existing edge fade carries an attention marker when unattended attention exists in that scroll direction. Minimal pixels, and it answers exactly the question the attention feature exists for - a question must not sit invisible because its group is scrolled away.

### D-024 - OQ-4: the recency band is fed by the hub's lastSeen ordering

Kevin's call: shared across windows - what you touched anywhere is recent everywhere. Matches the hub owning the listing, and the multi-window harness that just landed in the e2e plan makes the shared model the testable one.

### D-025 - OQ-5: lastViewedSeq is per machine, shared across windows

Kevin's call: one origin, one marker set in localStorage - reading a tab anywhere marks it seen everywhere. Consistent with D-024 treating attention as machine-level state. The two-windows-clear-each-other behavior is therefore the DESIGN, not a bug: it is one human at one machine.

### D-026 - OQ-3 stays in Phase 1 as a measurement

Full-map vs delta for the attention event is decided by measuring the realistic artifact count under a typical root set during Phase 1, as the RFC already specifies. Default if measurement is unremarkable: full keyed map, because it is idempotent and matches how the listing already broadcasts.

### D-027 - The post-#72 edit surface: naming.ts, the pinned #56 test, tabbar-overlays, and the catalogue ledger

Review finding 1 resolved by naming the surface rather than redesigning: (1) Phase 2's deletions now touch client/chrome/naming.ts, whose tabLabel/byProject/tabScope back covered catalogue rows and 19 unit tests; the redesigned grouped bar REPLACES tabLabel's collides qualifier with group membership, which fixes e2e finding #56 (two same-titled artifacts in one project rendered identical labels) BY DESIGN - the pinned test in test/tab-labels.test.ts flips deliberately, and the catalogue row tabs-same-title-remain-distinguishable flips to covered with the new mechanism. (2) The drawer tests in tabbar-overlays.e2e.ts and the drawer's covered/declined catalogue rows retire WITH the drawer; the catalogue is the ledger of record and checkLedger enforces agreement, so Phase 2's definition of done includes a green coverage-check. (3) DECOMPOSE enumerates the exact catalogue rows touched.

### D-028 - Landing strategy: main, branch per phase, phases 1 and 2 in either order, Opus adversarial reviewer

Merge target main; one branch and PR per phase; phases 1 (hub attention) and 2 (scope removal + grouped bar) are independent and may land in either order, 3 needs both, 4 needs 2. Opus adversarial review per PR with mutation verification in the brief. Ship via tool-proxy github, squash. complete means merged.

### D-029 - No spike: the two uncertainties are scheduled measurements inside Phase 1

R2 (fold cost) and OQ-3 (map vs delta) are the only unknowns, both are measurements the RFC already places inside Phase 1 with a recorded number as the deliverable, and both have escape hatches that do not change the architecture (a separate attention poll interval; deltas on the same event). Nothing to validate before committing to the plan. decompose -> converge directly.

### D-030 - Converge pass 1 clean apart from a summary count

The only drift was the hand-counted summary (66) against the tool's count (74); corrected. Clear-fix class.

### D-031 - OQ-3 attention map size

Full attention map by default (no windowing)

**Why:** Measured artifact count across the realistic root set: pro 7 + air 23 = ~30 durable records post-migration. A full {id->attention} map is ~30 small entries per poll - trivially cheap; windowing would be premature. Revisit only past a measured bound.

### D-032 - Gate 1->3 idle cost (R2)

Idle attention cost = one statSync per artifact per poll

**Why:** The mtime+size cache folds only on change; an unchanged log is a single statSync + map lookup. At the measured ~30-artifact root set that is ~30 stats per POLL_MS tick with zero folds - accepted, no windowing needed.

### D-033 - M2.3 scroll centralisation point

Scroll-into-view centralised in the Tab component's active-flag effect, not in activate()

**Why:** Same single-choke-point guarantee (every path flips exactly one tab active), but render-safe: activate() runs before React commits a fresh tab, so a DOM query there races a tab that does not exist yet. The mutation (drop the one line) still reds the multi-path test.

### D-034 - R2: measured fold cost

Attention fold cost accepted: folds only on log change, idle is one statSync per artifact per poll

**Why:** Measured across the realistic ~30-artifact root set (D-031): an unchanged log is a statSync + map hit, zero folds (cache hit/miss on /hub/identity debug surface). Two full e2e gates ran the attention SSE under 198 scenarios with no latency findings. mtime+size keying verified against append-in-place by unit mutation.

### D-035 - Unplaced-group placement is provisional

A listing-unplaced tab groups alone; when the listing places it, it merges into its project's group even if that shifts later groups

**Why:** D-019 review finding #6: reachable only when a tab opens before its listing row exists AND a foreign group sits between. The provisional group is a placeholder, not a first-open commitment; pinning the transient position would freeze a wrong grouping instead. D-010's never-reorder applies to PLACED groups, which never move.

## 04-overlay-injection-hardening

### D-001 - Scope: injection boot + resolve complexity, five measured defects (#42-#46)

In scope: #42 CSP, #43 capture handlers, #44 anchor point, #45 base tag, #46 resolveElementAnchor complexity. Out: #47 self-rewriting and identity defects (plan 05), realm sandboxing (redesign), what the overlay does once booted.

### D-002 - The boot-independence invariant

The overlay's ability to boot and to resolve an anchor MUST NOT depend on any artifact-author-controlled property. Each of the five fixes is an instance; the invariant goes in CONTEXT.md so future injection changes are measured against it rather than rediscovering these.

### D-003 - #46 is here, not in plan 05

The huge-DOM hang shares the hostile corpus with the anchor-model defects but its trigger (sibling fan-out) and fix (one-pass index) live in the rendering/resolution path, not the anchor model. Placed with the injection fixes it resembles operationally.

### D-004 - Each fix's acceptance test already exists

Every defect has a passing-once-fixed hostile-corpus test and a HOSTILE_DEFECTS entry. A fix flips its test, removes its ledger entry, and moves its catalogue row to covered; the corpus guard enforces all three stay in agreement.

### D-005 - OQ-1: CSP fix overrides for the bootstrap only, not the document

Kevin's call: the bootstrap survives via an HTTP response-header CSP (or an injection-controlled nonce) that the document's meta CSP cannot tighten below. The artifact's own declared posture stays applied to its OWN scripts - a reviewer testing their CSP still sees it govern their code; Lucid does not leak into or strip the artifact's policy. Measured requirement unchanged: a document with script-src 'self' still boots the overlay.

### D-006 - OQ-2: injection uses linkedom to find the true body close

Kevin's call: reuse linkedom, already loaded server-side for anchor resolution - one parser for injection and anchors, no new dependency. It parses the whole document, but injection is once per load, not per poll (R3 measures it). This is the seam that fixes #44: the bootstrap splices at the document's ACTUAL body close, never a literal </body> inside a textarea/pre/comment.

### D-007 - OQ-3: #46 is an algorithmic fix; the size cap is deferred to measurement and owned by plan 05's confidence type

The 18k-sibling hang is fixed by making sibling-index computation one-pass O(n) rather than per-element re-scan - purely algorithmic, behavior-preserving on the existing anchor corpus (R4). Whether a genuinely enormous DOM ALSO needs a sibling-count ceiling with a low-confidence signal is deferred: measure after the O(n) fix, and if a cap is needed it consumes plan 05's confidence type (D-003, OQ-4) rather than inventing its own. The measured floor is that hostile-huge-dom resolves and lucid wait does not hang.

### D-008 - Review closed: five defects each have a measured acceptance test; three OQs resolved

The REVIEW stage confirmed each of the five defects (#42-#46) is already backed by a passing-once-fixed hostile-corpus test and a HOSTILE_DEFECTS entry, so the RFC does not need to argue the bugs exist - only decide the fix mechanism. OQ-1/2/3 resolved (D-005/006/007). No war-council: no design-level contradiction, the invariant (D-002) unifies the five, and each fix is independently shippable and reversible.

### D-009 - No spike: every defect is measured and every fix has a live acceptance test

DECOMPOSE produced no spike guide. The five defects are already measured (the hostile corpus), the two pure fixes (#44 splice, #46 index) have bun-testable seams, and the three boot fixes are verified by their existing fixtures. The one uncertainty - whether an enormous DOM still renders slowly past the O(n) fix - is a measurement scheduled inside M1.2 with a deferred cap, not a spike. decompose -> converge.

### D-010 - Converge pass 1 clean

No drift between implementation.md, progress-report.md, the RFC, and the ledger. The docs were written directly from the resolved decisions, so the first pass found nothing to fix.

### D-011 - M1.2 post-fix scale measurement

No cap needed now; deferred to plan 05's confidence type (D-007) with numbers recorded

**Why:** Post-fix: 18k flat siblings capture+resolve in 65ms in-process (was: >120s hang, killed); the full e2e loop on the hostile-huge-dom fixture (open, boot, pick, send, wait) completes in ~4s wall including browser startup. Render is human-time; no residual slow path measured worth capping.

### D-012 - CSP lift scope (D-019 Phase 2 review)

Lift only what a header may honor, grant the narrowest thing that works, and stop governing styles entirely

**Why:** The review found lifting a meta verbatim turns on directives a meta MUST ignore - report-uri makes a self-declared-inert document exfiltrate its URI and a sample - and that a nonce nullifies the author's 'unsafe-inline' (CSP3 6.7.3.2), which would silently strip a self-contained artifact's own styling and scripts. Now: META_IGNORED (report-uri/report-to/frame-ancestors/sandbox) dropped; the script directive gets the serving ORIGIN when 'unsafe-inline' is present and a nonce only otherwise; script-src-elem honored when present; styles moved to constructed stylesheets (adoptedStyleSheets), which style-src does not govern - so style-src is never touched and no style nonce exists; the nonce is no longer published on window.__LUCID__ (an artifact script could have minted its own <script nonce>).

## 05-anchor-resolution-and-session-identity

### D-001 - Scope: resolution TARGET and identity MEANING, four measured defects

In scope: #47 anchor resolves against saved not live DOM, #41 symlink identity, stem collision, both-layouts rule; plus a confidence output. Out: #42-#46 (plan 04), the layout migration (plan 02), rebasing old annotations (named not solved).

### D-002 - The resolution/identity invariant

A resolution or identity MUST be computed against what the human actually acted on, and MUST refuse visibly rather than resolve to a different thing while reporting success. A wrong answer reporting failure is recoverable; one reporting success is not.

### D-003 - Confidence is a first-class resolution output, shared with plan 04

Resolution gains a confidence beyond the true/false boolean so positional fall-through is distinguishable from an id/fingerprint match. Plan 04's huge-DOM cap wants the same type; whichever plan implements first defines it minimally (OQ-4).

### D-004 - Identity is realpath, collisions refuse not merge

Session identity becomes realpath(artifactPath); stem collisions disambiguate-or-refuse but NEVER share a log; both-layouts uses the canonical and leaves the legacy untouched. The dangerous direction - silent merge/misresolve-with-confidence - is what the invariant forbids.

### D-005 - Presence must not report the hub's own headless attend turn as an interactive human (fixed standalone 2026-07-28)

MEASURED live bug: with the hub in --attend mode, sending feedback on an artifact resumes its recorded session headlessly (claude --resume <id> -p per the registry recipe). A resumed conversation keeps its original kind:interactive in ~/.claude/sessions/<pid>.json, so livePresence reported the hub's own worker as 'running in claude-code · interactive', flapping to spawn each time a turn ended - with no human session anywhere. Root cause: presence trusted the session file's kind, and realPs captured only  (the executable name), so the -p that proves the turn is headless was invisible. Fixed standalone, not deferred into this plan: realPs now reads  (full argv), a pure headlessPidsIn() detects -p/--print, and livePresence sets interactive = kind===interactive AND not headless. Unit-tested (the exact attend-turn scenario: kind:interactive + -p argv -> live but not interactive), mutation-verified. The plan's OTHER presence/identity work (symlink #41, stem collision, #47 resolution) stands; this removes the presence-misattribution defect from its scope.

### D-006 - OQ-2: a stem collision REFUSES the second open with a named reason, never a shared log

Two artifacts in one directory that would derive the same record (plan.html and plan.md both -> <dir>/plan/) do NOT silently share a log and do NOT get a silently-disambiguated record. The second open is REFUSED with a named reason (the colliding path and the existing artifact), matching the invariant (D-002: refuse visibly rather than resolve to the wrong thing) and the existing occupiedByOthers posture in ensureSessionDirs, which already refuses writing a record into a non-session directory. Disambiguating by extension was considered and rejected as the default: it is more convenient but changes record naming silently, and the operator is better served by a loud refusal they resolve by renaming one file. Aligns with plan 02's D-016 (flat siblings) - a rename is the operator's fix in both.

### D-007 - OQ-4: plan 05 defines the resolution confidence type; plan 04 consumes it

The resolution confidence output (beyond the current match-or-null) is DEFINED here, because this plan needs it for #47's low-confidence floor and reaches implementation on it first; plan 04's deferred huge-DOM cap (04's D-007) consumes the same type if it is ever built. Minimal shape: resolveElementAnchor returns the matched element PLUS how it matched - 'exact' (lucidId or unique fingerprint) vs 'positional' (domPath fall-through). 'positional' is the low-confidence signal #47 needs; callers that only want the element ignore the second field, so it is additive.

### D-008 - Landing strategy: main, PR per phase, Phases 1 and 2 independent, Opus adversarial reviewer

Merge target main; one branch and PR per phase; Phases 1 (identity) and 2 (resolution confidence) are layout-independent and may land in either order, Phase 3 (both-layouts) sequences against plan 02. Opus adversarial review per PR; the M2.1 brief attempts a fixture where the confidence tag changes which ELEMENT resolves (R1 behavior-preservation). Squash merge. complete means merged.

### D-009 - No spike: the resolution and identity behaviours are all testable directly

No spike guide. #47 and the identity fixes have pure, bun-testable seams (resolveElementAnchor's match tag, realpath identity, the stem refusal), and hostile-self-rewriting plus the identity catalogue rows are the acceptance tests. The one open judgement - whether the low-confidence rate is tolerable - is only observable after Phase 2 ships (OQ-1's floor-vs-full-resolution), which is why it is a deferred follow-up, not a spike. decompose -> converge.

### D-010 - Converge pass 1 clean apart from a summary count

Only drift was the hand-counted summary (32) vs the tool (31 current); corrected. The docs were written from the resolved decisions, so nothing else diverged.

### D-011 - Artifacts live at <cwd>/.lucid, enforced

An artifact belongs at <cwd>/.lucid/<name>.html with NO exceptions; open must enforce it, not merely document it

**Why:** SKILL.md says <git-root>/.lucid (D-014) but nothing in the product enforces it, so an agent writing to <project>/lucid/<name>.html (the pre-plan-02 convention) produced a record at <project>/lucid/.lucid/ - internally consistent, wrong location, and found in the wild in ~/dev/hub. sessionPaths derives the record from dirname(artifact), which is correct and stays; what is missing is that  accepts any artifact path at all. Enforcement belongs in open: a non-canonical artifact path is refused (or relocated) rather than quietly served from wherever it was written.

### D-012 - A refusal creates nothing on disk

openSession performs every refusing check - log read, artifact read, structural validation - BEFORE ensureSessionDirs. The directory tree is created only once the open is going to succeed.

**Why:** Found while verifying M1.1's 'a broken symlink is a typed refusal, not a phantom session' box rather than ticking it: lucid open on a dangling symlink exited 1 with a typed ARTIFACT_ERROR and still left <stem>/ holding a lone .gitignore beside the artifact - litter named exactly like a real record, from an open that never happened. The same held for any structurally invalid artifact. readEvents already tolerates a missing directory, so moving the read earlier costs nothing. Mutation: restore ensureSessionDirs to the top of openSession - both refusal tests red.

### D-013 - Every hostile fixture declares its confidence, not only the one that is low

HostileFixture gains an optional confidence field and the loop asserts the delivered annotation matches it for EVERY fixture - undeclared means the field must be absent (an exact match). hostile-self-rewriting declares "low".

**Why:** Asserting only the declaring fixture would leave the other thirteen resolving however they like, and a fixture that quietly starts matching by position is exactly the #47 failure in a new place. The strong form makes the corpus a standing check that resolution stays exact where it claims to be. Measured: all fourteen pass, so nothing else in the corpus was silently positional.

### D-014 - capture.ts is NOT threaded with confidence

The tag is threaded to the server resolve site (payload.ts) and onward to the stored annotation, the wire and the card. client/shared/capture.ts keeps the element-only resolveElementInDocument.

**Why:** The overlay resolves against the LIVE DOM; the payload resolves against the saved bytes. Those are two different measurements, and the whole point of #47 is that they disagree - on a hydrated document the live resolution is exact while the saved-bytes one is a guess. Painting a live-DOM confidence next to a saved-bytes confidence would put two contradicting signals on one annotation, and deciding which is authoritative IS the live-DOM re-resolution work D-003 explicitly defers. M2.1's task list named capture.ts before that distinction was measured.

### D-015 - The escape hatch is the absence of a project, not a flag

There is NO opt-out flag for artifact placement. A path with no enclosing .git is accepted as-is, and that is the only exemption: an agent scratchpad has no root to be canonical against, and D-022's ephemeral records already live there. Inside a project the rule is absolute - <project>/.lucid/<name>.html.

**Why:** The maintainer's directive is 'all artifacts in <cwd>/.lucid, no exceptions'. A flag is an exception with extra steps: the misplacement this closes happened because an agent followed a stale convention, and an agent that would reach for the wrong folder will reach for the opt-out too. The no-project case is not an exception to the rule, it is the rule not applying - there is no project folder to be in.

### D-016 - Placement is judged against the artifact's nearest project root, not the process cwd

canonicalArtifactLocation walks up from the artifact for the nearest enclosing .git and requires <that root>/.lucid/<name>. The process cwd is not consulted.

**Why:** cwd is wherever the human happened to run the command, so the same artifact would be canonical or not depending on which directory the shell sat in - and an agent's cwd is rarely the project it is editing. The nearest root, not the outermost, so a package inside a monorepo keeps its own .lucid/ where someone working in that package will look.

### D-017 - A refusal that names a destination must name every part that has to move

assertCanonicalLocation names the record as well as the artifact whenever a record exists, with the consequence stated (the history is left behind and the next open starts at v1). The no-record case keeps the short message.

**Why:** The first version asked the human to move the artifact alone. Following it exactly discarded the review, and the reviewer reproduced that: version 1, zero annotations, old record orphaned. An instruction that destroys history when followed correctly is worse than the misplacement it corrects. Still no auto-move - naming both parts keeps migration the human's act while making the act complete.

### D-018 - Every writer of an artifact path must agree with the placement rule

The hub create route writes to <project>/.lucid/<name> and mkdirs it; plan render's default output lands in <project>/.lucid/ (an explicit --out is honoured, and a doc outside any project keeps the beside-the-doc derivation). The two refusal messages that recommended the pre-02 'lucid/<name>.html' now name ARTIFACT_DIR.

**Why:** Enforcing placement on the READ side while three writers emitted non-canonical paths made the product argue with itself: create spawned an agent whose first command was refused, and render printed a 'next: lucid open <path>' the CLI rejects. A rule enforced at one end and violated at the other is worse than no rule.

### D-019 - A flat artifact folder needs path-qualified names

planArtifactPath folds the doc's project-relative directory into the artifact name (.plans/05-x/implementation.md -> plans-05-x-implementation.lucid.html), truncating with an 8-char digest of the full relative path past a 120-char budget. runPlanRender mkdirs the artifact folder before writing.

**Why:** The tree used to supply uniqueness and .lucid/ is flat, so the location has to live in the name or same-named docs collide. Collision here is not merely a lost file: the overwrite keeps the basename, so the stem-collision guard passes and the next open appends a version to the WRONG document's history. Re-rendering the same doc still overwrites its own artifact, which is what idempotent render means.

### D-020 - Placement sameness is decided by the filesystem, on the directory

canonicalArtifactLocation falls back to comparing realpath(dirname(abs)) with realpath(dirname(canonical)) before refusing. The basenames are equal by construction, and comparing directories covers the artifact that does not exist yet.

**Why:** F7's first fix tested the benign direction only. Where the on-disk folder IS , a string comparison produced a demand nothing could satisfy: the canonical path already was the file, mkdir failed EEXIST, and the lowercase spelling realpath'd back to . On a case-sensitive filesystem the two directories differ and the refusal correctly stands, so one comparison gives the right answer on both.

### D-021 - Placement sameness is decided by the filesystem (D-020 rationale, repaired)

Supersedes D-020's rationale text only; the decision stands as recorded there.

**Why:** F7's first fix tested the benign direction only. Where the on-disk folder IS dot-Lucid (capital L), a string comparison produced a demand nothing could satisfy: the canonical path already was the file, mkdir failed EEXIST, and the lowercase spelling realpath'd back to dot-Lucid. On a case-sensitive filesystem the two directories differ and the refusal correctly stands, so one comparison gives the right answer on both. [D-020's rationale lost two path spellings to shell backtick expansion when it was written.]

### D-022 - The path fold must be reversible, not merely descriptive

encodeSegment doubles a literal hyphen to '--', segments join on a single '-', and a leading dot becomes a 'dot-' prefix (a real dot-x directory encodes as dot--x, so the escape cannot collide with it). Runs of hyphens are even for escaped hyphens and odd where a separator sits, which makes the name decodable and the mapping one-to-one. Budget is 200 BYTES, and truncation walks code points.

**Why:** Declining the existence check is only safe if the name function is injective; it was not, and the failure is silent in the worst way - the basename survives an overwrite, so the collision guard passes and annotations carry forward onto an unrelated document. Bytes rather than UTF-16 units because NAME_MAX is 255 bytes on ext4, which is any Linux checkout of a committed record, and one CJK character is three bytes to one unit. Code points rather than slice because a split surrogate pair is a filename that is not valid UTF-8, in bytes meant to travel between machines.

### D-023 - Stop hand-rolling a reversible encoding; make the collision LOUD instead

runPlanRender stamps the source doc into the rendered page and refuses to overwrite an artifact whose recorded source differs, with --force to override; re-rendering the same doc still overwrites. flatName becomes a readable slug plus a 12-hex digest over the canonical (segments, stem) pair - collision-resistant rather than provably injective, and never starting with a hyphen. A brute-force sweep over the encodings' own special characters is kept as a permanent property test.

**Why:** The design only needed injectivity because the existence check had been declined, and three attempts to prove injectivity by construction all failed - the fourth was correct and unusable, producing filenames beginning with '-' that every CLI tool reads as a flag. The refusal makes the whole class loud regardless of how good the name function is, which is the property that actually matters: silent overwrite plus cross-session version contamination is the harm, and a refusal is not. The sweep is what holds the remaining claim up, because targeted tests only ever assert the cases someone imagined.

### D-024 - The source stamp is realpath'd, project-relative, and read only from the head

runPlanRender records the doc realpath'd and relative to the project root (absolute only when there is no project); planArtifactPath derives from the realpath too, so a symlink and its target are ONE artifact. renderedSourceOf reads only the head and unescapes in the reverse of the escape order.

**Why:** Three review nits, each cheap and each a real hole. An absolute path in a file meant to be committed compares equal to nothing on another machine. Deriving the artifact path from the un-realpath'd doc minted two artifacts and two sessions for one document, which contradicts M1.1's own identity rule in the same plan. And unescaping &amp; before &quot; - while never unescaping &lt; at all - meant a doc whose path contains < could not match its own stamp and could never re-render its own artifact without --force.

## 06-embedded-solo-surface

### D-001 - Surface detection channel

LUCID_SURFACE=embedded via per-harness integration files; never sniff the host app's env

**Why:** Desktop apps' own env vars are undocumented and unstable; the LUCID_* channel is proven to survive them (Codex delivered LUCID_HARNESS/SESSION_ID/MODEL into the log stamp). Opt-in, same trust model as the attendant stamp.

### D-002 - Solo URL plumbing

Reuse the existing shell-free mounts: per-session server root, or /s/<id> when hub-hosted; open returns it and skips openBrowser when embedded

**Why:** session-host.ts is already the shared solo body; the hub stays the single appender - no second process, no split-brain. The gap is only which URL open hands back.

### D-003 - Embedded feedback default

Drain-at-turn-start (lucid wait --timeout 0) is the embedded default; attend gated on harness presence detection; background wait per-harness where the process manager feeds back

**Why:** Recording needs nothing (append + SSE already live). The drain is fully reliable with no concurrency hazard; attend risks two writers on one conversation until codex presence (lsof on the rollout file, separately filed) lands; background wait fits Claude Code, not Codex.

### D-004 - Terminal status quo

Terminal harnesses keep blocking lucid wait as default; routing lives in each harness's integration file

**Why:** One integration file per harness carries the whole behavior set, including LUCID_SURFACE.

### D-005 - The solo URL is the existing viewer route

Solo URL = <origin>/s/<id>/__lucid/viewer when hub-hosted, <origin>/__lucid/viewer on a dedicated server - no new route

**Why:** REVIEW verified against the code: session-host.ts already serves /__lucid/viewer (renderViewer, base-aware) and the daemon routes /s/<id>/* into the same host body, so a hub-hosted session ALREADY has a shell-free full-review-UI URL. The RFC assumed /s/<id> (the artifact-with-overlay mount root) - that is the iframe body, not the review UI. viewerUrl() currently returns the SHELL url (/?s=<id>) for hub-hosted sessions; the change is a second URL builder, not a new surface.

### D-006 - Surface never changes process topology

LUCID_SURFACE=embedded changes only which URL open RETURNS and that the browser is not launched; hub-if-up-else-dedicated preference is untouched

**Why:** The accident that worked was exactly this topology. Surface is a presentation concern; making it start or avoid a hub would couple an output decision to process management and could strand a session outside the listing.

### D-007 - Output shape under embedded

The existing  field carries the solo URL; no new field

**Why:** One field changes meaning under an explicit opt-in the integration set; every existing consumer keeps working, and an agent surfacing  in its pane needs no new vocabulary. A parallel soloUrl would leave two URLs for one surface and a choice the agent could get wrong.

### D-008 - Feedback delivery scope

Integration docs only - no Lucid code for the return path

**Why:** {
  "error": {
    "code": "USAGE",
    "message": "Missing argument <file>",
    "detail": {}
  }
} already drains non-blockingly and the recording side needs nothing (annotations append regardless of listeners; SSE already updates the viewer live). The per-harness integration file carries drain-at-turn-start with cursor carry-forward. Attend mode stays gated behind the separately-filed harness presence work; background-wait stays a per-harness choice.

### D-009 - Output shape under embedded (supersedes D-007 text)

The existing "url" field carries the solo URL; no new soloUrl field

**Why:** One field changes meaning under an explicit opt-in the integration set; every existing consumer keeps working, and an agent surfacing "url" in its pane needs no new vocabulary. A parallel soloUrl would leave two URLs for one surface and a choice the agent could get wrong. (D-007 was recorded with its backticks eaten by the shell - this is the intact text.)

### D-010 - Landing strategy

main; one branch per phase; PR per phase; Opus adversarial review per PR; squash via tool-proxy github

**Why:** Matches every plan in this repo. The Phase 1 review brief specifically attempts to make the NO-env path differ from today, because that is the regression this plan could plausibly introduce.

### D-011 - No spike needed

SPIKE is skipped - the plan's only technical assumptions were verified during REVIEW by reading the routes

**Why:** The RFC's assumptions were (a) a hub-hosted session has a shell-free viewer URL and (b) the drain exists. Both were checked against source in REVIEW: session-host.ts:861 serves /__lucid/viewer through renderViewer, daemon.ts routes /s/<id>/* into the same host body, and wait.ts documents --timeout 0 as a drain. R1 (the pane rendering loopback) is already evidenced by the observed accident and has an escape hatch rather than an experiment.

### D-012 - Embedded suppression is proven by an ABSENT open-log entry

The embedded path must not call openBrowser at all, so LUCID_OPEN_LOG contains no entry for that open. The e2e asserts absence of ANY entry, never merely absence of kind browser, and never sets LUCID_NO_OPEN (which would log a skipped entry and mask the regression).

**Why:** recordOpen (src/cli/self.ts:140) logs kind skipped when LUCID_NO_OPEN=1 suppresses the launch. Absence-of-browser is therefore satisfiable two ways, one of which is the suppression mechanism we are NOT using. Pinning the assertion to an empty log makes the named mutation - restore the openBrowser call - red for the right reason.

### D-013 - soloViewerUrl intentionally builds the URL viewerUrl avoids

soloViewerUrl returns <hub>/s/<id>/__lucid/viewer - the shape viewerUrl's comment records as rejected. The rejection holds for the SHELL (a viewer inside the shell window nests a second chrome) and does not hold for an embedded pane, where the chat app is the window and no outer chrome exists. M1.2 must also amend viewerUrl's comment to scope its rejection to the shell and point at soloViewerUrl, so the two functions do not read as contradicting each other.

**Why:** The nesting hazard is a property of the surface, not of the URL. Leaving the old comment unscoped leaves a documented decision that the new code appears to violate, which invites a future maintainer to delete soloViewerUrl as a mistake. Scoping the comment converts an apparent contradiction into the surface distinction the plan is built on.

### D-014 - Single override point at the url ??= site, and the surfacedInShell control

Embedded overrides the URL at ONE place - run.ts:176, after identity is guaranteed non-null - replacing 'url ??= viewerUrl(identity)' with a surface-aware selection that DISCARDS any viaHub.shell already assigned. The two hub branches keep assigning viaHub.shell untouched. Separately, because run.ts:178 already skips openBrowser when surfacedInShell is true, every launch assertion must pin surfacedInShell: the hub-up scenarios run with NO live shell window, so the default arm genuinely launches and the embedded arm's empty log is attributable to the surface and nothing else.

**Why:** One override point keeps the default path provably byte-for-byte unchanged (the two hub assignments are not edited at all) and covers the hub-hosted case that ??= would skip. Pinning surfacedInShell is what makes the M1.4 control a control: without it the hub-up default arm can be silently launch-free for an unrelated reason, and the mutation in D-012 would not red.

### D-015 - The URL selection is a third pure seam, and M1.3 becomes test-first

Extract selectOpenUrl({surface, hubShell, identity}) -> string as a pure function in src/cli/surface.ts: embedded ignores hubShell entirely and returns soloViewerUrl(identity); default returns hubShell ?? viewerUrl(identity). M1.3 is retyped test-first over that seam; the remaining wiring in run.ts is two lines (call it, and guard openBrowser), verified by M1.4's e2e.

**Why:** The discard is the behaviour with a silent wrong answer: written as ??= it keeps the shell URL under embedded and the plan fails exactly where it was aimed, with a plausible-looking URL. A pure seam makes 'hub shell present AND embedded -> solo URL wins' a unit assertion with a named mutation (swap to ??=) instead of resting on an e2e that has to bring a hub up to reach the case. It also restores the rationale: after extraction the wiring genuinely is composition of unit-tested seams.

### D-016 - The CLI help must list --timeout before a doc tells anyone to use it

M2.1 adds --timeout <seconds> to both wait usage strings (run.ts:218 doc comment, run.ts:680 help text), noting 0 = drain. The doc-drift test asserts the flag appears in the HELP text as well as in the parser, so the help cannot rot away from docs/EMBEDDED.md.

**Why:** A documented default that the tool's own help omits sends the reader to the source to check it is real. The parser already accepts it, so this is a one-line honesty fix in the surface humans read, and pinning it in doc-drift is what stops the two from diverging again.

### D-017 - The concept is a VIEW, not a surface

The window a review is presented in is a VIEW - solo or shell - exported as LUCID_VIEW=solo and reported as a 'view' field in open's payload. Surface keeps its existing meaning: the addressable rendering, artifact plus overlay, which is CONTEXT.md's core concept.

**Why:** The maintainer chose this when implementation surfaced the collision: M2.2 would have defined Surface a second time in the project's normative glossary, against a term the whole product is built on. Renaming the new concept was cheap - Phase 1 was still an open PR, so nothing had shipped - and it keeps one word to one meaning. Values are solo/shell rather than embedded/default because they name what you GET rather than where you are.

### D-018 - The hub answers the review page locally under a mount

The hub answers /s/<id>/__lucid/viewer itself when a dedicated server owns the session, instead of proxying it - the same exception already made for the artifact document and the overlay bundle.

**Why:** Proxied, the inner server renders the review page for an empty base, so every URL on it addresses the hub root: the page loads, /__lucid/state 404s, and the review UI sits inert with no error anywhere. The route predates plan 06 and mattered little while the URL was only reachable by typing it; the solo view hands it to a chat app's pane, which holds it across reloads and through a session legitimately moving hosts. Pinned with a stub inner server, because what is under test is the daemon's routing decision rather than the inner server's output.

## 07-observability-and-honest-failure

### D-001 - Correlation ids, not OpenTelemetry

Correlation ids threaded end to end, and NO OpenTelemetry. A request id is minted at the edge (CLI invocation or browser fetch), carried through the hub, the session host and the spawned agent, and stamped into every structured log line and into the log events those turns write. Technique 6 (boundary tracing) is recorded as deliberately not implemented.

**Why:** Lucid is a single-user local tool with almost no dependencies; OTel would add an SDK and a collector story to answer a question that grep over one log file answers here. What was actually missing this session was not the shape of time across services - it was any record at all that a request had arrived. Correlation ids buy the join, which is the part that was absent. Recorded as a deliberate omission rather than an oversight so a later reader knows the doctrine was considered and priced.

### D-002 - The hub logs to a rotating file by default

The hub logs to a rotating file by default (~/.lucid/hub.log, size-capped, one previous generation kept), in addition to stdout when attached. An explicit shell redirect still wins.

**Why:** The hub is a background daemon and is normally started detached, which discarded every line it wrote - the failure this plan exists to fix cost an hour of guessing precisely because I had backgrounded it to /dev/null. A daemon whose evidence disappears when it is detached has no evidence. Opt-in via a flag was rejected: the situation we were just in is exactly the one where somebody forgot the flag.

### D-003 - The solo-view integration gap is in scope

The Codex/chat-desktop integration exporting LUCID_VIEW=solo is in scope for this plan.

**Why:** Plan 06 shipped the solo view and nothing turns it on, so the capability is unused: the pane still renders the shell. It is a one-line export plus the doc and skill guidance that teaches it, and it is the last mile of work already paid for. Folding it in is what makes plan 06 real rather than latent.

### D-004 - A builder at the one request funnel, not log calls per step

The wide event is built by a BUILDER threaded through the request, not by log calls at each step: startRequest().attach().fail().end(), emitting exactly once. src/server/observe.ts owns the record shape and the sink, and owns neither routing nor any decision about what a route does.

**Why:** The doctrine's rule is attach, do not log: a mid-request log line is something to grep across processes, while an attached attribute stays on the row that will actually be queried. Without a builder, attaching means threading a mutable object through every handler by hand, which is how routes end up forgetting. Wiring it at daemon.handle - the one funnel every route passes through - means no route CAN forget.

### D-005 - Records carry identifiers and outcomes, never review content

A record carries identifiers and outcomes only. Never a prompt, an annotation note, a reply, or artifact HTML. M1.1 asserts this by scanning the serialised record for the fixture's own sentinel strings.

**Why:** This is the only decision in the plan that cannot be corrected after the fact: once a log file on somebody's disk holds the text of a review, it cannot be un-leaked, and Lucid's whole subject matter is documents people have not published. Enforced by a test rather than a convention because a convention is what fails on the day somebody spreads a request body into an attach call.

### D-006 - No sampling

No sampling of any kind. Every request is recorded and kept until rotation.

**Why:** The doctrine's tail-sampling table answers a volume problem a single-user local tool does not have. Keeping everything is simultaneously simpler to build and strictly more useful here, so sampling would be cost with no benefit. Recorded so a later reader knows the table was read and judged inapplicable rather than missed.

### D-007 - SPIKE skipped - the numbers were measured in REVIEW

SPIKE skipped. Every factual claim in the RFC was verified against source during REVIEW: the log-call counts per server file (8 attend, 3 daemon, 0 session-host), the five tagged errors, AUTHOR_TIMEOUT_MS=120000, 9 chrome fetches against 2 deadlines, and the create-failed tail plus usage-limit detector.

**Why:** A spike de-risks an unknown. There is no unknown here: the seams are a record type, a file sink, a header and an env var, all of which are ordinary, and the measurements the plan rests on were taken rather than assumed. Spiking would re-measure what REVIEW already measured.

### D-008 - Technique 5 (internal invariants) is out of scope, deliberately

Technique 5 (internal invariants) is deliberately OUT of scope for this plan, recorded as a non-goal rather than left as an unowned audit row.

**Why:** Every failure this plan exists to fix was a missing RECORD, not a broken self-consistency check: a request with no log line, a UI inferring state it was never told, a detached daemon discarding its own evidence. Invariants answer a different question ('did my own logic break'), and no incident this session raised it. 'Strengthen invariants across core' is also unbounded work with no failing case to anchor it, which is how a plan grows a milestone nobody can call done. It stays a non-goal until a real incident names a specific invariant worth asserting - at which point it is a small, targeted addition with evidence behind it.

### D-009 - observe.ts's sink is the default for daemon's existing opts.log, not a second path

observe.ts's sink becomes the DEFAULT for daemon's existing opts.log seam, and every current emitter routes through it. No second logging path is created.

**Why:** daemon.ts:221 already resolves a sink (opts.log, defaulting to a bare process.stdout.write) and injects it into the attendant at :420, which is where attend.ts's 10 messages go. Treating observe.ts as greenfield would leave those 10 plus daemon.ts:604's console.error on unrotated stdout - discarded exactly when the hub is detached, which is the RFC's own motivating failure. Reusing the existing seam also keeps the tests' injected sink working (test/attend.test.ts passes its own log at three call sites), so the change is additive at the boundary rather than a rewrite of every caller.

### D-010 - The pre-implementation measurement baseline, re-measured and corrected

The pre-implementation measurement baseline, re-measured at CONVERGE and corrected in the RFC: 12 log calls across the servers (10 in attend via the injected sink, 1 at daemon.ts:604, 1 at server.ts:106, 0 in session-host); 0 requests logged; 0 debugInfo; 5 tagged errors; 10 chrome fetches of which 3 carry a deadline (transport.ts:70 covering two, CreateDialog.tsx:305 one); AUTHOR_TIMEOUT_MS at CreateDialog.tsx:39.

**Why:** The RFC's original counts were taken before CREATE_TIMEOUT_MS landed in CreateDialog.tsx:32 during the same session, and its attend count (8) missed two call sites while its 'create' count (3) over-counted. Numbers are the evidence this plan rests on, so a stale one invites the next reader to re-derive the whole audit. Fixing them in place and pinning the baseline here means the completion claim ('every request logs') has something exact to be measured against.

### D-011 - Two ids on the record: 'id' pairs entry/exit, 'trace' joins the hops

The record carries TWO ids: 'id' is minted fresh per record and never adopted - it is what pairs an entry with its exit; 'trace' is the carried value (x-lucid-request header, LUCID_REQUEST_ID env) that joins the click to every hop it caused, defaulting to the record's own id at the edge where a trace is born.

**Why:** M1.3's boundary review showed adoption breaks the hang signal on the DESIGNED happy path: a create click's id X flows into the spawned turn, whose two hubOpen calls then emit 2 entries + 2 exits all sharing id, method and path - which one hung is undecidable, and that is the exact question the entry/exit pair exists to answer (the motivating hour). One field cannot be both a unique key and a shared join key. grep <trace> still shows every hop; grep <id> pairs one record.


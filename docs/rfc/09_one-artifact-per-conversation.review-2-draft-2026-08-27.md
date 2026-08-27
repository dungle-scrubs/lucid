# Second review of RFC-09, draft of 2026-08-27

Reviewer: `glm-5.3@pi` at `xhigh` effort, routed with
`excludeFamilies: ["claude", "openai", "meta"]` so it shares no family with
the author or the first reviewer.

Deliberately narrow. The first review's ten findings were all applied, and
this pass reads only the text written in response to them, which nobody had
read. The brief named R5's new write policy as the thing to argue against
first, because it is normative text invented to fill a hole and it governs a
state no record is in.

The registry gave the same warning as before: no candidate meets the
high-stakes bar for `code-review` once Claude is excluded, so this reviewer
was also below the bar it was asked to clear.

It could not execute anything. No `bun test`, no validator, no live client.
It read source and traced paths, and says so in Not reviewed. It did verify
by reading that no two-artifact record exists, which the first reviewer could
not check.

---

```
+-------------------------------+
| RE-WRITTEN WITHOUT THE CRAP   |
+-------------------------------+
```

# Second-pass review of RFC-09 (text added after findings F-01 to F-10)

## R5's write policy - the argument requested first

**Section: R5, lines 234-259.**

The rule is correct, but the RFC does not give the reason that supports it, and the rule has a cost the RFC does not state.

Read-only is not the simpler rule. R2's guard must be built anyway. Its natural shape is one predicate: the set of ids the record holds is not empty, and the emitted id is not in it. For a one-artifact record, that predicate is R2. For a two-artifact record, the same predicate with no change gives R5's rule: a held id passes, an unknown id refuses. Read-only needs a second branch: "more than one held id, refuse even the held ids". It also needs a different refusal, because E-ART-09's recovery ("the agent reuses it", line 307) contradicts itself when reuse is also refused.

What R5's rule buys over read-only:

- No machinery beyond the guard R2 already requires.
- No new error concept.
- An old record stays a working conversation. Read-only makes it a record that nothing can write to, forever. No other state in lucid has that shape, and only records that can no longer be created would be in it.

Two defects in the new text, graded below as findings: the stated reason does not support the rule, and the rule re-creates, for old records, the condition the Problem statement itself calls a correctness floor.

**What is wrong (N-01):** line 258 justifies the write policy with "refusing gains nothing and adds a way to make a record unopenable." A refusal on the write path cannot make a record unopenable. Openability is the fold's property. R5's first two bullets (lines 236-238) already secure it, whatever the emission path does. The sentence attaches the fold's justification to the write rule. The actual trade-off goes unmentioned: under this policy the agent may revise both artifacts of an old record (any held id is accepted) while the page displays one, unspecified which (line 250). That is "a page must not hide something the agent can still change" (line 41).

**Why it matters:** the paragraph is the only reasoning behind a rule for a state that no record on this machine is in. Its one argument is false as written. The one cost the rule does have is not stated.

**Grade: 4.** The fold's independence from the emission path is demonstrable from `src/modes/host.ts` and `src/store/log.ts`. The page and agent disagreement is the RFC's own two sentences (lines 250 and 41) in conflict.

**`replaces` interaction, traced:** asked explicitly, and it holds. In `handleArtifactMessage` (src/modes/host.ts, "Determine current version for this id" block), the version lookup keeps only index keys whose id equals `header.id`. The stale check compares `header.replaces` against that id's own current. The patch base is read as `readArtifact(header.id, current)`. In a record holding alpha@1 and beta@1, `{id: alpha, replaces: 1}` is compared against alpha's current, never beta's. "Accepted as a revision of that artifact, on RFC-06's terms" is what the code already does per id. R5 adds only the membership check in front. The agent's state block already lists both artifacts' current versions (`artifactState` loops all ids, host.ts:88-127). So the refusal "naming every id" gives the agent nothing it cannot already read. Cleared. Grade: 4.

## Findings

### N-01 - R5's justification does not support the rule, and its cost is not stated
**Section: R5, lines 256-259.**
Covered above. Replace the "unopenable" sentence with the argument that does hold: the write rule shares its predicate with R2, and read-only needs a second branch whose recovery text contradicts itself. State plainly that an old two-artifact record keeps a page and agent disagreement that the Problem statement calls a floor. Accept it because no such record can arise.
**Grade: 4.**

### N-02 - Alternatives Considered still asserts the claim R4 retracts
**Section: Alternatives Considered, lines 441-444, against R4 lines 220-228.**
R4 (the F-06 fix) now says the review was right: retire "does not end anything... What retire actually says is 'this artifact is obsolete and the conversation continues', which is a different state from a finished conversation." One section later, Alternatives rejects "Keep retire as 'do not revise this'" on the ground that "with one artifact per conversation it means 'this conversation is finished', which is a session-level finished state." That is the retracted equivalence, word for word. The F-06 fix updated R4 and left the same claim in Alternatives. The RFC now argues both positions on the same question. The weaker R4 argument itself is sound: no named use, a concrete carrying cost, a cheap revival path (the `artifact-meta` source stays). So fix the Alternatives entry onto those grounds. Do not revert R4.
**Grade: 4** (both quotations are in the same document).

### N-03 - "the fold already ignores a `retired` field it no longer reads" is false of the current code
**Section: R4, line 231; repeated as "The fold keeps ignoring" in Implementation Notes step 2.**
The fold parses `retired` (src/store/log.ts:472, `retired.set(id, e.retired)`). It exposes it (`artifactRetired()`, log.ts:1466). The catalog carries it (src/store/conversation-host.ts:495). Production wires it to the host (src/cli/runtime.ts:253). The agent's state block marks the artifact RETIRED with a do-not-revise instruction (src/modes/host.ts:102-118 plus `composeArtifactState`). It is read, and it has behavior. The claim becomes true only after Implementation Notes step 2 removes those consumers. "Already" is wrong. The comment at log.ts:110 ("nothing in this build reads it yet") contradicts host.ts:102 and says the same false thing. Fix that comment too.
**Grade: 4.**

### N-04 - The precedence rule, as written, cannot be implemented and contradicts its own machine
**Section: Error Handling, lines 318-327.**
"The identity check MUST run first, and `E-ART-09` MUST be reported in preference to any other refusal for the same emission." Two failures.

(a) A malformed block has no id to check. The RFC's own machine (line 284) puts `ARRIVED -> REFUSED` (malformed) before `PARSED`, where the identity edge lives. So at least one refusal must precede it: malformed. The prose as written overrides the machine and cannot be implemented.

(b) `E-PATCH-07` (unknown form) is classified malformed by `parseHeader` (src/protocol/artifacts.ts: the form check returns `{malformed}`) and fires before any identity check could, even though the id is parsed by then. Under the machine, E-PATCH-07 beats E-ART-09. That is against "any other refusal".

The rule needs scoping to "a block whose header parsed". E-PATCH-07 must be either exempted like malformed, or moved after the identity check. The machine as drawn contradicts the second option.

Side point: "cheapest check" (line 323) is false. Identity reads the durable artifact index. Malformed and size are local string checks. The moot-making argument that follows it is correct and suffices alone.
**Grade: 3** (machine, prose, and `parseHeader` order in hand; no implementation exists yet to run).

### N-05 - The state machine's FIRST path lost RFC-08's form guard and its oversize edge
**Section: State Machine, lines 279-296.**
`PARSED -> FIRST` (line 286) has no form condition. FIRST's only outgoing edge is `APPENDED` on size (line 290). Read literally, a first-emission patch (form=patch, no artifact exists) walks `PARSED -> FIRST -> APPENDED`. RFC-08's machine refuses it at `PARSED` ("form=patch with replaces null or unreadable"), and `handleArtifactMessage` refuses it E-PATCH-01 (`isPatch && current === 0`). An oversize first emission has no `FIRST -> REFUSED` edge, though Error Handling keeps the size refusal. That is the unapplied half of F-04; the fix table entry covers only precedence. The omission note "(RFC-08's APPLYING/RESOLVED path, unchanged)" sits on REVISION only. FIRST is a new state, so the "changes nothing else" inheritance claim does not reach it. Guard FIRST with form=whole and give it the REFUSED edge.
**Grade: 3.**

### N-06 - The restored first-emission rule is not scoped by form
**Section: R1, lines 135-141.**
Both citations verify. RFC-06 line 463: "`replaces` names an unknown artifact id - Treat as a first emission at version 1". The test: `test/protocol/artifacts-emission.test.ts`, "unknown identity starts new artifact rather than failing", asserts `brand-new` with `replaces: 5` lands v1 with the sent bytes. No contradiction with R2 (it fires only when the record holds an artifact) or with the machine's FIRST edge.

But the rule as stated - "a first emission MAY carry a non-null `replaces`, and it is still the first version" - holds only for the whole form. A first-emission patch with `replaces: 5` is refused E-PATCH-01 (host.ts, `isPatch && current === 0`; RFC-08: "a patch is a revision, never a creation"). The paragraph should say "a first emission of the whole form". Otherwise it quietly re-permits what RFC-08 forbids.
**Grade: 3.**

### N-07 - The duties paragraph claims completeness and misses the title map
**Section: R3, lines 184-196.**
The paragraph lists the fold key, revision and patch-anchor selection, annotation binding, URL and endpoint addressing, and frame correlation. Those are F-08's five, all correct. It omits a sixth duty: person-written titles bind to artifacts by id. The fold keys `artifactTitles` by artifactId (log.ts:594, 1041-1043). The meta endpoint writes that key (RFC-07 R11). The page looks the title up by the id on screen (app.tsx:1859). The RFC keeps the mechanism elsewhere (R3 table, Implementation Notes step 2). But this is the paragraph whose declared job is "it keeps every internal duty... Nothing may drop a check on `artifactId`". The duty it omits is the one whose quiet loss would detach every title a person wrote.
**Grade: 3** (small, but the completeness claim is what makes it a finding).

### N-08 - The new E-ART-01 recovery has no implementation step
**Section: Implementation Notes, steps 1-4, against Error Handling lines 340-343.**
The recovery itself is sound and reachable. The catalog fetch and `openArtifact` exist independent of the list UI. `formatRoute` builds `/c/:conversationId` (route.ts:60-64). The holds-none case falls to the existing "Nothing to mark up yet" pane. One offered artifact is not a list, so there is no tension with R2's withdrawal.

But today the unknown-artifact page's way out is `AlsoHere` plus the "Show what it does have" button (app.tsx:1830-1844). Step 3 deletes `AlsoHere`. No step adds the replacement offer, in a list of steps that claims each leaves the suite green. Add the recovery to step 3.
**Grade: 2** (ordering gap read from the document; the recovery has not been exercised).

## Cleared

- **R5's `replaces` resolution in a two-artifact record.** Per-id scoping in host.ts (lookup, stale check, patch base) makes "revision of that artifact" resolve against the right artifact by construction. The state block already lists both. Grade: 4.
- **"No such record exists" (line 251).** Verified directly. `~/.lucid2/records` holds four records: `demo` (`onboarding-checklist`, 20 versions), `live1` (`live-walk-checklist`, 5), `oq2` (`onboarding`, 18), `restart2` (`onboarding`, 8). One artifactId per record. No two-artifact record exists. The first review could not check this. Grade: 4.
- **The restored first-emission rule's citations** (RFC-06:463, the named test). Both check out. Grade: 4.
- **E-ART-04 restored.** RFC-07:693 defines `queue-full`. `NOTE_QUEUE_MAX = 20` with `queueAdmits` refusing (annotations.ts:72-83). Nothing else in RFC-09 assumes it gone. Grade: 4.
- **E-ART-01 recovery vs the list withdrawal.** One offered artifact, not a list. Reachable per N-08. Grade: 3.
- **Unmentioned RFC-07 errors (E-ART-03, 05, 06, 08).** None touched by withdrawing R2/R3/R12: they govern saves, restore, fold-tolerated meta, and version reads. Version comparison within one artifact survives by the RFC's own scope. Silence is benign. Grade: 3.
- **E-ART-02 withdrawal.** Coherent: retire becomes unwritable, the fold tolerates a legacy `retired` entry, and the page no longer honors it. Grade: 3.
- **The weaker retire argument's logic.** Sound apart from N-02's contradiction: no named use, concrete carrying cost, cheap revival. Grade: 3.
- **E-ART-09's singular "the artifactId the record holds" vs R5's "every id".** R5's bullet is the specific rule for the multi-id case, and the recovery ("reuse it") still works there. Wording only. Grade: 3.

## Not reviewed

- **`bun test`.** Not run. This session has no shell tool (read/grep/find/ls only), and the tool-proxy sandbox cannot run this repo's suite against its local fixtures and fake hcn. The one test the new text depends on was verified by reading it. The first review's `mkdtemp` EPERM was its harness; mine is the absence of any exec surface.
- **The RFC structural validator.** Same reason: no process execution available here.
- **Live client behavior** of the unknown-artifact page, `AlsoHere` removal, and the retire controls. Read statically only.
- **The historical "fifteen records" sample (line 49).** Only four records remain, so the fifteen-record population cannot be recounted. That number rests on the author's record. The claim the rule depends on - no two-artifact record exists now - I did verify.

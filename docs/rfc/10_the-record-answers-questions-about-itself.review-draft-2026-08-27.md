# Review of RFC-10, draft of 2026-08-27

Reviewer: `gpt-5.6-sol@codex`, routed with `excludeFamilies: ["claude"]`.
The registry's first pick, `muse-spark-1.2-contributor@muse`, was skipped
without trying it: its file tools had failed on a type mismatch an hour
earlier, on RFC-09.

**This review withdrew the RFC.** Three findings removed its premise rather
than damaging it, and F-04 was reproduced against a real record before the
decision was taken.

- **F-04 (grade 4).** "Why a version exists" was to be derived from
  ordering. It cannot be. An artifact entry carries no `turnId`, no input
  id and no `seq`; the agent's reply is written *after* the version; a turn
  can produce no version; one message can produce two, which a test in this
  repository already fixes; and a save is not an input at all.
- **F-03 (grade 3).** The other three answers already exist. The loopback
  server returns conversation lines with notes and replies, version
  catalogs, and complete version bytes, and a CLI caller can get a token
  from `/api/session`. Without the causal join the RFC was a wrapper over
  shipped projections.
- **F-06 (grade 3).** The motivating case does not motivate. Before the bad
  edit the agent already held the note, the exact snippet, the artifact id
  and the version. The query returns the same facts, so the ALPHA BRA
  failure was not caused by missing data.

The eight other findings are real and are recorded here rather than
applied, because the document they applied to is withdrawn. Two of them are
worth carrying to whatever replaces it: **F-07**, that "behaves identically"
has no valid test because a query is a tool action and tool events enter the
record, and the enforceable rule is that the command appends nothing, takes
no lock, moves no cursor and starts no follow-up work; and **F-05**, that a
projection cannot be a pure function of a folded record, because the fold
holds offsets rather than bytes and the catalog carries neither a timestamp
nor `basedOn`.

**F-10 is recorded as answered rather than applied.** It read the skill's
guidance as a nudge. The driving dev's position is that the *application*
must never influence the agent, while a skill carries recommendations and
recipes and is a different thing. The invariant that survives, and that
holds even after the skill ships with lucid, is: with no skill loaded,
lucid's only surface is a help command listing what exists.

---

```text
+-----------------------------+
| RE-WRITTEN WITHOUT THE CRAP |
+-----------------------------+
```

# RFC-10 review - Draft dated 2026-08-27

Reviewed `docs/rfc/10_the-record-answers-questions-about-itself.rfc.md`. The document has no explicit draft version identifier.

## Findings

### F-01 - R1 omits an existing agent-to-lucid path

Section: `R1 - It is a command, not a frame`

Problem: An agent cannot invent a frame kind. That part is correct. R1 then says a command is the only path the agent can reach. That is false.

An agent already sends requests to lucid inside `message` events. It emits a `lucid-artifact` fence. Lucid parses that text and writes versions. `HarnessEvent` exposes the agent-controlled text. The host inspects the text before it records the event (`src/harness/events.ts:46-55`, `src/modes/host.ts:945-959`, `src/protocol/artifacts.ts:33-45`). A query fence or another message protocol is an omitted alternative.

R1 also calls the frame speaker a `driver`. The canonical term is `source`. It says the driver holds the log. `CONTEXT.md` says the source speaks frames and the host owns the log (`CONTEXT.md:48-55`).

Impact: The command can still be the preferred design. R1 does not prove that the command is required by the architecture. Its argument uses an incomplete channel model.

Evidence: **Level 3 - traced** from harness message decoding through host-side inspection and storage.

### F-02 - R2 conflates the record directory with the log

Section: `R2 - lucid owns the projection`; `Security Considerations`

Problem: The secret is a bearer credential. It is not in `log.ndjson`.

Record creation writes the secret to a separate file (`src/store/store.ts:31-50`). Before the host persists an attach frame, it replaces the secret with `"redacted"` (`src/store/conversation-host.ts:339-347`). During a fold, lucid restores the secret from the sibling file in memory (`src/store/log.ts:473-486`). The reducer compares it during attach authentication (`src/protocol/reducer.ts:501-510`).

Therefore:

- Returning the raw log does not return the secret.
- Naming the record directory reveals where the secret file is.
- The RFC already states that the same local agent can read that directory.
- Possession of the secret permits source impersonation. The consequence is not limited to knowledge of a path.

Impact: A stable projection is sound interface design. The credential argument does not prove that requirement. The security text overstates the risk of raw-log output. It understates what the actual secret permits.

Evidence: **Level 3 - traced** through creation, durable redaction, fold reconstruction, and attach authentication.

### F-03 - A supported read path already exists

Section: `Abstract`; `Problem statement`; `Alternatives Considered - Leave it`

Problem: The claims that nothing can read the record back and that none of the data is reachable are false.

The loopback server already returns:

- Conversation lines with annotation batches and replies (`src/server/server.ts:175-238`).
- Version catalogs and notes (`src/server/server.ts:288-317`).
- Complete version bytes and metadata (`src/server/server.ts:327-357`).

A command-line caller can get the server token from `/api/session` when it sends no `Origin` header. It can then call the read APIs (`src/server/server.ts:108-169`).

Three of the proposed four query classes already exist as supported projections. The missing part is the causal join. Finding F-04 shows that the proposed join is not valid.

Impact: The RFC does not compare the new command with a wrapper over the existing server projection. A second derivation can drift from the server.

Evidence: **Level 3 - traced** through server authentication and each read endpoint.

### F-04 - The note-to-version join does not represent causality

Section: `Message Formats - Why a version exists`; `Implementation Notes`

Problem: The proposed join is "notes delivered after the previous version and before this one." It fails each requested edge case.

- An artifact entry has no `turnId`, input id, or sequence (`src/store/log.ts:70-89`).
- The host writes the artifact while it processes the agent message. It records the message event afterward (`src/modes/host.ts:393-400`, `src/modes/host.ts:945-959`). The reply is not inside the proposed interval.
- A turn can emit no artifact. `handleArtifactMessage` returns when no fence exists. The message and terminal event still enter the record. Notes from that turn remain before a later version.
- One message can create 2 successive versions. The repository has a test where one reply creates versions 2 and 3 (`test/protocol/artifacts-emission.test.ts:643-656`). The interval before version 3 contains neither the notes nor the reply that caused both versions.
- A save is not an input. It starts no turn (`src/server/server.ts:360-418`). It has no agent reply.

The `demo` record shows the ambiguity:

- Agent artifacts precede their message events at `~/.lucid2/records/demo/log.ndjson:15-16`, `:37-38`, and `:180-181`.
- Two annotation inputs occur before one later agent version at `:63-78`.
- Two human versions occur consecutively with no turn at `:86-87`.

Impact: "Why a version exists" is the main new answer. The record cannot derive it reliably from ordering. The projection can attach the wrong notes or reply. It would present an inference as a stored fact.

Evidence: **Level 4 - demonstrated** against the current host path, the existing 2-version test case, and a real record.

### F-05 - A folded record cannot produce all declared answers

Section: `Message Formats`; `Implementation Notes - The projection`

Problem: Implementation step 1 specifies a pure function from a folded record. The fold contains artifact offsets. It does not contain artifact bytes or all version metadata (`src/store/log.ts:560-576`).

Reading a version requires the raw buffer and the offset index (`src/store/log.ts:814-862`, `src/store/conversation-host.ts:497-505`).

The RFC also says the catalog already computes version number, author, time, and `basedOn`. It does not. `ArtifactCatalogEntry` has versions, authors, and `afterSeq`. It has no timestamp or `basedOn` (`src/store/conversation-host.ts:423-442`). Those values require a seek to each version.

Impact: The implementation boundary and test input are incomplete. The command needs a snapshot that contains the raw bytes and fold result. Another option is a reader that performs seeks. A folded-record-only function cannot answer what a version says.

Evidence: **Level 3 - traced** from fold output through the catalog and version readers.

### F-06 - The ALPHA BRA case gets no new evidence

Section: `Problem statement`; `Message Formats - Why a version exists`

Problem: Before the bad edit, the agent already received the note, exact selected snippet, artifact id, and version. The annotation input carries all of that (`src/protocol/annotations.ts:29-44`, `src/protocol/annotations.ts:122-126`, `src/protocol/annotations.ts:198-205`).

The proposed query returns the same note and snippet. It also returns the reply that the same agent wrote and the resulting version.

The RFC defines no semantic comparison. It does not require a query. It does not specify a verification question or refusal. R4 permits the agent to inspect nothing.

The agent that interpreted `ALPHA BRA` as 2 complete words can repeat that interpretation when it sees the same text again.

Impact: The motivating failure shows that data availability was not enough. The command makes later inspection easier. It does not establish that the ALPHA BRA failure would have been found.

Evidence: **Level 3 - traced** from annotation prompt composition to the proposed output. The query adds no fact that identifies the mistake.

### F-07 - R4's identical-behavior rule cannot hold

Section: `R4 - lucid has no opinion about when to query`

Problem: An agent query is a tool action. Tool events are part of `HarnessEvent` (`src/harness/events.ts:52-58`). The host records every harness event (`src/modes/host.ts:945-960`).

The command output is intended to inform the agent. It can change the next reply or artifact.

A conversation with a query on every turn cannot behave exactly like a conversation with no queries. The tool activity changes the record. The command output can change later agent output.

The enforceable rule is narrower. The command itself can avoid appends, locks, cursor changes, and lucid-driven follow-up work.

Impact: The current requirement has no valid test. A byte comparison fails because the tool events differ. A semantic comparison is undefined and conflicts with the purpose of the command.

Evidence: **Level 3 - traced** through tool-event recording. The command does not exist, so its exact event shape was not demonstrated.

### F-08 - The state machine and error table do not match

Section: `State Machine`; `Error Handling`

Problem: The section says a query has no states. It then defines 3 states.

The REFUSED edge names no conversation and "a query naming nothing." `E-READ-03 record-unreadable` is another refusing condition, but the edge omits it. "A query naming nothing" has no clear error code. `E-READ-02` means a nonexistent version. It does not clearly mean an absent or unsupported query.

A lock-free read also has an uncovered case. `foldLog` treats a trailing fragment without a newline as an older good snapshot (`src/store/log.ts:553-595`). During an append, a new version can temporarily appear absent. The record is not damaged in that case.

The RFC does not state whether this result is `ANSWERED`, `E-READ-02`, or a retryable snapshot result.

Impact: Implementations can assign different exit codes to the same condition. A query can also report no such version during a normal concurrent append.

Evidence: **Level 3 - traced** between the state text, error text, and lock-free fold behavior.

### F-09 - R5 points to an incomplete preamble

Section: `R5 - The preamble says nothing about it`

Problem: R5 says the preamble defines the wire format. It says a skill must point to that preamble instead of repeating the format. The current preamble does not meet that requirement.

The preamble says an unknown id starts a new artifact. It also says 2 blocks in one message both land (`src/protocol/artifacts.ts:41-45`).

The host refuses an unknown second artifact because a conversation holds one artifact (`src/modes/host.ts:256-276`). Two blocks with different ids do not both land. The preamble also omits enforced field and size limits.

Impact: A skill that follows R5 will point to instructions that conflict with the binary. The declared single source of protocol truth already contains incorrect and incomplete rules.

Evidence: **Level 3 - traced** from the shipped preamble to the host refusal path.

### F-10 - The skill is a nudge

Section: `Abstract`; `Scope`; `R5 - The preamble says nothing about it`

Problem: The Abstract says the skill teaches that the command exists. It also says lucid has no opinion about when the agent should query.

R5 assigns the skill guidance about when to query. Implementation step 3 makes that skill part of the delivery.

Guidance about when to query instructs the agent to consider a query. Moving the guidance outside the binary does not remove the instruction.

Impact: The delivered capability exceeds the no-nudge scope in the Motivation and Scope sections. The RFC must limit the skill to discovery and syntax. Otherwise, it must state that the skill includes query policy.

Evidence: **Level 2 - pointed at conflicting sections**.

### F-11 - The RFC introduces duplicate names

Section: `Terminology`; `R1`; `Message Formats`

Problem: `CONTEXT.md` requires one canonical name for each thing (`CONTEXT.md:29-31`).

The RFC introduces "the account" for data already held by the record and transcript. It uses `driver` where the frame speaker is a `source`. It asks for the "agent's reply for that turn" without defining the record object.

That reply can mean:

- The `message` event.
- All events in the turn.
- The rendered transcript line.

`CONTEXT.md` already defines a `turn` as one agent answer (`CONTEXT.md:50-58`).

Impact: The projection cannot implement "agent's reply" consistently until the RFC names the exact record object. The source and host naming error also affects the R1 channel argument.

Evidence: **Level 2 - pointed at the RFC and canonical vocabulary**.

## Cleared

### Structural validation

```json
{
  "passed": true,
  "errors": [],
  "warnings": []
}
```

Evidence: **Level 4 - demonstrated** with the repository RFC structure validator.

### The narrow frame claim

`FRAME_KINDS` is closed. Source-to-host event frames carry a nested harness event. Hcn output decodes as `HarnessEvent`, not as an arbitrary lucid frame (`src/protocol/frames.ts:18-34`, `src/protocol/frames.ts:118-175`, `src/harness/events.ts:101-116`).

The defect is R1's claim that no other agent-to-lucid encoding exists.

Evidence: **Level 3 - traced**.

### R3's 2 full-document byte cases

The current prompt includes full artifact bytes only in these cases:

1. A person saved the current version.
2. `E-PATCH-02` caused lucid to owe the agent the current version.

The paths are at `src/modes/host.ts:88-120` and `src/modes/host.ts:365-376`. Lucid drains the owed set once per prompt (`src/modes/host.ts:76-84`).

No third full-version byte path was found.

Current-version metadata and annotation inputs also travel. They are not a third full-document resend. RFC-10 does not introduce them.

Evidence: **Level 3 - traced** across all `composeArtifactState` call sites.

### `E-READ-03` can avoid repair

`readFoldRepair` truncates a torn tail. It is private to locked and write paths (`src/store/log.ts:881-895`).

The existing read-only views read the file and call `foldLog` directly. They do not repair the log (`src/store/conversation-host.ts:381-415`, `src/store/conversation-host.ts:445-505`).

`E-READ-03` is implementable without mutation if the command uses that read path.

Evidence: **Level 3 - traced**.

### Basic product fit

The current user is one person who works with coding agents. Lucid routes a durable record back out (`CONTEXT.md:7-27`).

A read-only agent command supports that purpose. It adds a CLI command and an agent-facing capability. The Motivation records the user's explicit request for that added scope.

Evidence: **Level 2 - pointed at the product scope and RFC Motivation**.

## Not reviewed

- The query skill. RFC-10 places it outside this repository. No skill content was supplied.
- Command spelling, structured output, and diff semantics. Open Questions 1 and 2 leave them undecided.
- Runtime behavior of the command. The command is not implemented.
- Full test execution. The targeted tests tried to create temporary directories. The read-only sandbox refused those writes with `EPERM`. No failed test assertion was used as evidence.
- Code-graph coverage. The repository is indexed. The graph process could not create its secure coordination endpoint in this read-only sandbox. Direct source reads and call-site searches support the structural findings instead.
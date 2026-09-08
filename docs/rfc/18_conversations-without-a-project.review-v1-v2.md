Reviewer: opus-5@claude

## Review: RFC-18 v1 + v2 picker addendum

**Reviewed:** `docs/rfc/18_conversations-without-a-project.rfc.md` (version 1, status Draft) and `/tmp/lucid-projectless-picker-addendum.md` (the sole v2 addition). Read-only; no files changed.

**Structural validator** (run by the primary agent, reported verbatim):

```json
{"passed":true,"errors":[],"warnings":[]}
```

---

### Findings

**1. A managed record has no recovery path, and rename breaks it. (§Error Handling, §Design)**
§Error Handling says a removed workspace or moved record "follows existing missing-folder recovery." That mechanism is `replaceLocation` (`src/store/settings.ts:21-48`), which requires an absolute existing folder (`src/server/server.ts:905-906`) and unconditionally merges `...association` (`src/store/settings.ts:44`), writing a `projectDirectory`. No input restores "managed" - the recovery converts the record instead of recovering it. Meanwhile the record is hard-blocked: `src/modes/managed-preparation.ts:196` throws E-HUB-04 unless `status === "available"`, and `src/cli/runtime.ts:378` refuses.
Rename makes this reachable without user error: `docs/architecture.md:35` supports renaming a record directory, discovery keys on `metadata.conversationId` (`src/store/discovery.ts:133`), but the saved absolute `<root>/<id>/workspace` still points at the old path, so `folderSummary` reports `missing` (`src/store/discovery.ts:48-54`) while the workspace sits intact one level under the record being read. §Alternatives Considered never evaluates storing a managed marker and deriving the path from `paths.dir` at read time, which `RecordMetadata` (`src/store/record-identity.ts:5`, open `Record<string, unknown>`) permits.

**2. `null` means two opposite things in the same feature. (addendum ¶2 vs §Design)**
The picker returns `{workingDirectory: absolutePath|null}` where `null` means Cancel and MUST preserve the prior choice. §Design gives `null` on the creation request the meaning "allocate a managed workspace." Same field name, same value, inverted semantics, one hop apart in the client. Forwarding the picker response straight into the creation body turns Cancel into "discard the selected folder and go managed." Give Cancel its own shape (`{cancelled: true}` or a separate field).

**3. The working directory is nested inside the record, and §Security does not assess it.**
The record holds `secret` (mode 0600), `log.ndjson`, `meta.json`, `driver.json` (`src/store/errors.ts:52-62`), and `docs/architecture.md:25` makes local filesystem access the attach authorization boundary. Every explicit-folder conversation keeps record and harness cwd disjoint; this RFC makes the cwd a child of the record, putting the attach secret and durable log at `..` from where the agent writes. §Security only argues that input cannot select the path and that privileges are unchanged; §Alternatives rejects a separate managed tree on atomicity grounds without weighing this.

**4. The prefilled location control silently un-manages a record. (§Design)**
§Design keeps the settings location control for managed records. `src/server/client/location-control.tsx:17` prefills the field with `workingDirectory ?? ""` and the input is `required`, so a save-without-edit runs `associateFolder` on `<record>/workspace`, which walks parents for `.git` (`src/store/project-directory.ts:22-27`) and writes a `projectDirectory` - the workspace path itself, or the enclosing repo root if the records root sits inside a checkout. Either way the record leaves "No project" (`src/server/client/hub.tsx:130`) with no user intent.

**5. Picker concurrency slot vs. process reap. (addendum ¶2)**
"Cancels the native process on request abort or server shutdown," "-128 handled as Cancel," and "concurrent calls fail 409" are each specified, but not their interaction. A killed child also exits nonzero, so kill-by-abort and user-Cancel are not distinguished. If the single-dialog slot frees on abort rather than on child exit, the next call passes the 409 check while the old dialog is still on screen. Specify: release the slot only after the child is reaped, and treat abort-kill as neither Cancel nor selection.

**6. Two MUSTs that cannot both hold. (§Design vs §Error Handling)**
"Discovery MUST ... report their working directory as available" is unconditional; status comes from a live `statSync` (`src/store/discovery.ts:30-35`) and §Error Handling requires the removed case to report missing. Scope the first to immediately after successful creation.

**7. Workspace lifetime after an explicit-folder replacement is unspecified. (§Open Questions, §Design)**
§Open Questions claims allocation and cleanup share the atomic boundary. `replaceLocation` (`src/store/settings.ts:38-47`) repoints metadata and never touches the workspace, orphaning it and any agent output inside the record.

**8. "No project" acquires a second meaning; `docs/architecture.md:62` is not scheduled for correction.**
That line states "Legacy records appear under No project." Managed records join the same group but, unlike legacy ones, have a working directory - `src/server/client/hub.tsx:87` will render the full `<root>/<uuid>/workspace` as each row's subtitle. §Implementation Plan says "documentation" without naming `architecture.md`, which §References lists as normative.

**9. Unnamed error codes on the new endpoint. (addendum ¶2)**
The 409 concurrent case and the non-macOS unsupported case get no E-HUB code, while §Error Handling assigns one to every other failure. Note that 409 is already the record-conflict status (`src/store/creation.ts:10-12`, `src/store/settings.ts:41`), whose client handling prompts a stale-revision reload - a separate code avoids that. Non-macOS also needs the capability exposed *before* the click (`defaults()` at `src/server/hub-settings.ts:171-192` is the existing carrier), or the primary affordance errors on every non-Mac host.

**10. Two small specification gaps.**
(a) §Design says blank-or-whitespace is managed and "nonblank explicit paths MUST remain absolute," but does not say whether the explicit branch trims - `"  /Users/x  "` is rejected today at `src/server/hub-settings.ts:217`. Pick one: the normalized value is part of the retry identity via `JSON.stringify` (`src/store/creation.ts:71`). (b) §Design widens the store option to `null` (`src/store/store.ts:39`) but `CreationRequest.workingDirectory` is `string` (`src/store/creation.ts:22`) and is what reaches the receipt at `src/store/creation.ts:81`; the RFC never states this second type widens.

**11. In-handler native spawn vs. an existing invariant. (addendum ¶2)**
`docs/architecture.md:207` states the server never drives a harness in a request handler. Spawning `osascript` from a handler is a different thing, but it reads against that rule. §Security needs an explicit sentence covering the fixed script, the local-only auth boundary, and the fact that the dialog opens on the server's machine.

---

### Checked and sound

Receipt idempotence and conflict under one root `.creation` lock (`src/store/creation.ts:57-92`), with normalization fixing key order at `src/server/hub-settings.ts:221` so blank retries compare equal and never match an explicit path; defaults not re-read on a receipt hit (early return at `:75` precedes `resolve()` at `:77`); failed prepublication write removes the staging tree including a nested workspace (`src/store/store.ts:105-110`); canonical-vs-staging path is satisfiable as written, since `paths` is computed at `src/store/store.ts:58` before `staging` at `:64`; the fsync list at `src/store/store.ts:84-97` already covers the staging directory; `workspace` collides with no name in `pathsForDir` (`src/store/errors.ts:52-62`); an omitted `projectDirectory` yields "No project" and raises no discovery error (`src/store/discovery.ts:37-38`, `:162-165`); creation starts no agent; dispatch and launch read `workingDirectory`, not `projectDirectory` (`src/store/dispatch-context.ts:64`, `src/cli/runtime.ts:378-385`); allocation and sync failure map to E-HUB-01 via `src/store/creation.ts:85-91` **provided** the workspace mkdir sits inside the `try` at `src/store/store.ts:66`; existing records decode unchanged (`src/store/record-identity.ts:10-27`); all three defined terms are used; the stated premise is accurate - the form already sends `""` (`src/server/client/new-conversation.tsx:99`) and is rejected at `src/server/hub-settings.ts:217`. The picker endpoint holds no store lock, so its 2-minute pending window cannot block creation.

**Not covered:** RFC number uniqueness (completed RFCs live in Git history, not searched); `docs/rfc/README.md` workflow conventions; tests; unrelated working-tree changes.
## Evidence grading

Primary-agent classification: findings 1, 4, 6, 8, and 10 cite directly inspected code or contradictory clauses (rung 3). Findings 2, 3, 5, 7, 9, and 11 identify design ambiguities or risks (rung 2). All are answered in RFC revision 2.

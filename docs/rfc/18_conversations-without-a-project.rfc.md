---
number: 18
title: "Conversations without a project"
type: feature
status: Accepted
version: 2
author: Kevin
date: 2026-09-08
---

# RFC-18: Conversations without a project

## Abstract

The hub currently requires an existing working folder before creating a conversation. People writing standalone artifacts need no project. An omitted folder will allocate a persistent Lucid-managed workspace with the record. Explicit folders retain their existing behavior.

## Introduction

This serves the existing single user reading and annotating agent output. It holds product scope: the same conversation and artifact workflow gains a sensible default. It covers browser creation, allocation, discovery, and execution readiness. It excludes changing terminal defaults, migrating legacy records, automatic filesystem repair, and sandboxing harnesses.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as described in RFC 2119.

A managed workspace is the persistent `workspace` subdirectory of a newly created record. The working directory is the directory in which a harness runs. A project is the existing repository or starting-folder grouping.

## Motivation

A standalone artifact requires a durable record and an execution directory, but no user-selected project. Requiring an absolute path conflates these needs.

## Design

`POST /api/conversations` MUST accept an omitted, null, empty, or whitespace-only workingDirectory as a managed-workspace request. The normalized receipt MUST store workingDirectory as null for all these cases. Nonblank explicit paths MUST remain absolute and MUST pass existing availability and project-association checks. Other types MUST be refused.

The store's creation option MUST distinguish null (allocate managed workspace), undefined (existing legacy behavior), and a string (existing explicit folder association). A managed workspace MUST be created inside the private staging record, mode 0700, and synced before the record's atomic publication. Metadata MUST save its final absolute workingDirectory and omit projectDirectory. The final path MUST use the canonical record root, never the temporary staging path. Existing records MUST remain unchanged.

Discovery MUST list managed conversations under No project. Immediately after successful creation, the working directory MUST be available; later filesystem changes can make it missing. Existing prompt dispatch MUST use the saved working directory. Creation MUST NOT start an agent. Existing receipt locking and retry semantics MUST apply unchanged: equivalent blank requests reuse one record before defaults are resolved; explicit-versus-managed requests sharing a creation ID conflict.

The form MUST use an optional folder picker with the muted empty state No project folder, rather than a path input. It MUST explain that no selection uses a Lucid-managed workspace. Change and Remove MUST be available after selection; cancellation MUST preserve the prior choice. Settings continue to show the actual working folder for inspection and existing explicit-folder replacement.

## State Machine

No receipt -> validate settings -> create private staging record and workspace -> sync -> publish record -> return identity. A matching receipt returns the same identity without allocating or re-reading defaults. A conflicting receipt is refused. A failed prepublication write removes its staging record. A postpublication response loss is recovered through the receipt.

## Error Handling

Invalid explicit paths and field types retain E-HUB-04 with folder correction guidance. Allocation, permission, and sync failures retain E-HUB-01 and same-request retry guidance. Receipt conflicts retain E-HUB-02. A physically removed workspace requires explicit folder repair. Renaming a record preserves its workspace through metadata path resolution.

## Security Considerations

Creation retains the existing authenticated local API boundary. The server chooses workspace names; input cannot select a path inside the record through this default. The workspace and staging record are private directories. The workspace is an execution location, not a sandbox; harness privileges do not change. No secrets or authentication material are copied into the workspace. Record metadata and receipt publication remain atomic.

## Alternatives Considered

Using the server's current directory ties user work to an incidental launch location. A shared scratch directory mixes unrelated conversation output. A temporary directory loses files across cleanup or restart. A separate managed directory tree complicates atomic allocation and lifetime without serving this request.

## Implementation Plan

One vertical slice updates creation input normalization, atomic store allocation, the form, documentation, and deterministic tests. Verify idempotency, explicit paths, no-project discovery, actual saved execution location, and no agent launch. Then build and inspect the running form and creation route. Rollback restores required-folder browser creation; existing records remain valid because they use existing metadata fields.

## Open Questions

None blocking. Machine-made choice: keep each workspace within its record so allocation and cleanup share the existing atomic boundary. The user requested creation without a supplied project, handled by Lucid.

## References

### Normative

- [Architecture](../architecture.md) - allocation, receipts, and project grouping.
- [Context](../../CONTEXT.md) - product scope and vocabulary.

### Informative

- User request on 2026-09-08 - optional project and subdued placeholder.

## Revision 2: review responses and picker

This revision answers the Opus 5 review of v1 and the picker addendum. These clauses supersede the corresponding v1 clauses above.

1. Managed metadata MUST carry `managedWorkspace: true`. Metadata decoding with a record directory MUST derive the effective workingDirectory from that directory's canonical `workspace` child. Discovery and execution MUST use that decoding, including after a record-directory rename. A physically removed workspace still requires explicit folder repair; automatic recreation remains out of scope.
2. The picker response MUST be a discriminated result: `{status: "selected", workingDirectory: string}` or `{status: "cancelled"}`. Cancellation MUST leave the form's prior choice unchanged.
3. The workspace remains inside the private record for atomic publication and shared lifetime. This provides no isolation from the parent record. Harnesses already run with the local user's filesystem access; adding a sandbox is outside this change. The fixed native picker script opens only on the server's Mac and does not drive a harness.
4. Saving the same canonical working directory MUST preserve managed status and No project grouping. Explicitly selecting another location MUST clear managed status and follow existing project association. Any old workspace and its files MUST be retained.
5. The single native-dialog slot MUST be held until the child exits. Request abort, server shutdown, and the two-minute timeout terminate the child and return an error, never a selection or user cancellation.
6. Availability is guaranteed immediately after successful creation. Later filesystem checks can report missing.
7. Retained workspace files survive explicit folder replacement and live until the record is removed. There is no automatic cleanup.
8. Architecture documentation MUST describe both legacy and managed No project records. Hub rows MUST NOT display the managed storage path as project context.
9. Authenticated POST `/api/folder-picker` MUST open at most one native macOS folder dialog per server, outside store locks. Picker failures and unsupported hosts use E-HUB-04 with retry guidance; busy requests use E-HUB-04 with status 409. Creation defaults MUST expose native picker availability so unsupported hosts can still create with no folder. The HTTP idle timeout MUST be disabled for the pending picker request only.
10. Explicit nonblank paths MUST NOT be trimmed; only a blank/whitespace-only path normalizes to null. `CreationRequest.workingDirectory` MUST widen to string or null alongside the store option.
11. New conversation MUST use an optional picker instead of a text input. The empty state MUST read No project folder. The selected state MUST show the path with Change and Remove actions. The form MUST prevent creation while selection is pending, and MUST preserve settings across cancellation or native errors. Native arguments MUST be fixed, with no user-controlled script interpolation. Existing saved-folder editing remains unchanged apart from preserving no-op managed saves.

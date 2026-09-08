# Create artifacts without a project folder

Status: resolved
Blocked by: none

## What to build

One vertical slice, selected autonomously from the user's request: create a conversation with an optional native folder picker. The empty state says No project folder. With no chosen folder, Lucid allocates a private persistent workspace and lists the conversation under No project. A chosen existing folder retains project association and normal execution. This slice holds the product's existing scope.

## Acceptance criteria

- [x] Folder selection is optional, cancellable, and removable before creation; no path input is shown.
- [x] Blank creation allocates a persistent private workspace with the record and starts no agent.
- [x] Equivalent creation retries reuse the record and preserve workspace files.
- [x] Explicit invalid folders are rejected; selected folders retain existing grouping.
- [x] The agent operates from the managed workspace and can resume using existing behavior.
- [x] Browser reload, picker cancellation, unavailable dialog, and concurrent picker requests retain a usable form.
- [x] Deterministic checks, build, and browser verification pass.

## Parent

RFC-18, Conversations without a project; user requests on 2026-09-08.

## Answer

Implemented and running locally. All 1346 tests, build, and diff checks passed.
Native selection, cancellation, removal, and project-free creation were verified.
The form was checked at 390, 768, and 1440 pixels. A test artifact rendered in
the project-free record; that record was then moved to ignored evidence.
Cross-family review: opus-5@claude. All eleven findings are answered in RFC v2.

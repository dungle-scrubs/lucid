# Theme implementation test plan

Status: confirmed and verified
Implementation: authorized by Kevin on 2026-09-09 through the implement skill.
Branch: feat/shared-application-and-artifact-themes
Baseline: 6757d52

## Seams

1. The shared theme preference owner's public read, choose, subscribe, and
   disposal operations. Inject browser storage and system/event observation.
   Exercise outcomes through that interface rather than mocking its internals.
2. The inert artifact declaration parser and frame-policy projection. Supply
   stored HTML and the resolved application appearance; inspect the resulting
   policy and embedding scheme without mounting authored content in the parent.
3. The existing instrumented-frame message and snapshot interface. Use real
   sandboxed frames to check propagation, identity, input, and serialization.

## Ordered behavior cases

1. System defaults, manual overrides, and immediate Follow system restoration.
2. Persistence, blocked storage, tab convergence, and restored pages.
3. Version-specific adaptive, fixed, invalid, and unmanaged declarations.
4. Live frame switching with input, reading state, and snapshots preserved.
5. Application controls, first paint, contrast, and responsive states.
6. Generated-artifact reading, annotation, editing, saving, and reopening.

Use one RED/GREEN case at a time for behavior-bearing preference and policy
logic. Use browser checks after frontend rendering changes. Existing tests
remain the regression oracle. Run the active test file and typecheck during
implementation, then the full repository gates at completion as the implement
skill directs. Stop and diagnose intermittent failures before continuing.

## Isolation

The main checkout contains unrelated uncommitted UI work. This branch starts
from committed HEAD in a separate worktree. Only RFC 21 and its local tickets
were copied in. Theme commits must build from this baseline independently;
integration with the main checkout's pending edits is separate from this task.

---
status: accepted
---

# Document edits preserve evidence

Every save, restore, or agent revision appends a complete immutable version.
Patches are an emission optimization, never stored instructions that future
readers must execute. Human saves retain ancestry even when another version
arrives first. lucid does not guess a merge. Unresolved annotation anchors
retain their original evidence instead of pointing at unrelated text.

Revisit storage representation only with equivalent independent readability
and recovery guarantees. Revisit merging only with a defined user operation.

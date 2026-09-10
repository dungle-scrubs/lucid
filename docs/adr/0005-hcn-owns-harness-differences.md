---
status: accepted
---

# hcn owns harness differences

lucid invokes hcn as a subprocess through one harness seam. hcn normalizes and
supervises one process; lucid owns the conversation across processes. Exact
pins and captured fixtures make a dependency change deliberate. Runtime
capability claims retain provenance, and unknown event kinds are carried.

Revisit the boundary only if hcn's public contract cannot express a required
interaction. Do not mirror its descriptors, flags, or model registry locally.

HCN owns executable compatibility. Lucid does not inspect package versions,
compare them with a pin or floor, or recheck HCN's support verdict through
version equality. Package pins remain build inputs. Runtime behavior follows
HCN's explicit operation results and failures.

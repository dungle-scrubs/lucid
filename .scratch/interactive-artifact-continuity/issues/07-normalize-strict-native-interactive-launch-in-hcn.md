# 07: Normalize strict native interactive launch in HCN

Status: open
Blocked by: none

## What to build

A caller can resume a supported native terminal through one HCN operation and receive trustworthy process lifecycle evidence.

## Acceptance criteria

- [ ] Native terminal I/O remains separate from versioned control records carrying the caller launch ID.
- [ ] Strict resume validates exact session and folder without fresh fallback, prompt or model substitution.
- [ ] No-child refusals, started process identity and owned cleanup have distinct evidence; uncertain control loss is never reported as pre-start refusal.
- [ ] Descriptor, interpretation and injected execution boundaries remain intact in Node and Bun; CLI claims and captured fixtures match the updated operation.
- [ ] Every interface has an explicit supported or unavailable result; desktop remains an independent acceptance lane.

## Parent

RFC 26 and planning map https://github.com/dungle-scrubs/lucid/issues/253. Machine-made implementation slice under the approved autonomous continuation.

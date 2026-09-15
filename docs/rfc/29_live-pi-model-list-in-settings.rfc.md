---
number: 29
title: "Live pi model list in settings"
type: feature
status: Accepted
author: Kevin
date: 2026-09-15
version: v3
---

# RFC-29: Live pi model list in settings

## Abstract

The settings Model control for pi shows a free text field with one static
suggestion (`zai/glm-5.2`) from hcn's descriptor dump. The person's actual
models live in pi's own stores (`models.json` for custom providers plus
`models-store.json` for built-in providers, under the directory
`PI_CODING_AGENT_DIR` names), which today hold 25 provider/model pairs.
This RFC adds a read path from those stores through hcn into Lucid's
served driver choices, so the Model control drops down the installed
models per provider. Scope holds: same surface, same user, one list
corrected.

## Introduction

Problem: a person choosing a pi model in settings must type the id from
memory. A wrong id fails at turn time with a refusal. The stores already
answer which ids exist.

Scope: this RFC covers reading the installed pi stores and serving them
as the pi vocabulary's model list, per provider, in the settings Model
control. Out of scope: writing the stores, other harnesses (their lists
stay curated), model capability claims beyond installed-or-not, and any
change to turn dispatch or validation.

Motivation: the user asked for the live list after the combo-box fix. The
static suggestion names one id the person does not run. The stores name
25 they can.

Context: RFC-12 defined the driver menus and the served vocabulary shape
(`driverChoices.vocabulary[pi]` with `models`, `aliases`, `efforts`,
`extensible`, `provider`). D-008 in the hcn repo records that pi's model
registry is runtime-extensible and the curated list is a baseline, never a
refusal authority. This RFC consumes that fact: the live list extends the
baseline, and validation stays accept-clean-unknown.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD
NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted
as described in RFC 2119. Custom registry means pi's `models.json` under
the directory `PI_CODING_AGENT_DIR` names, else `~/.pi`. Built-in store
means pi's `models-store.json` under the same directory, else
`~/.pi/agent` (the agent-scoped fallback the transcript path uses for
sessions). Descriptor dump means `hcn inspect pi --json`. Served choices
means Lucid's `driverChoices` projection. Baseline means the descriptor's
curated `vocabulary.models`. A pair is one provider name plus one model
id; the pair is the unit the list carries, because one model id can exist
under two providers (`qwen3.6-35b-a3b-ud-mlx` under `lmstudio` and
`lmstudio-mini`).

## Motivation

Hand-typed ids fail late. A refused turn costs a full dispatch cycle and a
recorded failure before the person learns the id is wrong. A live list
moves that check to choice time, in the control where the choice is made.

## Design

hcn gains one inspection mode: `hcn inspect pi --models --json`. It reads
both stores (custom registry first, then built-in store; same directory
resolution the transcript path in `src/cli/transcript.ts` already uses)
and prints one JSON line:

```json
{ "v": 1, "source": "stores",
  "models": [{ "provider": "lmstudio", "model": "qwen3.6-35b-a3b-ud-mlx" }] }
```

`provider` and `model` are the two columns `pi --list-models` prints. hcn
SHOULD NOT spawn pi: the files are the source, and a 1-second spawn per
poll is cost without benefit. Entries that fail the clean-selector shape
are dropped individually; a store that cannot be read at all is skipped
and the other still serves.

Lucid's harness seam gains an optional `listModels(harness)` returning
pairs. The served-choices module calls it for pi alongside the descriptor
dump and merges: store pairs first, then baseline ids absent from the
stores. The `extensible` flag stays true, so an unlisted id remains a
valid choice. Registry reads MUST follow the process memo the descriptor
dump already uses: read once per process, since neither source changes
under a running server. A person who installs a model restarts the
server, same as an hcn upgrade.

The settings Model control carries pairs end to end. The seam, the served
choices, and the control all keep provider plus model; the control shows
provider-qualified labels (`lmstudio/qwen3.6-...`). On pick, the label
splits into the existing model field plus provider field. The free text
field and its datalist stay; the datalist gains one option per installed
pair plus the baseline ids. The Provider field stays a free text field.
The server keeps validating the pair at save.

Validation at save is unchanged: hcn checks the selection shape
(E-HUB-03), and only the native spawn decides availability. A listed pair
can still refuse at dispatch (logged-out provider, withdrawn model), and
that failure travels the existing turn failure path. The list narrows
which ids reach the spawn; it never promises the spawn succeeds.

## State Machine

No new states. The served choices carry more entries; the absent/unavailable
degradation from RFC-12 applies: a harness whose models cannot be read has
its baseline list, and a missing hcn means no entries at all.

## Error Handling

- `stores-unreadable` (info): neither store can be read. Result:
  `source: "unavailable"`, and Lucid serves the baseline list. No
  escalation; the control still accepts typed ids.
- `store-partial` (info): one store reads, the other does not, or single
  entries fail validation. Result: `source: "stores"` with the pairs that
  passed. hcn MUST NOT print a partial line without the source field
  saying which stores contributed; per-entry drops are silent, per-store
  skips are named in a `skipped` array.
- `dispatch-refused` (existing path): a listed pair pi refuses at spawn.
  Recovery: the existing E-HUB-03 save path and turn failure path. The
  list MUST NOT filter pairs by predicted acceptance; only pi decides.

## Security Considerations

Trust boundary: the store files are person-owned local config, same trust
as the rest of `PI_CODING_AGENT_DIR`. hcn reads them, never executes
them. Input validation: provider and model strings MUST match the
clean-selector shape hcn already enforces (`CLEAN_SELECTOR` in
`src/interpretation/vocabulary.ts`); entries that do not match are
dropped, not served. Blast radius: a hostile store entry can at most
appear as a suggestion label and then fail validation at spawn. No
credentials in the stores (`apiKey` fields, `op://` references) may enter
the served choices or the log; the projection carries provider/model pairs
only. The read path MUST NOT cross into the sessions directory or transmit
conversation text.

## Alternatives Considered

Spawn `pi --list-models` per poll and parse the table. Rejected: ~1s
spawn cost per poll, table parsing against a human-readable format with no
JSON mode, and environment inheritance (`PI_CODING_AGENT_DIR`) the hub has
to get right per spawn. The file read is cheaper and already has a
resolution precedent in `src/cli/transcript.ts`.

Serve the stores from Lucid by reading the files directly. Rejected: the
stores are pi's format, and Lucid never mirrors harness knowledge above
the seam (`docs/drivers.md`, hcn boundary). hcn owns the read and the
projection; Lucid consumes operation results.

Merge store pairs into the descriptor dump itself. Rejected: the dump
describes the installed hcn, which does not change under a running server;
the stores describe the person's providers, which change on their own
cadence. One mode per source keeps the caching story honest.

## Implementation Plan

1. hcn: `inspect pi --models --json` reads both stores, drops malformed
   entries, prints the pairs line with source and skipped fields.
   Fixture from a live registry. (hcn repo, separate review and release.)
2. Lucid seam: optional `listModels` on `HarnessRunner` returning pairs,
   hcn-runner implementation via the new mode, test double replays pairs.
3. Lucid served choices: merge store pairs ahead of baseline in the pi
   vocabulary; keep `extensible: true`.
4. Settings control: provider-qualified labels, split on pick into model
   plus provider fields. Browser probe against the live stores.
5. Docs: `docs/drivers.md` gains the store source and memo discipline;
   `docs/rfc/README.md` high-water mark moves on acceptance.

## Open Questions

None standing. The v1 questions are settled by this revision: qualified
labels split on pick (F3), process memo for both sources (F4).

## References

Normative: `docs/drivers.md` (hcn boundary, served choices), RFC-12
(driver menus, in Git history `44cb375`), hcn D-008 (pi vocabulary open,
`src/knowledge/pi.ts`).

Informative: `pi --list-models` output shape (25 rows on this machine),
`src/cli/transcript.ts` env resolution precedent, settings combo-box fix
(`src/server/client/settings-form.tsx` datalist), review
`29_live-pi-model-list-in-settings.review-v1.md`.

## Review response (v1 -> v2)

- F1 (registry is two stores): Design now reads `models.json` plus
  `models-store.json`; Terminology defines both.
- F2 (wrong fallback): fallback is `~/.pi/agent` for the built-in store,
  matching the transcript path.
- F3 (pair shape): the pair is the unit through seam, served choices,
  and control; qualified labels split on pick.
- F4 (refresh conflict): process memo for both sources, one statement.
- F5 (partial/malformed results): `source` plus `skipped` semantics per
  case.
- F6 (inspection vs availability): save-time check is shape-only; only
  the spawn decides availability.

---
number: 12
title: "Choosing the driver"
type: protocol
status: Implemented
author: Kevin Frilot
date: 2026-08-29
---

# RFC-12: Choosing the driver

## Abstract

A person can choose the driver of a conversation from the browser: the
harness, its model, a provider where the harness expresses one, and an
effort level. The choice is stored as `driver.json` beside `meta.json` in
the record, written by the server on the browser's behalf and never
appended to the log. A headless driver (`lucid2 chat`, `lucid2 run`) honors
the choice at the next turn boundary: it closes its harness runner and
re-opens under the new flags, and the conversation continues through
session recall. Mode is not settable from the browser, and an interactive
session is never re-spawned; for it the driver line stays a report.

## Introduction

### The problem

The driver line (design states 7a-7d) renders harness · mode · model ·
effort, and the design gave it open menus. `docs/reports/design-delta-v2.md`
section 3 scoped the menus out: nothing in the substrate could act on a
browser-side driver choice, and a menu whose choice could not act must not
be drawn as clickable. That left the line as report ink over placeholders.

The substrate beneath it is done. A harness recalls its own session across
a restart, proven for all four. One record can be handed between two
different harnesses mid-conversation. What is missing is the part that
persists a person's choice and the part that acts on it.

### What this covers

A preference file in the record, the endpoint that writes it, the honor
rule a headless driver follows, where the lists come from, and what the
client is told.

### What it does not cover

- **The interface.** Menu styling, placement, and glosses are the design's
  (7a-7d) and are not restated here. This RFC governs what a choice means,
  not how it looks.
- **Switching mode from the browser.** The preference carries no mode. The
  attach flow behind an interactive switch is not designed, and the design
  says mode stays non-switchable from this line. A `mode` or `profile`
  field on the endpoint is an unknown field and is refused.
- **Re-spawning interactive sessions.** A session a human owns is never
  re-spawned by lucid, whatever the file says. See the honor rule.
- **Changing `hcn`.** Where a dimension has no flag on the pinned hcn,
  this RFC states the fact and specifies what happens. It does not add
  flags to `@dungle-scrubs/harness-cli-normalizer`: every rule below runs
  against the pinned binary. The one gap it recorded - session effort -
  was closed by bumping to hcn 0.6.0, which grew `hcn session --effort`;
  the menus widened with it and nothing else changed.

### Why now

The design pass landed the line itself and left the menus as its recorded
gap. Everything the menus need underneath is proven, so the gap is now the
only thing between the line and being real.

## Terminology

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be
interpreted as described in RFC 2119.

| Term | Meaning |
|---|---|
| **preference** | The driver a person chose: harness, provider, model, effort. One file, the whole choice |
| **driver in force** | What is actually driving: the harness and flags the current runner was spawned under |
| **honor** | What a headless driver does with a preference: spawn under it, and re-spawn when it changes |
| **turn boundary** | The moment after a turn's terminal event and before the next input is handed to the harness |

"Record", "log", "driver", "harness", "hcn", "profile" and "session recall"
are used as `CONTEXT.md` defines them.

## The record part: `driver.json`

The preference lives at `<record>/driver.json`, beside `meta.json`, named
in the same style: lowercase, one word, the thing it holds.

```jsonc
{
  "v": 1,
  "harness": "pi",              // required: one of claude, codex, pi, muse
  "provider": "lmstudio",       // optional, present only when set
  "model": "qwen3.6-35b-a3b-mlx", // optional, present only when set
  "effort": "high"              // optional, present only when set
}
```

- `harness` MUST be present. A model and an effort are values in a
  harness's vocabulary; a preference naming one without naming which
  harness is a value without its domain. The client sends the whole
  bundle, so requiring the spine costs the interface nothing.
- The other three MUST be present only when set. Absent means the
  corresponding hcn default applies at spawn.
- The file MUST be written with mode `0o600`, like every file in the
  record, and MUST be replaced atomically (write a temporary in the
  record directory, rename over). A driver reads the file while the
  server may be replacing it; a rename gives every reader the whole old
  file or the whole new one, never a torn one.
- The file MUST never be appended to the log. The log is the append-only
  truth of what happened; a preference is a standing choice, rewritten at
  will. Folding it into the log would either freeze the choice or litter
  the truth with supersessions.
- The preference is part of the record and MUST travel with it. A copied
  record carries the person's choice to wherever it reopens.
- **Who writes it:** the server, on the browser's behalf, through the
  endpoint below. Nothing else writes it. The driver only reads. A driver
  MUST NOT rewrite the file to record what it spawned under - the driver
  in force is already in the log, on the attach and identity events.

An absent file is not an error: it is the state of every record today, and
it means the driver spawns from its own resolution chain (explicit harness
at spawn, else the default), as it does now.

## The endpoint

```
POST /api/conversations/:id/driver
```

Token auth as every write: the custom header, checked before routing. The
server never drives, and this endpoint does not change that - it writes one
file and spawns nothing.

The body is the whole preference, and the POST replaces the file. It is
not a patch: a field left out is a field cleared, back to the hcn default.
The client composes the bundle from the lists it renders, so a harness
change is sent together with a model (or none) valid for the new harness.

Validation, in order, each refusing before anything is written:

1. The body MUST parse as JSON; else `invalid-json` (400).
2. `harness` MUST be present and one of the four names hcn knows; else
   `invalid-harness` (400).
3. `provider`, `model`, `effort`, when present, MUST each be a non-empty
   string of at most 128 characters carrying no control characters - the
   record's existing wire-id shape; else `invalid-field` (400).
4. The body MUST carry no field outside `v`, `harness`, `provider`,
   `model`, `effort`. An unknown field is refused with `unknown-field`
   (400). `mode` and `profile` are unknown fields: mode is not settable
   from the browser.

**Membership is hcn's to judge, not the endpoint's.** The endpoint
validates shape; it MUST NOT validate that the model is in the harness's
list or the effort on its ladder. Three reasons: the lists describe a
pinned hcn and drift from the one that will spawn; a harness whose model
vocabulary is extensible (pi) accepts ids the descriptor never listed; and
one validation authority beats two. A value hcn refuses at spawn surfaces
through the honor rule's failure path, in the record, where the person
reads it. The client offers only listed choices (plus the open entry where
the vocabulary is extensible), so the honest path is the rare one.

On success the endpoint answers `200` with the stored preference.

The endpoint is blind to who is driving. A preference written while a
session runs interactively is stored and honored by the next headless
driver; the interactive session itself is never touched. The interface,
not the endpoint, governs whether menus are offered.

## What the client is told

The conversation projection (`GET /api/conversations/:id`) gains two
fields beside `driver`, which keeps reporting the driver in force:

- `driverPreference`: the file's content, or `null` when there is none.
  This is what the person chose, not what is running, and the two MUST
  never be conflated in one field - after a refused re-spawn they differ,
  and the difference is the story the page has to tell.
- `driverChoices`: the lists, read once per server process per harness
  through the harness seam (an `hcn inspect` spawn-less dump describes the
  installed hcn, which does not change under a running server; folding
  nothing, it MAY be cached for the process lifetime):

```jsonc
{
  "harnesses": ["claude", "codex", "pi", "muse"],
  "vocabulary": {
    "pi": {
      "models": ["zai/glm-5.2"],   // vocabulary.models, aliases resolved
      "efforts": ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      "extensible": true,          // vocabulary.extensible
      "provider": true             // turnOptions carries provider
    }
    // ... one entry per harness
  }
}
```

A dimension a harness does not express is absent from its entry, not
false: `provider` appears only where the descriptor carries the turn
option. The interface rule is the design's own - **absent, not disabled**.

## The honor rule

**Who honors.** A headless driver: `lucid2 chat` and `lucid2 run`, in both
headless profiles. An interactive driver (`interactive` attachment, a
session a human owns) MUST NOT re-spawn, whatever the file says; for it
the line stays report ink, per the design's interactive row. The server
honors nothing - it never spawns.

**At startup.** A driver spawning a conversation MUST read the preference
and spawn under it. Resolution order, per dimension: an explicit harness
named at spawn (`--harness`, `LUCID_HARNESS`) beats the preference and
pins the harness for that process's life; the preference beats the
default. Model, provider and effort have no spawn-flag surface today, so
the preference is their only source besides hcn's defaults.

**At each turn boundary.** Before handing an input to the harness, a
headless driver MUST compare the preference against the flags it spawned
under, on dimensions not pinned at spawn. Where they differ it MUST
re-spawn before handing the input over:

1. Close the current runner: end the session handle, or stop the
   per-turn spawn loop.
2. Re-open under the new flags, through the same seam and the same code
   path a restart uses: a fresh attach (the epoch bump is the existing
   takeover mechanism), the record replayed, the new harness named on the
   attach.
3. Resume the conversation:
   - **Same harness** - continue the session that harness reported on its
     identity event (headless-session), or the resume id carried between
     turns (headless-turn). This is RFC-03's session recall, proven for
     all four harnesses.
   - **New harness** - resume only what the record holds for that harness;
     the reducer's per-harness session map answers on attach-ok. The old
     harness's session id MUST NOT be carried across: it names a
     conversation the new harness never had. A harness with nothing
     recorded starts fresh, and the record carries the conversation - the
     cross-harness handoff, already proven.

**A running turn is never interrupted to apply a preference.** The check
happens at a boundary. A steer or an answer handed to a live turn goes to
the driver in force; the change takes effect at the next boundary.

**A failed re-spawn keeps the current driver.** If hcn refuses the new
invocation (exit 2, `HarnessRefusal` - an unknown model, a provider the
harness cannot express), or the spawn fails, or the first turn reports a
failure (`unavailable` - the provider cannot serve the requested model),
the driver MUST:

- keep the current runner answering - the input in hand runs on the
  driver in force;
- record the refusal as a non-terminal error event through the existing
  sequencer path, worded to name both sides, e.g.
  `driver change refused: <hcn's refusal message>; continuing under claude/claude-opus-5`.
  The existing failure semantics, and no new failure class, event kind,
  or refusal code;

The error event is the design's rule made real: a consequence with no
visual gets words. The line keeps rendering the driver in force from the
projection; the menus keep showing the preference; the event says why they
differ.

**No retry spam.** A refused re-spawn MUST NOT be retried on every turn.
The driver remembers the refused preference and re-attempts only after the
file changes again. The preference file is left as written - it is the
person's choice, not a claim about what runs, and the person may fix it
with another choice, not with lucid quietly reverting it.

**Effort on both profiles.** hcn 0.6.0 carries `--effort` on `hcn run`
and `hcn session` alike (verified by running the pinned binary), so both
headless profiles honor all four dimensions and the effort menu is
offered on both. Before 0.6.0 the session surface carried no `--effort`:
a session driver's effort stayed the hcn profile default (medium) and its
menu was absent, not disabled - the same rule the design set for every
dimension that cannot act. That rule stands for any future dimension a
surface cannot express.

## The lists

One source, read through the harness seam; lucid mirrors nothing.

| List | Exact source |
|---|---|
| Harnesses | The four hcn knows: `claude`, `codex`, `pi`, `muse` - the seam's `HarnessName`, the same list `harnessForName` resolves into |
| Models | `hcn inspect <harness> --json`, `vocabulary.models`, with `vocabulary.aliases` resolved |
| Effort levels | The same dump, `vocabulary.efforts` |
| Provider | No list exists. `turnOptions` carrying `provider` (pi only) says the dimension is expressible; the value is open and hcn validates it at spawn |

`vocabulary.extensible: true` (pi) means the model list is open: the menu
offers a free entry beside the listed models, and the server accepts any
model string, per the validation rules above. Pi registers models at
runtime (`~/.pi/models.json`), so a closed list would be a lie the
re-spawn path would keep correcting.

The seam (`HarnessRunner.inspect`) currently projects only `session` and
`verifiedAgainst`; it MUST be widened to carry the vocabulary facts above.
That is the one interface change inside `src/harness/`, and it stays
inside the seam: above it, nothing knows what a descriptor is.

## Error handling

| Code | When | What happens |
|---|---|---|
| `invalid-json` | The body does not parse | 400, nothing written |
| `invalid-harness` | `harness` missing, or not one of the four | 400, nothing written |
| `invalid-field` | `provider` / `model` / `effort` present but not a bounded, control-free string | 400, nothing written |
| `unknown-field` | Any field outside the five, `mode` and `profile` included | 400, nothing written |

A refusal at re-spawn is none of these. It is not an endpoint error at
all: the endpoint has already answered, and the refusal arrives at spawn,
later, against the driver. It surfaces as the error event the honor rule
names, through the semantics that already exist.

## Security considerations

The endpoint takes the same token as every write, on the same loopback,
behind the same origin check. Nothing about it widens reach: it writes one
bounded JSON file inside a record the token already governs.

The file is written `0o600` and read by the driver in the same user; it
never leaves the record, and the record never leaves the machine.

The fields are bounded at 128 characters and refused on control
characters, so a preference cannot balloon the file or smuggle bytes into
a spawn the way an unbounded string could. The values become hcn flags and
nothing else: they are passed as validated arguments to `hcn`, never
through a shell, never interpolated into a harness's native command line.

A hostile model id costs one refused spawn and one error event - the
failure path above is also the abuse path, and it terminates.

The server's role does not grow: it writes the preference and answers. It
never takes the presence lock, never spawns, never acts on an effect. The
honor rule belongs to the process that holds the presence lock, which is
the only process that could act on it.

## Versioning and compatibility

`v: 1` on the file, as `meta.json` carries it.

The file is additive to the record: a build that predates it opens the
record unchanged, and a record without it is the common case for every
existing record. A reader that does not know a later field MUST ignore it
and read the fields it knows - the driver reads the four names and skips
the rest, the way the fold carries an entry source it does not know.

`driver.json` MUST NOT grow a field the honor rule would have to guess at.
If a later RFC adds a dimension (a sandbox, a system prompt), it carries
its own honor rule with it.

## CONTEXT.md, exactly

One row added to "The record and its parts":

```md
| **driver preference** | `driver.json`, beside `meta.json`. The harness, provider, model and effort a person chose in the browser. Written by the server; honored by a headless driver at the next turn boundary. Never in the log |
```

And the record's own inventory in that table's `record` row gains the
file: "`log.ndjson`, `meta.json`, `driver.json`, `secret`, the two locks".

No other term changes. The mode table already defines profile, harness,
and channel status; the preference introduces no mode and no profile.

## design-delta-v2.md, exactly

Section 3's scoping ruling is marked superseded by this RFC: the open
menus with real harness / model / effort lists are in scope. The ruling's
mode clause stands - mode never switches into `interactive` from the line,
and this RFC keeps mode out of the browser entirely. The interactive
report-only treatment stands with it. This RFC is committed together with
that edit.

## Implementation notes

Ordered so each step leaves `bun run check` green.

1. **The seam.** Widen `HarnessRunner.inspect` to carry
   `models` (aliases resolved), `efforts`, `extensible`, and whether
   provider is expressible; `effort` rides `StreamTurnOptions` and
   `OpenSessionOptions` alike, rendered by the hcn runner as `--effort`
   on both surfaces (hcn >= 0.6.0). No fixture changes beyond the
   deliberate re-capture the hcn bump records.
2. **The store.** `driver.json`: atomic replace, `0o600`, tolerant read
   (absent file, unknown fields). Testable without a browser.
3. **The endpoint and the projection.** `POST .../driver`, the two
   projection fields, validation per this RFC.
4. **The honor rule.** The boundary check, the re-spawn through the
   restart path, the refused-re-spawn keep, the no-retry rule. The
   deterministic gate: a fake hcn fixture that refuses one invocation,
   asserting the driver in force answers the input and the event lands.
5. **The client.** The menus, the lists from `driverChoices`, the
   absent-not-disabled rules.

Step 4 is the one that may not be shortcut: it is the whole point of the
RFC, and every other step exists to feed it.

## Open questions

1. **Should the menus be offered on a conversation with no driver?**
   The preference would be honored by the next headless driver to start.
   *Recommendation: yes - the "No driver" state (3d) already names
   reload, and choosing a driver while nothing runs is the natural moment
   to choose one.* Settled by the client step.
2. **Should a refused re-spawn be reported anywhere besides the error
   event?** The transcript carries it and the line shows the divergence.
   *Recommendation: nowhere else - one record of a refusal is the record;
   two invite disagreement.*
3. **Provider for a harness that grows one later.** The preference field
   and the menu are governed by the descriptor, so a new harness carrying
   provider widens both with no change here. No action.

## References

### Normative

- RFC 2119, Key words for use in RFCs to Indicate Requirement Levels
- RFC-03, Resume - the record remembers which harness held the session -
  the per-harness session map and the resume discipline the re-spawn uses
- RFC-04, Live delivery - the cursor and replay discipline the re-attach
  inherits by using the restart path

### Informative

- `docs/reports/design-delta-v2.md` - section 3, the scoping ruling this
  RFC supersedes; section 2, the driver line's design
- The design handoff `README.md`, "7a-7d - The driver line" - the menus,
  the glosses, absent-not-disabled
- `CONTEXT.md` - the record and its parts; not lucid's words
- The `hcn` skill and `hcn inspect <harness> --json` - the descriptor
  dump the lists are read from; `hcn run --help` / `hcn session --help`
  on the pinned 0.6.0, run to verify which flags each surface carries

---
name: lucid
description: >
  Render a response as a reviewable HTML artifact inside a lucid-managed
  conversation. Use for plans, roadmaps, comparisons, checklists, schemas,
  diagrams, specs, walkthroughs, and other structured answers the user may
  want to annotate at an element or phrase. Requires the lucid artifact
  protocol marker supplied by `lucid chat` or `lucid run`, or a native
  Codex CLI or Claude Code session using Lucid publication and connection
  commands.
compatibility: Requires lucid; native listening requires the Codex CLI or Claude Code integration.
---

# Lucid artifact authoring

Use Lucid when the answer is a document the user will want to inspect,
operate, or mark up in the browser. In lucid the conversation owns the
artifact: do not create a sidecar file, call the old `lucid open`/`wait`
commands, or run a second review loop.

## Choose the delivery path

For feedback containing `<lucid-offer>`, follow the native flow in
[Native Codex authoring](../../docs/native-codex.md#author-and-revise).
Record receipt before work, publish revisions into its exact conversation,
then record a response. A native offer takes precedence over an artifact
protocol marker included in its context. In Claude Code, also follow
[Native Claude Code](../../docs/native-claude.md#why-commands-finish-in-a-hook):
run each Lucid command in its own foreground Bash call from the main
conversation, never a subagent, and read the result reported after it.

Otherwise, when the prompt contains `[lucid artifact protocol]`, use the
artifact fences below. The Lucid host captures them into its conversation.

In a native Codex CLI session without either marker, use
[Native Codex authoring](../../docs/native-codex.md#author-and-revise) to
publish through the CLI, retain the returned conversation ID, and request
listening. A failed connection does not undo publication or justify creating
another record. Setup and publication alone do not establish listening.

In a Claude Code CLI session without either marker, do the same with the
differences in [Native Claude Code](../../docs/native-claude.md). If
publication reports `registration-missing`, keep the conversation and tell
the person the Claude Code integration is not set up in this session; do
not claim notes will arrive.

Other ordinary native interfaces have no enabled authoring integration yet.
Answer normally and explain that browser review requires a conversation
started through `lucid chat`. Do not emit an uncaptured artifact fence.

## Emit through a Lucid host

Follow the artifact protocol supplied in the prompt. For the first version,
emit one complete, self-contained HTML document:

````text
```lucid-artifact
{"id":"stable-document-id","replaces":null,"contentType":"text/html"}
<!doctype html>
<html>...</html>
```
````

The conversation holds one artifact. Choose a short, stable id on the first
emission and reuse it forever. Do not introduce a second id for a revision,
variant, appendix, or diagram; place those sections in the same document or
ask the user to start another conversation.

Lucid assigns the version, author, timestamp, and hash. Never put those in the
header yourself.

## Design for review

- Produce a complete HTML document with one inline stylesheet.
- Use semantic elements: headings, sections, paragraphs, lists, tables,
  figures, and labels. Lucid instruments every element for selection.
- Make each meaningful idea its own element. Do not flatten a plan, table, or
  diagram into one large text node.
- Use HTML/CSS or inline SVG for diagrams, flows, timelines, and wireframes;
  reserve `pre` for literal code, commands, paths, or logs.
- Keep the document readable without network access. Do not depend on CDNs,
  remote scripts, fonts, images, or stylesheets.
- Prefer an editorial document over an application shell: clear hierarchy,
  generous whitespace, restrained color, and one accent.
- Use flexbox for mixed-width layouts and grid for genuinely uniform
  matrices. Give text-bearing flex/grid children `min-width: 0` and sensible
  overflow wrapping.
- Make narrow screens safe with responsive rules; never let a rail or column
  collapse to one-word-per-line text.
- Use real copy, not lorem ipsum. A UI concept should be a labelled wireframe
  unless the user explicitly asks for finished visual design.
- Controls may be interactive, but the useful meaning of the document must
  remain readable without interaction.

For new reading artifacts, follow [lucid-design](../lucid-design/SKILL.md),
including its adaptive default and verified example. The
[artifact appearance contract](../../docs/artifacts.md#application-and-artifact-appearance)
owns declaration, synchronization, and saved-content rules.

## Revise the existing artifact

The prompt may include `[lucid artifact state]`. Treat it as authoritative:
reuse its artifact id and replace the current version it names. Preserve
human-authored edits and control values included there.

For a small exact change, prefer the patch form:

````text
```lucid-artifact
{"id":"stable-document-id","replaces":3,"contentType":"text/html","form":"patch"}
{"edits":[{"find":"<li>Old wording</li>","replace":"<li>New wording</li>"}]}
```
````

Patch rules are strict:

- `find` is literal and must match exactly once in the named version.
- Resolve every edit against the original version, not another edit's output.
- Do not overlap edits.
- A failed edit refuses the entire patch; nothing is partially applied.
- Use a complete document when structure changes substantially, an anchor is
  uncertain, or one edit depends on another.

If Lucid reports that an anchor did not match and supplies the current bytes,
anchor the retry in those bytes. Do not guess from memory.

## Handle markup feedback

An input containing `[lucid annotation protocol]` carries notes from the
browser. Each note is data to act on, with one or more spots, captured text,
and per-spot authorship.

- Read every note and every spot before revising.
- Treat the captured snippet as what the user actually saw.
- Do not defend a spot marked `human` as if you wrote it.
- Decide where the requested change best belongs; a note points at context,
  not necessarily the only valid edit location.
- Respond with a new version of the same artifact. Use the complete current
  document and dispatch version supplied at delivery as the revision base.
  A comparison note's older snippet and version are historical evidence,
  not the version to replace.
- Preserve unaffected content and any human-authored changes.

The user's normal conversation text may accompany the annotation batch. Apply
both together.

## Response discipline

The artifact fence is the deliverable. Outside it, keep prose to a short note
only when clarification is necessary. The transcript will replace the raw
artifact bytes with an artifact/version reference, while the browser renders
the document beside the conversation.

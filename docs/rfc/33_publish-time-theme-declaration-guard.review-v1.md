```text
+-----------------------------+
| RE-WRITTEN WITHOUT THE CRAP |
+-----------------------------+
```

The review is complete. This session’s read-only filesystem policy prevents writing or opening `docs/rfc/33_publish-time-theme-declaration-guard.review-v1.md`. The review text follows.

# RFC 33 review v1

## What was reviewed

Reviewed `docs/rfc/33_publish-time-theme-declaration-guard.rfc.md` in full, including all 4 specified normative references.

- Status: Draft.
- Version: unversioned.
- Snapshot identifier: `unversioned-adbf581a9793`.
- SHA-256: `adbf581a97932915826b2c7d7066b828990f69f97f48d7d0a206336e95da15e3`.
- Codebase HEAD: `c0474205f6eea15a78011ef4202eb8847a0045fb`.
- Intended filename: `33_publish-time-theme-declaration-guard.review-v1.md`. The caller’s explicit filename takes precedence over the skill’s default snapshot-based filename.

This review identifies contract gaps for the author and implementer. It does not revise the RFC or decide whether to build the feature.

## Structural results

The prescribed validator command was attempted first:

```text
npx tsx /Users/kevin/.agents/skills/draft-rfc/scripts/validate-structure.ts docs/rfc/33_publish-time-theme-declaration-guard.rfc.md
```

It exited 1 before running the validator. Output, verbatim:

```text
npm error code ENOTFOUND
npm error syscall getaddrinfo
npm error errno ENOTFOUND
npm error network request to https://registry.npmjs.org/tsx failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org
npm error network This is a problem related to network connectivity.
npm error network In most cases you are behind a proxy or have bad network settings.
npm error network
npm error network If you are behind a proxy, please make sure that the 'proxy' config is set properly.  See: 'npm help config'
npm error Log files were not written due to an error writing to the directory: /Users/kevin/.npm/_logs
npm error You can rerun the command with `--loglevel=verbose` to see the logs in your terminal
```

The same validator was then run with installed Bun:

```text
bun /Users/kevin/.agents/skills/draft-rfc/scripts/validate-structure.ts docs/rfc/33_publish-time-theme-declaration-guard.rfc.md
```

It exited 0. Validator output, verbatim:

```json
{
  "passed": true,
  "errors": [],
  "warnings": []
}
```

## Findings

### F1. High: the CLI does not expose the promised error code

**Location:** Design, lines 95-99; Error Handling, lines 130-135; Implementation Plan.

**Evidence level 4: "You ran it."** A subprocess probe exercised the current CLI error path. The proposed theme error itself does not exist yet.

The RFC requires headless callers to match a distinct code without parsing prose. It describes "HTTP 400 through the CLI adapter." The actual CLI catches errors and prints only `e.message` at `src/cli/main.ts:38`. Its publication and handoff `--json` branches serialize successful results only (`src/cli/dispatch.ts:315`, `src/cli/dispatch.ts:335`).

A probe invoked the source CLI with `handoff --request /nonexistent-rfc33-review-request.json --json`. Assertions confirmed:

```json
{"exitCode":1,"stdout":"","stderr":"The handoff request file is missing or unreadable.\n"}
```

That error is constructed with `E-HUB-03` and status 400 at `src/cli/handoff-request.ts:41`. Neither field reaches the caller.

Adding a new `HubError` code alone cannot deliver the promised interface. Specify the serialized error shape, output stream, and exit status. Add CLI-level verification for both commands. Distinguish an internal status field from an HTTP response.

### F2. High: the admission table omits existing-record and retry states

**Location:** Introduction, lines 41-48; Design, lines 101-125; Implementation Plan, lines 199-205.

**Evidence level 2: "You pointed at the code."** The cited branches establish the state coverage gap. The consequences under a future guard have not been reproduced at level 4.

The RFC treats these functions as version-1 creators. It exempts revisions addressed by `conversationId`. Their current input and storage contracts are broader:

- Both request validators accept any positive safe-integer version (`src/cli/artifact-publish.ts:85`, `src/cli/handoff-request.ts:78`).
- Storage accepts a previously absent artifact/version key without requiring the first version to be 1 (`src/store/log.ts:1534`).
- A `creationId` can resolve to an existing record through its receipt (`src/store/creation.ts:70`).
- Handoff has explicit retry and already-accepted-continuation branches (`src/cli/handoff.ts:104`).
- Publication writes a native-publication requirement before writing the artifact (`src/cli/artifact-publish.ts:153`).

The 3-row table does not settle:

1. First publication into an existing empty conversation.
2. First publication whose supplied version is greater than 1.
3. A revision addressed through a matching creation receipt.
4. An identical retry of an unmanaged publication made before this guard existed.
5. A partial handoff retry where the artifact exists but continuation acceptance remains incomplete.
6. Error precedence when a retry has both conflicting bytes and an unmanaged declaration.

A theme refusal on an existing record cannot mean that no record or receipt exists. It must specify which new writes are forbidden. Checking after `recordNativePublication()` would also violate the intended no-side-effect guarantee.

Define admission by whether the artifact already exists. Keep that rule independent of the addressing field and numeric version. State the policy for identical and partial retries. Preserve the existing conflict rules. Add tests that verify durable state remains unchanged after a theme refusal.

### F3. Medium: the marker contract remains partly exemplary and contradictory

**Location:** Design, lines 88-93; Security Considerations, lines 151-152; Implementation Plan, lines 199-203; Open Question 1.

**Evidence level 2: "You pointed at the code."** This is a specification gap. It is not a reproduced implementation failure.

Design requires a request field but gives `"theme": "unmanaged"` only as an example. It makes the CLI flag optional. The implementation plan includes the flag. Open Question 1 still offers a CLI-only alternative.

The existing handoff parser rejects unknown top-level fields. It also reconstructs the returned request explicitly (`src/cli/handoff-request.ts:51`, `src/cli/handoff-request.ts:143`). The parser must therefore admit, validate, and retain the marker. Publication currently receives an unshaped object.

Select the exact field and accepted value before implementation. Specify:

- Absent field versus invalid strings, `null`, booleans, arrays, and objects.
- The error classification for an invalid marker.
- How the flag combines with a valid or invalid field.
- Whether marker validation still applies to exempt revisions.

Reject malformed fields first. Then let the flag supply `"unmanaged"` when the field is absent. The flag should not silently conceal an invalid request value.

### F4. Medium: the claimed validation order does not match publication code

**Location:** Design, lines 113-116; Security Considerations; Implementation Plan step 2.

**Evidence level 2: "You pointed at the code."** The ordering is visible in source. Resource-exhaustion consequences are unmeasured. They have not reached level 4.

The RFC places parsing before record creation. It refers to existing identity-then-bytes validation. `publishArtifact` checks that bytes are a string but does not enforce `ARTIFACT_BYTES_MAX` before `createWithReceipt` (`src/cli/artifact-publish.ts:85`, `src/cli/artifact-publish.ts:133`).

Its size check currently occurs inside `host.writeArtifact`, after creation (`src/store/conversation-host.ts:575`). Handoff already checks the limit in its request parser (`src/cli/handoff-request.ts:91`).

Putting the theme parser before publication’s record creation would also put it before the current size limit. The reader parser constructs a parse tree (`src/server/client/artifact-metadata.ts:13`).

Explicitly require the existing size bound before theme parsing in both paths. Add an oversized-input test. Verify that neither parsing nor durable writes occur.

### F5. Low: the refusal’s HTML example is not an accepted declaration

**Location:** Design, lines 95-97.

**Evidence level 4: "You ran it."** An assertion called the actual `preferredArtifactTheme` implementation with the RFC’s literal snippet.

The proposed fix is:

```html
<meta name="lucid-theme" content="adaptive|light|dark">
```

The reader returns `unmanaged` for that value. It accepts only 1 exact value, as implemented at `src/server/client/artifact-theme.ts:6`.

The notation can express alternatives to a reader. Copying it into HTML does not repair the refusal. Show a valid example using `adaptive`, with matching `color-scheme` metadata. Then list `light` and `dark` as alternatives.

### F6. Low: all 6 reference links resolve to missing paths

**Location:** References, lines 231-239.

**Evidence level 4: "You ran it."** A filesystem probe resolved every Markdown link relative to the RFC directory. Assertions confirmed that each target was absent.

The links use paths such as `docs/artifacts.md` from inside `docs/rfc/`. Standard relative resolution therefore looks under `docs/rfc/docs/`, `docs/rfc/src/`, and similar nonexistent directories.

The referenced files exist at the repository root paths specified in the prose. Use:

- `../artifacts.md#application-and-artifact-appearance`
- `../../test/server/artifact-theme.test.ts`
- `../../src/cli/artifact-publish.ts`
- `../../src/cli/handoff.ts`
- `../../skills/lucid-design/examples/adaptive-reading.html`
- `../artifacts.md`

The broken links prevent direct access to the normative contract and verification sources.

## Positions on the 3 Open Questions

### 1. Marker shape

Use the top-level request field `"theme": "unmanaged"` as the canonical representation. Support `--allow-unmanaged` on both commands. The flag produces the same validated request.

This position follows the current file-driven command interfaces (`src/cli/mapping.ts:223`, `src/cli/dispatch.ts:335`). Resolve invalid-field precedence as described in F3.

**Evidence level 2: "You pointed at the code."** This is a design recommendation. The proposed interface has not been run.

### 2. Error code number

Assign the next unused code at implementation time after a repository-wide search. Do not infer availability from the `HubError` union alone.

`E-HUB-05`, `E-HUB-06`, and `E-HUB-07` are used elsewhere despite being absent from that union. `E-HUB-08` is also occupied. The review search found no `E-HUB-09` occurrence under `src`, `docs`, or `test`. It is a current candidate, not a reservation.

References include `src/modes/host.ts:828`, `src/store/conversation-context.ts:25`, `src/modes/managed-execution.ts:49`, and `src/protocol/hub-errors.ts:6`.

The serialized CLI error contract in F1 matters more than the chosen number.

**Evidence level 2: "You pointed at the code."** Availability is a search result for this snapshot. Recheck it at implementation time.

### 3. Check `color-scheme` presence

Do not add that check to this guard. Keep admission aligned with the reader’s `lucid-theme` classification. Continue to show matching standard metadata in authoring guidance and refusal examples.

The current reader accepts declarations without `color-scheme`. The existing theme test exercises those cases. Requiring it here would introduce a stricter admission policy than the declared reader-parity rule.

**Evidence level 4: "You ran it."** The existing theme test passed with 30 assertions. The recommendation preserves that tested classification. It does not claim correct visual styling.

## Cleared

- The supplied structural validator passed with no errors or warnings.
- `bun test test/server/artifact-theme.test.ts` passed: 1 test, 0 failures, 30 assertions.
- The current parser uses `parse5`. The inspected module has no browser DOM dependency. The theme test runs it under Bun. No demonstrated bundle restriction currently justifies a second implementation.
- The inspected metadata reader reads direct head metadata. It does not execute artifact scripts or fetch resources.
- The defined managed/unmanaged terms correspond to the current classifier. All 4 domain terms in Terminology are used later.
- The appearance contract makes unmanaged frames follow system preference. A declaration remains an author claim. It does not prove styling correctness.

Whole-document checks:

| Check | Result |
|---|---|
| Uncovered states | Existing-record, non-1 initial version, and retry cases appear in F2. |
| Dangling references | F6 covers 6 broken relative links. The intended files exist. |
| Unused or undefined terminology | No unused defined domain term found. Exact marker representation remains unsettled in F3. |
| Conflicting normative statements | F3 covers request-field versus CLI-only alternatives and optional versus planned flag delivery. Retry precedence remains unresolved in F2. |
| Scope not delivered | The listed guard changes alone do not deliver machine-matchable CLI refusal. See F1. |
| Drift from codebase | Version assumptions, CLI error transport, and validation order appear in F1, F2, and F4. |

## Not reviewed

- No proposed guard implementation exists to test. Findings about its future admission behavior remain at evidence level 2.
- No record-writing publication or handoff tests were run. This session permits filesystem reads only.
- No browser verification was performed. The original mixed-theme incident was not independently reproduced.
- The full `bun run check` suite was not run. No repository files were changed.
- Parser stress limits and hostile-input resource use were not benchmarked.
- The RFC identifies its author as `pi`. That identifies a harness, not a model family. The metadata does not establish cross-family review independence.
- The read-only policy prevented saving the report and probe scripts. Executed probe results are recorded above.
---
number: 23
title: "Artifact link navigation and validation"
type: feature
status: Accepted
author: Kevin
date: 2026-09-11
version: v2
---

# RFC-23: Artifact link navigation and validation

## Abstract

Artifact fragment links navigate the frame to the containing Lucid page,
leaving it empty. External links replace the frame, and new versions can
include unchecked destinations. Lucid will keep section navigation inside the
document, open web links in separate tabs, and validate links before storing
new agent versions.

## Introduction

This serves Lucid's existing single reader who uses and annotates agent
documents. Navigation holds product scope; mandatory external checks add the
admission behavior explicitly requested by the user. Historical versions stay
readable. The three named artifacts receive corrected immutable revisions if
their authored links need repairs. Continuous monitoring and assessing whether
a source supports the prose are outside this correction.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT,
RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as
described in RFC 2119. Artifact, version, record, and artifact frame retain
their CONTEXT.md meanings. A fragment link starts with `#`. A web link has an
absolute HTTP or HTTPS URL. A check observes a response; it does not guarantee
future availability or source accuracy.

## Motivation

Live reproduction: clicking `#reference` replaces `about:srcdoc` with the
Lucid route and leaves an empty body. Setting a document-local base in a
temporary browser probe retains the heading and scrolls 785 pixels. Current
tests exercise annotation callbacks but omit native navigation.

## Design

Shared frame instrumentation MUST resolve fragment links against the artifact
document, regardless of the containing URL. Web links MUST open in new tabs
with noopener and noreferrer. This applies in reading, annotation, and
comparison frames, including dynamically inserted links. Instrumentation MUST
preserve authored markup in snapshots and keep text selection usable. Frames
MUST retain opaque origins. They MUST allow popups that escape the sandbox so
destinations work normally; same-origin and top-navigation permissions stay absent.

New agent HTML MUST pass structural and remote checks before append. Fragment
targets MUST resolve to exactly one ID or legacy named anchor; empty fragments
mean the document top. Relative web paths and unsafe schemes MUST be refused.
Mail and telephone links MAY remain protocol-handler links without HTTP checks.
Inert template content is excluded. Distinct web URLs are checked once per
admission, omitting fragments from HTTP requests. Remote fragment existence and
semantic correctness are not claimed by an HTTP check.

The durable host's writeArtifact operation becomes asynchronous. Callers MUST
await it, including emission, browser saves/restores, and standalone writes.
Network checks MUST run outside the append transaction. Existing version
conflict checks still run under the lock after validation. Human saves and
historical reads retain existing admission behavior.

Checks MUST use bounded GET requests without credentials or cookies and follow
at most five redirects manually. Each redirect destination MUST pass URL and
network-address validation. Only public addresses are eligible. DNS answers
MUST be checked and pinned to the connection, preventing rebinding. Private,
loopback, link-local, reserved, and multicast addresses are refused. Response
bodies MUST NOT be accumulated. Each URL has a 10 second total deadline; an
artifact has a 30 second total deadline, at most 100 distinct URLs, and at most
four checks in flight. Tests inject probes or use transport fakes and MUST NOT
depend on the internet.

## State Machine

Structural refusal ends admission without requests or a stored version. Valid
structure proceeds to checking. All checks successful proceeds to atomic
append. A broken, blocked, or unverified destination ends admission without a
version. A concurrent version conflict remains a refusal. No automatic agent
retry or replacement document is introduced.

## Error Handling

artifact-link-invalid identifies invalid syntax or missing/ambiguous local
targets. artifact-link-broken identifies HTTP 404 or 410. Other non-success
responses, DNS failures, and deadlines are artifact-link-unverified. Errors
MUST name a bounded URL excerpt and explain the result without claiming a
blocked site is broken. The agent can correct or remove a link and emit again.
The previously stored document stays available.

## Security Considerations

Bytes and destinations are untrusted. Reject credentials and unsupported
schemes. DNS pinning and redirect validation prevent probes reaching local
services. Probes do not execute returned markup, send browser identity, or
read secret files. Separate tabs have no opener. Frames gain no access to
Lucid's origin, token, storage, or parent navigation.

## Alternatives Considered

Author instructions alone cannot enforce checks. Browser fetch cannot reliably
check cross-origin pages because of CORS. Checking under the append lock blocks
unrelated record activity. An asynchronous writer keeps I/O outside the
transaction and applies the gate to standalone writes too.

## Implementation Plan

1. Correct frame navigation; verify native navigation and snapshot preservation.
2. Add bounded validation at the durable writer and await it at each caller.
3. Audit and repair the three artifacts, run check/build and browser evidence,
   and commit the scoped change.

## Open Questions

None. The user requested implementation, validation, repairs, and a commit.
Timeouts are unverified and fail admission rather than silently passing.

## References

### Normative

- [Artifact contract](../artifacts.md)
- [Browser authority](../adr/0008-browser-and-agent-content-have-separate-authority.md)
- [CONTEXT](../../CONTEXT.md)

### Informative

- [HTML iframe standard](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#the-iframe-element)

## Review response, v2

This revision addresses the cross-family review v1. Implementation is authorized
by the user's request to apply the fixes.

- B1: Transport is a direct node:net/node:tls socket to the checked IP, reading
  at most 16 KiB of HTTP/1 response headers and no body. Bun node:http and fetch
  both failed the environment-proxy isolation test, so neither is used. It MUST use the original Host
  and TLS server name, verify certificates, and ignore environment proxies.
  A real loopback transport test verifies the supplied address and Host; a
  resolver test proves private addresses never reach transport.
- B2: Address policy conservatively excludes all special-use IPv4 ranges,
  including 100.64/10 and 0/8. IPv6 accepts global-unicast 2000::/3 only,
  excluding special-use 2001::/23, documentation ranges, 2002::/16 and 3fff::/20.
  Mapped, NAT64, local and other non-global IPv6 are refused as whole addresses.
- B3: Concurrent version refusal MUST mark the current artifact bytes owed to
  the agent, using the existing recovery mechanism; it MUST NOT overwrite a save.
- B4: Admission accepts an AbortSignal. Closing the writer or stopping the
  source MUST cancel pending checks and prevent append after cancellation.
  Cancelled checks return artifact-link-unverified and no version. Normal
  harness completion waits for admission; only explicit stop cancels it.
- B5: The popup grants are required. The concrete threat is a destination
  obtaining the opener or an artifact reaching the parent origin. Tests MUST
  prove ordinary links have no opener and opaque frames cannot read the parent.
  Authored scripts may open popups subject to browser user-activation policy;
  they already execute arbitrary document interactions. Parent access and
  top navigation remain forbidden. Update ADR 0008 and the artifact contract.
- M1: Check a[href], area[href] and SVG a[href]; not SVG use, resource URLs,
  forms, metadata navigation or xlink:href. Allow only #, absolute http(s),
  mailto and tel. Scheme-relative links are refused at admission. Percent-decode
  fragments; #top means top when no matching target exists. Authored base URLs
  do not affect explicit fragment links. Targets must exist in static markup;
  script-only targets cannot prove admission. Dynamic links get viewer routing,
  but remote checks describe only the static emitted document.
- M2: Admission makes credential-free outbound requests to authored public URLs,
  including queries, before viewing. This is the behavior the user requested.
  It is not a general network tool or a containment boundary for model output.
- M3: Offline, blocked, and rate-limited web links prevent new agent versions.
  Human saves and historical reads stay usable. A patch's complete result is
  checked, including links inherited from a human version. No bypass is added.
- M4: Over 100 normalized, fragmentless distinct URLs is an invalid refusal,
  never truncation. The 30-second artifact budget is a cap, not a guarantee
  that all 100 URLs finish; unfinished checks are unverified. URL parsing supplies
  canonical host/port/escaping normalization; query order is preserved.
- M5: Private addresses, unsafe redirects, and redirect exhaustion are unverified.
  Initial invalid syntax/schemes are invalid. A redirect without Location is
  unverified. Only 200-299 is successful; 404 and 410 report their HTTP result.
- M6: Migrate all writeArtifact callers and audit discarded promises with the
  compiler API, including fixture aliases. Existing end-to-end tests verify
  ordering. Do not add a second lint implementation as a product dependency.
  Migrate fakes with the interface.
- m1: Repair trevor-architecture (Portable coordination),
  tomcounsell-ai-orientation, and hcn-coordinator-exploration.
- m2: Clear the harness watchdog before awaiting artifact admission.
- m3: Update admission, sandbox, and verification contracts and ADR 0008.
- m4: Mail and telephone links retain browser protocol-handler behavior.
- m5: A legacy named anchor is an a element with a matching name attribute.

# Security policy

## Supported versions

Lucid is pre-1.0. Only the latest `main` is supported. There are no backports.

## Reporting a vulnerability

Report privately through GitHub Security Advisories:

**https://github.com/dungle-scrubs/lucid/security/advisories/new**

Do not open a public issue for a vulnerability. Expect an initial response
within a week. Pre-1.0 and single-maintainer, so that is a best effort, not an
SLA.

## Security model

Lucid runs a loopback server per session and renders agent-authored HTML in a
browser. The boundary it defends is **the artifact must not be able to reach
Lucid's control routes or the filesystem outside its own directory.**

What holds that line:

- **Loopback only.** The server binds `127.0.0.1`. Binding a non-loopback
  interface is not an option, not a flag, and will not be added.
- **Host validation on every control route.** The `Host` header must resolve to
  a loopback name (`127.0.0.1`, `localhost`, `[::1]`) on the session's port, or
  the request is rejected. This is the DNS-rebinding defense: a rebound external
  name fails the check. Note that it accepts any loopback name on that port, not
  one exact origin string.
- **Origin validation when an Origin is present.** A request carrying an
  `Origin` header must have it resolve to loopback on the session port;
  same-origin requests without the header pass, as browsers intend.
- **One deliberate exception.** `/__lucid/client.js`, the overlay bootstrap, is
  served as a public asset *before* the Host/Origin gate, with a CORS allow,
  because the sandboxed iframe fetches it from an opaque (null) origin and would
  otherwise be blocked. It is a static bundle with no session data. Every
  control route - the event log, POSTs, SSE - stays behind the gate and rejects
  null and cross-origin callers.
- **The artifact runs on an opaque origin.** It is served into an iframe with
  `sandbox="allow-scripts"` and no `allow-same-origin`, so artifact scripts get
  a null origin and cannot read the viewer, its routes, or its state. The
  artifact receives only the small overlay bundle; the React chrome never
  enters a document Lucid does not own.
- **Asset serving is scoped and enumerated.** Requests resolve inside the
  artifact's root and are re-checked after symlink resolution, so neither `..`
  nor a symlink escapes it. Dotfiles and dot-directories are denied, with a
  carve-out for `/.well-known/`. Non-document files must match an enumerated
  extension allowlist.

## Threat model, stated plainly

**Lucid renders agent-authored HTML locally, and HTML is code.** An artifact is
sandboxed against Lucid, not against you: it is still a web page running in your
browser. Treat an artifact from a source you do not trust exactly as you would
treat any HTML file from that source. Lucid's sandbox is not a substitute for
trusting whoever wrote the file.

The event log is a plain NDJSON file next to the artifact, readable by anything
that can read that directory. Do not put secrets in artifacts or annotations.

## Out of scope

- Anything that requires local access you already have. Lucid is a local tool
  with your permissions; an attacker who can run code as you, or write the
  artifact you open, has already won and needs no bug in Lucid.
- Denial of service against your own loopback server.
- Vulnerabilities in dependencies, unless Lucid's use of them is what creates
  the exposure. Report those upstream.

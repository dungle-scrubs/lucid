---
status: accepted
---

# Browser and agent content have separate authority

The browser uses a server-lifetime token; the more powerful attach secret stays
on the filesystem. Artifacts run outside lucid's origin, and frame messages
are validated. Attachments offered to an agent are copies outside the record,
so a context path does not reveal the record directory.

Revisit each boundary only with a concrete threat model and equivalent tests;
do not widen authority for convenience.


Artifact links may open unsandboxed tabs so external pages can work normally.
The artifact retains its opaque origin, without same-origin, top-navigation,
or form grants. HTTP(S) links use `_blank`, `noopener`, and `noreferrer`.
A destination cannot reach Lucid through an opener. The popup permission also
allows authored scripts to request a new window under the browser's popup
policy; artifacts already execute scripts and can send network requests.
No Lucid token or record secret is injected into the document. Native browser
verification covers a retained document after a section jump, a new external
tab with a null opener, and denial of parent-document access.

Agent link admission makes bounded, unauthenticated public-network requests.
DNS answers and every redirect are checked, then a direct socket connects to
one checked address. TLS retains hostname verification. Environment proxies
cannot substitute a destination; tests exercise this with a local proxy trap.
This prevents artifact links from turning the validator into a private-network
request tool. Static link checks do not certify script or resource behavior.

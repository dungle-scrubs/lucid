# Third-party notices

Lucid is distributed under the MIT License (see [LICENSE](LICENSE)). It also
carries third-party material that requires its own notices, reproduced below.

## Lucide icons

Lucid's chrome does not depend on an icon package. Per
[AGENTS.md](AGENTS.md), icons are copied inline as raw SVG path data from
[Lucide](https://lucide.dev). That copied path data is third-party material and
carries Lucide's license with it.

Icons in use, and the license each falls under:

| Icon | Where | License |
| --- | --- | --- |
| `crosshair` | `client/chrome/Header.tsx` | MIT (Feather-derived) and ISC |
| `chevron-down` | `client/chrome/Thread.tsx` | MIT (Feather-derived) and ISC |
| `loader-circle` | `client/chrome/Surface.tsx` | ISC (Lucide original) |

Lucide licenses its own icons under ISC. Icons inherited from
[Feather](https://github.com/feathericons/feather) remain under Feather's MIT
license; `crosshair` and `chevron-down` are both on that list, so both notices
apply to them.

Anyone adding an icon should check Lucide's
[LICENSE](https://github.com/lucide-icons/lucide/blob/main/LICENSE) for whether
it is on the Feather-derived MIT list, and add a row above.

### ISC License - Lucide

```
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### MIT License - Feather

```
MIT License

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Bundled runtime dependencies

`dist/lucid` is a single self-contained binary: the build compiles Lucid's
dependencies into it, so a distributed binary carries their code and their
notice requirements. The direct set, at the versions pinned in `bun.lock`:

| Dependency | License |
| --- | --- |
| `effect`, `@effect/cli`, `@effect/platform`, `@effect/platform-bun` | MIT |
| `react`, `react-dom` | MIT |
| `@assistant-ui/react` | MIT |
| `zustand` | MIT |
| `marked` | MIT |
| `lit` | BSD-3-Clause |
| `linkedom` | ISC |

BSD-3-Clause and ISC both require their copyright notice to travel with
redistributed code, which a compiled binary is.

**This repository distributes source, not the binary.** Anyone who builds
`dist/lucid` and then redistributes *that binary* takes on a heavier notice
obligation than this file currently satisfies, and must, before shipping it:

- Resolve the full transitive dependency set from `bun.lock` and reproduce each
  distinct license text, not just the direct set tabled above. Transitive
  packages carry their own terms.
- Include the **Bun runtime's** own license. `bun build --compile` embeds the
  Bun runtime into the executable, and it does not appear in `bun.lock`, so it
  will be missed by any tool that walks the lockfile alone.

Until a compiled binary is actually distributed (see the Roadmap in the README),
the obligations that bind this repository are the source-level ones: the Lucide
icon notices above, and the dependency licenses declared in `package.json`.

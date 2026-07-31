# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Releases from 0.1.0 onward are managed by
[release-please](https://github.com/googleapis/release-please) from Conventional
Commit messages.

## [0.3.0](https://github.com/dungle-scrubs/lucid/compare/v0.2.0...v0.3.0) (2026-07-31)


### Added

* **core:** a turn can end, and the viewer says what became of it ([#103](https://github.com/dungle-scrubs/lucid/issues/103)) ([6a7e7b9](https://github.com/dungle-scrubs/lucid/commit/6a7e7b973cfb23e37faa8225b7fdd5897c69aa5e))
* **core:** trace the CLI's write path, and delete a component nothing mounts ([#102](https://github.com/dungle-scrubs/lucid/issues/102)) ([b22cee3](https://github.com/dungle-scrubs/lucid/commit/b22cee3d2361b3c45b9c0690a5ef0a02b272866e))
* one folder per project, and a theme the artifact cannot fight ([#50](https://github.com/dungle-scrubs/lucid/issues/50)) ([4c3dd6d](https://github.com/dungle-scrubs/lucid/commit/4c3dd6d744d83848851c488b941b4dc54cdfe71b))
* one light/dark choice, applied to every open artifact ([#49](https://github.com/dungle-scrubs/lucid/issues/49)) ([4985f4e](https://github.com/dungle-scrubs/lucid/commit/4985f4e5e4f030090459ab420e0b6eecfbc72b78))
* presence-aware modes, an attend loop that actually answers, and a shell that cannot dead-end ([#45](https://github.com/dungle-scrubs/lucid/issues/45)) ([ba4d514](https://github.com/dungle-scrubs/lucid/commit/ba4d5147a103cca556fc794c6841908a7674cbbf))
* **shell:** tab context menu with rename, eyebrow-fit tab groups, suspend/resume healing ([#97](https://github.com/dungle-scrubs/lucid/issues/97)) ([0482a04](https://github.com/dungle-scrubs/lucid/commit/0482a047b7a577912cf3f953f823d0ba3d4f9efe))
* **test:** the catalogue stops being prose and starts failing the build ([#59](https://github.com/dungle-scrubs/lucid/issues/59)) ([c21b979](https://github.com/dungle-scrubs/lucid/commit/c21b979438af66619235ab55a4d0b49a1eb629af))
* **test:** the four capabilities everything else is blocked on ([#57](https://github.com/dungle-scrubs/lucid/issues/57)) ([bb917c6](https://github.com/dungle-scrubs/lucid/commit/bb917c602ce1401ce5dfc6b4c4c9d0740572a613))
* **viewer:** a sent annotation's mark is quiet until asked for ([#98](https://github.com/dungle-scrubs/lucid/issues/98)) ([d406cb1](https://github.com/dungle-scrubs/lucid/commit/d406cb1de00a8c77c6e112c8d54bfdec791f9744))
* **viewer:** decision points - Agree / Decline on a marked element ([#93](https://github.com/dungle-scrubs/lucid/issues/93)) ([27e7b98](https://github.com/dungle-scrubs/lucid/commit/27e7b9877943430a5303f1a5bee8fa5517a3acf8))


### Fixed

* ⌘R keeps your tabs, and a session never colonises your folder ([#52](https://github.com/dungle-scrubs/lucid/issues/52)) ([3bca9c0](https://github.com/dungle-scrubs/lucid/commit/3bca9c010320dd8654275330ae3db3268a8706bf))
* a .lucid/ artifact is never gitignored within a project ([#79](https://github.com/dungle-scrubs/lucid/issues/79)) ([94635b9](https://github.com/dungle-scrubs/lucid/commit/94635b9524b1c7d19741474e21772b011cb6c4f3))
* a human message is never refused because an agent is writing ([#47](https://github.com/dungle-scrubs/lucid/issues/47)) ([80faab5](https://github.com/dungle-scrubs/lucid/commit/80faab5d60d5bb73415a931e1bb3a3655620bbfb))
* **cli:** stdout is one JSON document, and a refusal exits non-zero ([#63](https://github.com/dungle-scrubs/lucid/issues/63)) ([d6b4a2b](https://github.com/dungle-scrubs/lucid/commit/d6b4a2bb9cc581d60cf9a29fb3972c85da63fb07))
* **core:** an ended session closes the working window, and two guards for what follows ([#101](https://github.com/dungle-scrubs/lucid/issues/101)) ([25ff3fa](https://github.com/dungle-scrubs/lucid/commit/25ff3fa59ccf6a7b43ebdbf9c71e78ac323af98f))
* **hooks:** the pre-commit formatter was staging nothing ([#60](https://github.com/dungle-scrubs/lucid/issues/60)) ([90fa511](https://github.com/dungle-scrubs/lucid/commit/90fa5118d6180caa763b1382bb8a45fe4911381c))
* **review:** one running turn, reported once ([#46](https://github.com/dungle-scrubs/lucid/issues/46)) ([0267c64](https://github.com/dungle-scrubs/lucid/commit/0267c64c2d13201cb35a920e23ab13baa0a39b21))
* **review:** reserve room for the badge that straddles a card's top edge ([#48](https://github.com/dungle-scrubs/lucid/issues/48)) ([42842f3](https://github.com/dungle-scrubs/lucid/commit/42842f386a4c8a04d77fe95d6210ce4e4725f3e2))
* **shell:** live channels over WebSockets, not SSE ([#99](https://github.com/dungle-scrubs/lucid/issues/99)) ([e1bf777](https://github.com/dungle-scrubs/lucid/commit/e1bf7773825aecf4bc1ef3a17b938bb5d864b4e6))
* **shell:** the pick list comes to rest on whole rows ([#51](https://github.com/dungle-scrubs/lucid/issues/51)) ([c9d7f86](https://github.com/dungle-scrubs/lucid/commit/c9d7f86ea47744febde222574507622b1719457f))
* **test:** stop the suite copying a signed binary, and contain the harness env ([#58](https://github.com/dungle-scrubs/lucid/issues/58)) ([43c8ed7](https://github.com/dungle-scrubs/lucid/commit/43c8ed7da70eb6163a5aedd519936e7631f2f3d3))
* **theme:** ask the artifact what it looks like, not what Lucid did to it ([#55](https://github.com/dungle-scrubs/lucid/issues/55)) ([617f7db](https://github.com/dungle-scrubs/lucid/commit/617f7db5ece95a19f7e23828b3cfeaf56c155252))
* **theme:** never force a dark form on an artifact that has none ([#53](https://github.com/dungle-scrubs/lucid/issues/53)) ([569d43c](https://github.com/dungle-scrubs/lucid/commit/569d43c03c6f997db6372aa81cae054f413348d8))


### Changed

* a feature wave bumps the minor while under 1.0 ([#44](https://github.com/dungle-scrubs/lucid/issues/44)) ([a89b0fd](https://github.com/dungle-scrubs/lucid/commit/a89b0fd6496c9c9711ff2e516da625d4cbd18aff))
* **deps-dev:** bump @playwright/test from 1.61.0 to 1.62.0 ([#96](https://github.com/dungle-scrubs/lucid/issues/96)) ([02a5ce2](https://github.com/dungle-scrubs/lucid/commit/02a5ce263da62a841a068d83f7447d596b7970d1))
* **deps:** bump @assistant-ui/react from 0.14.27 to 0.14.28 ([#94](https://github.com/dungle-scrubs/lucid/issues/94)) ([bb1e044](https://github.com/dungle-scrubs/lucid/commit/bb1e0444cd732836e77020c36e0c13bddf7317fc))
* **deps:** bump @assistant-ui/react-markdown to 0.14.7 ([#105](https://github.com/dungle-scrubs/lucid/issues/105)) ([2a95480](https://github.com/dungle-scrubs/lucid/commit/2a9548086cd4740d6e3c9e208f386c5b3b6607a3))
* **deps:** bump googleapis/release-please-action from 4 to 5 ([#30](https://github.com/dungle-scrubs/lucid/issues/30)) ([6848d70](https://github.com/dungle-scrubs/lucid/commit/6848d70a361c5a7e9d035bd82a1785596bd6720d))
* **e2e:** M4.1 - the 37 high-risk unblocked scenarios, seven of them fixes first ([#68](https://github.com/dungle-scrubs/lucid/issues/68)) ([0dd229b](https://github.com/dungle-scrubs/lucid/commit/0dd229bbe2d1a304465f29380a3a85a82cb9f3f5))
* **e2e:** M4.2 - suite Q, the hostile artifact corpus: six survivors, six recorded defects ([#69](https://github.com/dungle-scrubs/lucid/issues/69)) ([801d17a](https://github.com/dungle-scrubs/lucid/commit/801d17a6ad916ce800d497792b66d1a5ae58289e))
* **e2e:** M4.3 - seven cosmetic scenarios declined, one decline overturned in review ([#70](https://github.com/dungle-scrubs/lucid/issues/70)) ([fefd499](https://github.com/dungle-scrubs/lucid/commit/fefd4991af605e3d6a8554d5d8c30dd7bcb3d7f9))
* **e2e:** Phase 5 - the deferred-capability scenarios, and what they found ([#71](https://github.com/dungle-scrubs/lucid/issues/71)) ([3aee5cc](https://github.com/dungle-scrubs/lucid/commit/3aee5cc3e4747027f2a4dd2ad87b5b77778ca0c4))
* **e2e:** refuse to run against a bundle that is not this commit's ([#56](https://github.com/dungle-scrubs/lucid/issues/56)) ([867520e](https://github.com/dungle-scrubs/lucid/commit/867520ebf07af8da083fa2c7ba4eea860c0c0604))
* **e2e:** selectors come from locators.ts, and gates that hold on arrival ([#66](https://github.com/dungle-scrubs/lucid/issues/66)) ([509e7a1](https://github.com/dungle-scrubs/lucid/commit/509e7a13405139b8fba0959893214ba28c800561))
* name the evidence vocabulary, and hold artifacts to Orwell's rules ([#100](https://github.com/dungle-scrubs/lucid/issues/100)) ([edb4e05](https://github.com/dungle-scrubs/lucid/commit/edb4e05c9cb9247643c41b161711a366d1cf6f27))
* Phase 6 - re-rank and close the ledger ([#72](https://github.com/dungle-scrubs/lucid/issues/72)) ([87bc8ec](https://github.com/dungle-scrubs/lucid/commit/87bc8ec3e56f5ace327f39d81c92cd4ad476b430))
* preserve the plan record before plan 08 is deleted ([688432b](https://github.com/dungle-scrubs/lucid/commit/688432bd7ac30c80057fb1d10fb543ee403296c1))
* **regression:** close the gaps the M1.1 review found in its own tests ([#64](https://github.com/dungle-scrubs/lucid/issues/64)) ([ce77756](https://github.com/dungle-scrubs/lucid/commit/ce777563ad62b266cfe39408436d00663e726200))
* **regression:** one revert-verified test per shipped fix ([#62](https://github.com/dungle-scrubs/lucid/issues/62)) ([6b7a0cc](https://github.com/dungle-scrubs/lucid/commit/6b7a0cc49c7bdc7515eb02754edd0580570ef2f8))
* run Playwright where a green result means something ([#54](https://github.com/dungle-scrubs/lucid/issues/54)) ([8006c45](https://github.com/dungle-scrubs/lucid/commit/8006c45b2bcea92d12bfd60cfea3ab4514b07e3d))
* **test:** freeze the harness surface - modules, locators, fixtures ([#65](https://github.com/dungle-scrubs/lucid/issues/65)) ([df2cf56](https://github.com/dungle-scrubs/lucid/commit/df2cf569b19175f34626467de7aad97d6c63163e))
* the e2e suite runs on the Mac Lucid ships on, and nowhere else ([#61](https://github.com/dungle-scrubs/lucid/issues/61)) ([576b725](https://github.com/dungle-scrubs/lucid/commit/576b725d12b6087751b3391df6854b5f685b9c82))

## [0.2.0](https://github.com/dungle-scrubs/lucid/compare/v0.1.0...v0.2.0) (2026-07-26)


### Added

* collapse large composer pastes to a placeholder ([28a1563](https://github.com/dungle-scrubs/lucid/commit/28a1563ea12d474d935264626e97c866585bf132))
* context-window usage ring in the review header ([#27](https://github.com/dungle-scrubs/lucid/issues/27)) ([2e351f9](https://github.com/dungle-scrubs/lucid/commit/2e351f9835bc2b8a46a727b3023809d0119868b4))
* dark mode for the artifact document (prefers-color-scheme) ([#38](https://github.com/dungle-scrubs/lucid/issues/38)) ([1bfc9de](https://github.com/dungle-scrubs/lucid/commit/1bfc9de15428c439be3dead405092459c99e93ea))
* fold long human turns and annotation notes in the transcript ([11b65ff](https://github.com/dungle-scrubs/lucid/commit/11b65ff931ea41b6e9303d7f3c68a99d9bf73c48))
* forwarded question panel with rich answers ([#28](https://github.com/dungle-scrubs/lucid/issues/28)) ([74dbcad](https://github.com/dungle-scrubs/lucid/commit/74dbcadd49d03540e7d4790a12cb9dd86d98cf68))
* number question options and submit selections with Enter ([#37](https://github.com/dungle-scrubs/lucid/issues/37)) ([c72a94f](https://github.com/dungle-scrubs/lucid/commit/c72a94fba83c26e00dca7f5574803628dafa1b7d))
* readable questions - markdown, a clamp, and a re-ask button ([#40](https://github.com/dungle-scrubs/lucid/issues/40)) ([61a020f](https://github.com/dungle-scrubs/lucid/commit/61a020f5220b26d37999bdfc14e996ab8a71481d))
* self-reported fan-out progress indicator ([#26](https://github.com/dungle-scrubs/lucid/issues/26)) ([83e0aab](https://github.com/dungle-scrubs/lucid/commit/83e0aab076e49d413a5854b1621351fe4e3e5734))
* skip/decline a question ([#36](https://github.com/dungle-scrubs/lucid/issues/36)) ([0f5f236](https://github.com/dungle-scrubs/lucid/commit/0f5f236e909af36b372e1a43a53f14bb047038f5))
* the Lucid Shell and the artifact-first model ([#41](https://github.com/dungle-scrubs/lucid/issues/41)) ([c9f7e0d](https://github.com/dungle-scrubs/lucid/commit/c9f7e0dc46e36c9ea88022bac672bfa52bdc243b))


### Fixed

* a message can no longer vanish when the server is gone ([#35](https://github.com/dungle-scrubs/lucid/issues/35)) ([f107e28](https://github.com/dungle-scrubs/lucid/commit/f107e28f876ba32acb08623b62aebf1d38b85520))
* answered questions leave the "Questions for you" panel ([#29](https://github.com/dungle-scrubs/lucid/issues/29)) ([7c46d38](https://github.com/dungle-scrubs/lucid/commit/7c46d3815d41fdfc30214985de979fcf0d1d827a))
* clip horizontal overflow in the thread viewport ([a7c3e12](https://github.com/dungle-scrubs/lucid/commit/a7c3e123819a316058e3db9c386561165cb3b3d4))
* fall through to domPath when an anchor fingerprint is ambiguous ([#25](https://github.com/dungle-scrubs/lucid/issues/25)) ([9df5eae](https://github.com/dungle-scrubs/lucid/commit/9df5eaeb3e5e85149f04968acef6cf82cec41172))
* fork sends with a default directive when the note is empty ([#24](https://github.com/dungle-scrubs/lucid/issues/24)) ([a52aa58](https://github.com/dungle-scrubs/lucid/commit/a52aa586b44028b01bf9b3155e399f3ea67aae9c))
* keep the reopen-review path alive after approval ([41af772](https://github.com/dungle-scrubs/lucid/commit/41af772930c7744e637c5622ee3859c10487baaa))


### Changed

* add skillval eval cases beside both skills ([d986b86](https://github.com/dungle-scrubs/lucid/commit/d986b86b0ab9ae8fa38f3fda844ecef809a34433))
* **deps:** bump eight dependencies to their dependabot targets ([#42](https://github.com/dungle-scrubs/lucid/issues/42)) ([f1d5dd4](https://github.com/dungle-scrubs/lucid/commit/f1d5dd417125c067128b216a30dd0056385924bb))
* e2e for paste collapse, send expansion, and transcript folding ([a3d1f34](https://github.com/dungle-scrubs/lucid/commit/a3d1f346d44f58a4df13d712cf3a6fddd41d352a))
* release as 0.2.0 ([c746a3e](https://github.com/dungle-scrubs/lucid/commit/c746a3e902cdcf5a690e8e5830b18008d43c5b9b))
* set up release-please version automation ([#22](https://github.com/dungle-scrubs/lucid/issues/22)) ([77c2d8a](https://github.com/dungle-scrubs/lucid/commit/77c2d8ad81421ad6db824412981ee02ec9917c6e))
* **skills:** artifact diagrams are elements, never ASCII art ([#39](https://github.com/dungle-scrubs/lucid/issues/39)) ([c6df60d](https://github.com/dungle-scrubs/lucid/commit/c6df60d2557fa72e5a652c4d2b9ffd83f86db23c))

## [0.1.0] - 2026-07-18

Initial baseline release: `lucid` - an agent-agnostic CLI for addressable HTML
artifacts and located agent-human review, including the review viewer, the
`lucid wait` delivery loop, the planner bridge, and the fork feature (`Fork`
button, `lucid launch` launcher).

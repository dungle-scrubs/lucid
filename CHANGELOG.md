# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Releases from 0.1.0 onward are managed by
[release-please](https://github.com/googleapis/release-please) from Conventional
Commit messages.

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

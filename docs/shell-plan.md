# Lucid Shell — implementation plan

> One window over every session: collapse Lucid from N independent
> single-session servers (each its own browser tab/port) into a single shell —
> tabs, a `⌘K` command palette, every session across `~/dev`. This is a
> multi-phase architecture change on branch `feat/lucid-shell`.
>
> This document is the plain-text companion to `docs/shell-plan.html` (the
> reviewed, annotated artifact). The decisions below were settled via a grilled
> design review — treat them as locked, not open.

## The shape

One long-running **daemon** on `127.0.0.1:17428` (`HUB_PORT` in
`src/server/daemon.ts`) hosts every session in-process, keyed by canonical
artifact path, and serves the shell UI. The shell **is** the chrome — it swaps
the active session's review panel and artifact iframe. Session data is read and
written **in place**: the daemon opens, appends to, and watches each log where
it already lives (`<project>/.lucid/<name>/log.ndjson`), exactly as the
per-session server does today. No copy, no migration, no central database; only
a pointer registry (`~/.lucid/registry.json`) is central.

```
  install THIS as the Chrome app  ──────────────┐
                                                 ▼
  ┌──────────────────────────────────────────────────────┐
  │  Lucid daemon       one server · 127.0.0.1:17428      │
  │  shell: ⌘K   [ plan ][ sdlc-flow ][ support ]  + tab  │
  │  ┌────────────────────────────────────────────────┐  │
  │  │  active session: review panel + artifact iframe │  │
  │  └────────────────────────────────────────────────┘  │
  │  hosts every session in-process, keyed by path        │
  └──────────────────────────────────────────────────────┘
        │ reads + writes in place — data never leaves the project
        ▼
   ~/dev/proj-a/.lucid/plan/log.ndjson
   ~/dev/proj-b/.lucid/sdlc-flow/log.ndjson
   ~/.lucid/registry.json   (pointers + last-seen, not data)
```

## Locked decisions

1. **Server model B — one running server.** A single long-lived daemon on
   17428 hosts every session; it replaces the per-session process model over
   the phases. No per-session processes, no port rotation, one origin (so the
   cross-origin problem never arises). `lucid open` **registers** a session
   with the daemon instead of spawning one. Trade-off accepted: crash isolation
   (sessions share a process), so the daemon's own robustness matters more.
   Note: 17420 was the first pick but is reserved (`trevor-web`); use **17428**.
2. **Data stays in the project folders.** Under B only the server relocates;
   the artifact and its `.lucid/<name>/` stay in each project and the daemon
   reads/writes them in place. `~/.lucid/registry.json` holds **pointers +
   last-seen only**, never session data. The on-disk log stays the source of
   truth; the daemon is a cache over it.
3. **Unified multi-session chrome** (not an iframe host). The store becomes
   `sessionId -> { folded state, stream (SSE), highlights, drafts }` with one
   **active** session driving the render. Actions and the `EventSource` become
   session-scoped, not module-global singletons.
4. **Isolation is by path, nothing bleeds.** A session **is** its canonical
   artifact path. Cross-project: the path is the boundary, a project is just a
   grouping. CLI: every command names its file and addresses the daemon by that
   path — no ambient "current session". Lifecycle maps one-to-one with today:
   active (loaded, attended) · suspended (evicted from memory; reactivate =
   reload) · ended (`lucid end`) · dormant (on disk, surfaced by the `~/dev`
   scan). Under B "live" means "loaded in the daemon" rather than a bound port.
5. **One origin, still boxed per project.** Every artifact + asset route is
   namespaced by an opaque session id (`/s/<id>/…`), resolved against that
   session's own `artifactDir` with the existing `resolveAsset` confinement
   (traversal / dotfile / symlink-escape rejected). Never a shared filesystem
   root; no raw absolute paths in URLs.
6. **Agent interaction is unchanged; the CLI contract is frozen.** The
   consuming agent keeps the tiny per-file loop (`open → wait → ask → end`);
   multi-session is the human's shell only. `wait` tails the log directly
   (server-independent), so B is invisible to every harness. `open` surfaces a
   session as a new **tab** in the running shell, not a new browser window.
7. **Daemon lifecycle — self-managed, supervision out of scope.** First
   `lucid open` auto-starts the daemon if down; it stays up (does not idle-exit
   the way per-session servers do), while individual sessions evict from memory
   when idle. Service supervision (launchd/systemd) is deliberately kept **out
   of the codebase** — ship a plain long-lived process anyone can supervise.
8. **The daemon never spawns agents** (preserves D-064). Agent-spawning stays
   in the separate, opt-in fork launcher. A fork registers its child session
   with the daemon so it appears as a tab — spawning never migrates into the
   always-on server. *Amended by D15 (artifact-first):* "never **without
   explicit opt-in**". `lucid hub --attend` (or `LUCID_HUB_ATTEND=1`) runs the
   delivery engine (a headless turn per undelivered feedback batch when
   nothing is listening) and enables `POST /hub/create`. A hub started
   without it still spawns nothing.
9. **UI state — layout global, marks per-session.** Panel width and sidebar
   open/closed are one shell-level setting shared across tabs; the show-marks
   toggle is remembered per session, keyed by session id.
10. **Keyboard.** The in-session "Sessions" panel is subsumed by the tab bar +
    `⌘K` and goes away. Map: `⌘K` palette · `⌘1`–`⌘9` jump to tab N ·
    `⌘⇧[` / `⌘⇧]` prev/next tab · `⌘B` toggle panel · `⌘.` toggle marks ·
    `⌘⏎` send / approve.
11. **Command palette** uses `cmdk` (the headless engine behind shadcn's
    `Command`), styled to Lucid's own ink/brass tokens — this repo has its own
    design system, not shadcn.
12. **Per-session attention tags** in the tab list (new / waiting-on-you), so
    the list shows which review needs input without opening it.
13. **One entry URL** (`127.0.0.1:17428`) installed as a Chrome `--app` gives a
    permanent Dock icon that never goes stale on a rotating session port.

## Phase roadmap

- **Phase 0 — the daemon & registry.** SHIPPED (`b1d5af2`). Additive: stands
  up the daemon + pointer registry alongside the existing per-session
  servers. `src/core/registry.ts`, `src/server/daemon.ts`, `lucid hub`,
  best-effort register-on-`open`, tests. `wait`/`ask`/`end` untouched.
- **Phase 1 — session-keyed chrome.** SHIPPED (`2d286d8`). Every module-global
  singleton in the chrome client became a per-session instance behind a
  SessionHandle (store, actions, surface, pastes, transport, SSE stream), with
  a shell store for layout. No visible UX change; opus + codex reviewed.
- **Phase 2 — daemon hosting, tabs & multi-stream lifecycle.** SHIPPED
  (`9047cd8`). `session-host.ts` extracted from server.ts and mounted by the
  daemon under opaque `/s/<id>` routes (one origin); live dedicated servers
  are proxied, never double-hosted; descriptors carry `base` so the frozen
  CLI contract keeps working. Shell UI: tab bar with attention tags, `+`
  picker, cap-10 LRU stream eviction, `open` surfaces a tab (`?s=<id>`).
- **Phase 3 — `⌘K` command palette.** SHIPPED (`d08de5b`). `cmdk` fuzzy over
  every hub session plus the active review's actions and annotation jumps,
  styled to the shell's tokens.
- **Phase 4 — polish & the Dock app.** SHIPPED. `lucid app` ensures the hub
  (spawns it detached if down) and opens `127.0.0.1:17428` as a Chrome
  `--app` window; hub-reconnect indicator; focus routing on tab switch;
  keyboard map complete (⌘K · ⌘1–9 · ⌘⇧[ / ⌘⇧] · ⌘B · ⌘. · ⌘⏎ / ⌘⇧⏎).

Still open (deliberately deferred):

- `lucid open` does not yet auto-START the daemon when none is running
  (decision 7's end state) — it prefers a running hub and otherwise keeps the
  exact per-session behavior, so every existing harness flow is untouched
  until the shell has real mileage.
- Session ownership (dedicated server vs hub mount) is descriptor-based, not
  an atomic lease: a dedicated server publishing its descriptor in the same
  instant the hub mounts can briefly double-host. The append path itself
  stays serialized under the log lock, so the log cannot corrupt; the risk is
  duplicate watchers/broadcasts until one side idles out. An atomic ownership
  token shared by both server types is the fix when per-session servers are
  retired anyway.
- Root-relative asset URLs (`/logo.png`) inside an artifact break under a
  `/s/<id>` mount. Relative paths (already what self-contained artifacts use)
  work everywhere; the contract will be narrowed rather than rewriting HTML,
  CSS, and script-generated URLs.
- A hub-hosted session with an open browser tab never idle-evicts (the
  EventSource reconnect counts as activity, and a retry would lazily remount
  anyway). Accepted: an attended session staying hot is close to intent.

Note: the chrome adopted the SMUI "Spacemolt" theme (Nord frost) on Tailwind
v4 in `97d9bed`, replacing the ink/brass palette; the mark language on the
surface followed it.

## Risks — settled

- **Cross-origin** — resolved by model B (one origin, so it never arises).
- **Keyboard collision** — resolved by the map above (the Sessions panel goes
  away, freeing `⌘1`/`⌘2` for tabs).
- **N live SSE streams** — capped at 10 with LRU eviction; the log is untouched,
  so reopening refolds instantly.
- **Everything in one surface** — a risk with a recommendation, not an open
  question: per-tab confirm on destructive actions (Approve, End) and clear
  project labeling on every tab.

## Deferred (low, from the Phase 0 review)

- `registerSession` is an unlocked read-modify-write (concurrent `open`s can
  drop an update; self-heals via the `~/dev` scan for sessions under it).
- Registry-only sessions do not refresh `lastSeen` from log activity.

Both are acceptable for a pointer index at this phase.

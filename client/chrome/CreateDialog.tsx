import { useEffect, useMemo, useRef, useState } from "react";
import { hubFetch } from "./request.ts";
import {
  createRoots,
  createStatus,
  forgetCreate,
  noteCreateSubmitted,
  openTab,
  registerProject,
  setCreateOpen,
  useHub,
  type CreateTurnEntry,
} from "./hub.ts";
import { projectName } from "./naming.ts";
import { effortLadder, harnessInfoFor } from "./selection.ts";
import { handleize } from "../../src/core/title.ts";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";
import { closeButton } from "./ui/close.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

/**
 * Create from nothing (D3/D16): the shell mints a NEW artifact by asking the
 * hub to run the harness registry's spawn recipe with an author-this prompt.
 *
 * D16 is why this is a dialog and not a one-click action: project and harness
 * are offered every time, pre-filled from the current scope and the registry
 * default, so the common case is one keystroke and the exception never needs
 * a config edit.
 *
 * Nothing here spawns anything. The hub does, and only in attend mode - a
 * review-only hub answers 403, which this reports as the command that turns
 * it on rather than as a failure.
 */

/** Mirrors the hub's own CREATE_NAME (daemon.ts): a plain `.html` basename,
 *  never a path. Validated here so the human sees it while typing, not as a
 *  400 after submitting. */
const CREATE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.html$/;

/** Matches the hub's MAX_CREATE_PROMPT. */
/** How long to wait for the hub to accept a create before saying it did not.
 *  The route hands off to a detached process, so a healthy answer is fast. */
const CREATE_TIMEOUT_MS = 15_000;

const MAX_PROMPT = 4000;

/** How long the hub may go SILENT before the dialog says so (M2.1). Not a
 *  failure clock: a live turn heartbeats every 2s, so missing several in a row
 *  means the HUB stopped reporting - which is true and actionable - where the
 *  old two-minute "the turn may have failed" accused a healthy 8-minute turn
 *  of dying. A real failure still interrupts instantly via create-failed. */

const ATTEND_HINT =
  "This hub does not spawn agents. Start it with attend mode to author artifacts:";

const field =
  "w-full border border-ink-600 bg-bg-inset px-2 py-1.5 text-[13px] text-fg outline-none placeholder:text-fg-faint focus-visible:annot-outline";
const fieldLabel = "text-[10px] font-semibold uppercase tracking-[0.8px] text-fg-faint";
/** The vendored trigger's default is the header's version PILL, which reads as
 *  a different kind of control in a column of inputs: every Select in this
 *  dialog takes the shape of the text fields beside it. */
const selectField =
  "w-full justify-between border-ink-600 bg-bg-inset px-2 py-1.5 text-[13px] text-fg";
/** The id shown beside a label, and the registry default shown beside the
 *  "default" row: present, subordinate, never competing with the choice. */
const hint = "ml-2 text-[10px] text-fg-faint";

/** Module scope, not a closure: the effects below dismiss the dialog, and a
 *  per-render identity would make them re-subscribe on every keystroke. */
const close = (): void => setCreateOpen(false);

/** The root the last create actually used (D-005): the best default for the
 *  next one. Storage failures degrade to "no memory", never to an error. */
const CREATE_ROOT_KEY = "lucid.createRoot";
const readCreateRoot = (): string | null => {
  try {
    return localStorage.getItem(CREATE_ROOT_KEY);
  } catch {
    return null;
  }
};
const persistCreateRoot = (root: string): void => {
  try {
    localStorage.setItem(CREATE_ROOT_KEY, root);
  } catch {
    /* storage unavailable; the next dialog simply asks again */
  }
};

/** How a dead create turn ended, in one phrase: a number is the child's exit
 *  code, a string is Lucid's own reason for there being no code at all. */
const exitNote = (code: number | string): string =>
  typeof code === "number" ? `exit code ${code}` : code;

/**
 * Its own component so every open starts from a clean form: the parent mounts
 * it only while the dialog is showing, which is what resets the draft.
 */
const CreateDialogBody = () => {
  const sessions = useHub((s) => s.sessions);
  const attend = useHub((s) => s.attend);
  const harnesses = useHub((s) => s.harnesses);
  const defaultHarness = useHub((s) => s.defaultHarness);
  const harnessInfo = useHub((s) => s.harnessInfo);
  const createFailed = useHub((s) => s.createFailed);
  const createProgress = useHub((s) => s.createProgress);
  /** The page already knows whether the hub is reachable - the silence banner
   *  says which of the two things happened rather than asking. */
  const hubConnected = useHub((s) => s.connected);
  /** Projects named through the folder chooser this session. The hub only
   *  lists projects that already hold a session, so without these a brand new
   *  folder is unreachable until something else puts an artifact in it. */
  const [added, setAdded] = useState<readonly string[]>([]);
  /** The chooser is unavailable (not macOS, or it failed): take a path. */
  const [typing, setTyping] = useState(false);
  const [typedPath, setTypedPath] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  /**
   * Every folder a human can author into: the ones already holding a session,
   * the hub's own SCAN ROOTS, and anything named through this dialog's chooser.
   *
   * The scan roots were missing, and that was the whole of "I added a folder
   * and it did not become a project". Adding a folder registers it with the hub
   * so reviews inside it are listed; it did not make the folder somewhere you
   * could author INTO, so a brand new project stayed invisible here and the
   * question "what did that actually do?" had no good answer. One list, one
   * meaning: a folder you added is a project.
   */
  const hubRoots = useHub((s) => s.roots);
  const roots = useMemo(
    () => [...new Set([...createRoots(sessions), ...hubRoots, ...added])].sort(),
    [sessions, hubRoots, added],
  );

  /**
   * Name a project the listing does not know. The hub resolves it exactly as
   * it resolves a listed one, so a WORKTREE arrives as its main repo: pick
   * either checkout and the artifact lands under the same project.
   *
   * Thin adapter over registerProject (M4.3): the /hub/project contract lives
   * in the hub module; this holds only the form-state callbacks.
   */
  const addProject = async (path?: string): Promise<void> => {
    setAddError(null);
    const result = await registerProject(path);
    if (!result.ok) {
      if (result.reason === "cancelled") return;
      if (result.reason === "no-chooser") {
        setTyping(true); // no native chooser here: take a typed path instead
        return;
      }
      setAddError(
        result.reason === "no-answer" ? "The hub did not answer." : (result.error ?? `Refused.`),
      );
      return;
    }
    setAdded((prev) => [...new Set([...prev, result.target])]);
    setProject(result.target);
    setTyping(false);
    setTypedPath("");
  };

  const [project, setProject] = useState("");
  const [title, setTitle] = useState("");
  const [name, setName] = useState("");
  /** The human edited the filename directly, so the title stops driving it.
   *  Typing a title first and then correcting the filename is a deliberate
   *  divergence; retitling afterwards must not silently undo that. */
  const [nameOwned, setNameOwned] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [harness, setHarness] = useState("");
  /** "" = the "default" row: pass nothing and let the CLI decide. */
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  /** The artifact path the hub accepted, once it has: the dialog is now
   *  waiting for that session to appear rather than taking input. */
  const [authoring, setAuthoring] = useState<string | null>(null);
  /** This dialog's own turn's last heartbeat, never another's. */
  const progress = authoring === null ? undefined : createProgress[authoring];
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // Escape closes, from wherever focus is. On the window rather than the
  // dialog node: a modal's dismissal must not depend on which field is
  // focused, and a handler on a plain div is not a keyboard affordance.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Prefill the project with the MOST RECENTLY USED root (D-005) once the
  // listing is in - the human who authored into a project last time most
  // likely wants it again. Only while the field is untouched, so a later
  // listing frame cannot move a choice out from under them. A remembered root
  // the listing no longer offers is ignored. With nothing remembered: a SOLE
  // candidate is not a guess and is picked; several candidates mean the
  // dialog ASKS (the field stays unselected) rather than guessing one.
  useEffect(() => {
    setProject((current) => {
      if (current !== "") return current;
      const remembered = readCreateRoot();
      if (remembered !== null && roots.includes(remembered)) return remembered;
      return roots.length === 1 ? (roots[0] ?? "") : "";
    });
  }, [roots]);

  // Model/effort are spoken in the CHOSEN harness's vocabulary, so a harness
  // change invalidates both picks rather than carrying a value the new recipe
  // would refuse.
  const info = useMemo(
    () => harnessInfoFor(harnessInfo, harness, defaultHarness),
    [harnessInfo, harness, defaultHarness],
  );
  const models = info?.models ?? [];
  const ladder = effortLadder(info, model) ?? [];

  // The authored artifact surfaces as a listing row when the agent runs
  // `lucid open` on it (the hub's scan needs a log, so an empty session dir
  // never counts as arrival). The listing stream is already live here, so
  // this watches it rather than polling a second channel.
  useEffect(() => {
    if (authoring === null) return;
    const row = sessions.find((s) => s.artifact === authoring);
    if (!row) return;
    close();
    void openTab(row);
  }, [authoring, sessions]);

  // Re-armed by every heartbeat: while the hub reports, this never fires, so
  // the dialog cannot accuse a turn the hub says is running.
  const progressAt = progress?.at ?? null;

  // The clock ticks locally for smoothness but its ORIGIN is the hub's own
  // elapsed time, re-based by every heartbeat - so what the human reads is
  // the turn's real age, not this window's guess (a window opened late, or a
  // reconnected stream, would otherwise show its own shorter clock). The tick
  // reads the base through a ref so it cannot clobber the correction.
  const [now, setNow] = useState(() => Date.now());
  const base = useRef<{ at: number; elapsedMs: number }>({ at: Date.now(), elapsedMs: 0 });
  useEffect(() => {
    if (progress === undefined) return;
    base.current = { at: progress.at, elapsedMs: progress.elapsedMs };
  }, [progress]);
  useEffect(() => {
    if (authoring === null) return;
    base.current = { at: Date.now(), elapsedMs: 0 };
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [authoring]);
  const elapsed = Math.floor((base.current.elapsedMs + (now - base.current.at)) / 1000);

  // The lifecycle state is derived through createStatus (the tested pure
  // function), not re-derived inline with a timer. `silent` was a component
  // state driven by a setTimeout; it is now the `silent` arm of the union.
  const entry: CreateTurnEntry | null =
    authoring === null
      ? null
      : {
          artifact: authoring,
          submittedAt: progressAt ?? Date.now(),
          lastProgressAt: progressAt,
          lastProgressElapsedMs: progress?.elapsedMs ?? null,
          failure: createFailed?.artifact === authoring ? createFailed : null,
        };
  const status = entry === null ? null : createStatus(entry, now);

  const onTitle = (value: string): void => {
    setTitle(value);
    // The derived name carries its extension: this field is showing what the
    // file WILL be called, and a name without .html is not that. A title with
    // no usable characters derives nothing rather than a bare ".html".
    if (!nameOwned) {
      const handle = handleize(value);
      setName(handle === "" ? "" : `${handle}.html`);
    }
  };

  // Typing `some-test` means `some-test.html`: there is exactly one legal
  // extension, so demanding it typed was ceremony. A name with an explicit
  // extension is left alone (a wrong one still fails, visibly).
  const resolvedName = /\./.test(name.trim())
    ? name.trim()
    : name.trim().length > 0
      ? `${name.trim()}.html`
      : "";
  const nameOk = CREATE_NAME.test(resolvedName);
  const promptOk = prompt.trim().length > 0 && prompt.length <= MAX_PROMPT;
  // A known-inert hub is stated up front but never blocks the button: the
  // flag is a cached answer, and a hub restarted with --attend while this
  // window stayed open would otherwise be unreachable until a reload. The
  // 403 path says the same thing if the cache was right.
  const canSubmit = project !== "" && nameOk && promptOk && !sending;

  const pickHarness = (v: string): void => {
    setHarness(v);
    setModel("");
    setEffort("");
  };

  // A model change re-picks the ladder, so an effort the new model does not
  // accept goes back to default instead of reaching the hub as a 400.
  const pickModel = (v: string): void => {
    setModel(v);
    const next = effortLadder(info, v);
    setEffort((e) => (e !== "" && next?.includes(e) ? e : ""));
  };

  const submit = async (): Promise<void> => {
    setError(null);
    setSending(true);
    // A deadline, because the alternative is a button that says "Sending…"
    // forever. The hub answers this route in well under a second - it validates,
    // claims the name and hands the turn off to a detached process, so anything
    // approaching this budget means the request is not going to be answered at
    // all (the classic case: the hub was restarted under an open window, and the
    // page is posting down a socket to a process that no longer exists).
    const res = await hubFetch("/hub/create", {
      timeoutMs: CREATE_TIMEOUT_MS,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project,
        name: resolvedName,
        prompt,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(harness.trim() ? { harness: harness.trim() } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      }),
    }).catch(() => null);
    setSending(false);
    if (!res) {
      setError("The hub did not answer - it may have restarted. Reload the page and try again.");
      return;
    }
    const body = (await res.json().catch(() => null)) as {
      artifact?: unknown;
      error?: unknown;
    } | null;
    if (res.status === 403) {
      setError(ATTEND_HINT);
      return;
    }
    if (!res.ok) {
      setError(
        typeof body?.error === "string"
          ? body.error
          : `The hub refused the request (${res.status}).`,
      );
      return;
    }
    // The hub's own path, not one rebuilt here: it joined project and name,
    // and the listing row will carry exactly that string.
    persistCreateRoot(project); // the accepted root is the next dialog's default (D-005)
    // The hub always names the artifact on a 202; the fallback exists only so
    // this cannot be undefined, and it must match the hub's own spelling
    // (project/.lucid/<name>) because it is the key every heartbeat lands on.
    const started =
      typeof body?.artifact === "string" ? body.artifact : `${project}/.lucid/${resolvedName}`;
    // A turn BEGINS: forget this artifact's history before watching it. A
    // previous attempt's failure would otherwise render over a live turn, and
    // its last heartbeat would arm the silence detector at zero.
    useHub.setState((prev) => noteCreateSubmitted(forgetCreate(prev, started), started));
    setAuthoring(started);
  };

  return (
    // The Palette's overlay pattern: the backdrop is a real button (click-away
    // with a keyboard equivalent), and Escape is handled on the window above.
    <div
      data-test="create-overlay"
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]"
    >
      <button
        type="button"
        aria-label="Close the new-artifact dialog"
        onClick={close}
        className="absolute inset-0 cursor-default bg-ink-900/85 backdrop-blur-[2px]"
      />
      <div
        data-test="create-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="New artifact"
        className="relative flex w-[560px] max-w-[calc(100vw-48px)] flex-col gap-3 border border-ink-500 bg-ink-800 p-4 shadow-[0_18px_50px_rgba(0,0,0,0.6)]"
      >
        <div className="flex items-baseline justify-between">
          <span className="text-[13px] font-semibold text-fg-strong">New artifact</span>
          <button
            type="button"
            data-test="create-close"
            aria-label="Close the new-artifact dialog"
            onClick={close}
            className={closeButton}
          >
            ×
          </button>
        </div>

        {authoring === null ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (canSubmit) void submit();
            }}
          >
            {/* A div, not a label: the control is a Select (a button plus a
                popup), which a <label for> does not address - the trigger
                carries its own aria-label instead. */}
            <div className="flex flex-col gap-1">
              <span className={fieldLabel}>Project</span>
              <div className="flex items-center gap-1.5">
                {roots.length === 0 ? (
                  <span className="flex-1 text-[12px] text-fg-muted">
                    No project holds a session yet - choose a folder to put this in.
                  </span>
                ) : (
                  <Select value={project} onValueChange={(v) => setProject(v ?? "")}>
                    <SelectTrigger
                      data-test="create-project"
                      aria-label="Project"
                      className={`flex-1 ${selectField}`}
                    >
                      <SelectValue>{(v: string) => projectName(v)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {roots.map((r) => (
                        <SelectItem key={r} value={r}>
                          {projectName(r)}
                          <span className={hint}>{r}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {/* The listing only knows projects that already hold a
                    session; this is how a brand new folder becomes one. */}
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        data-test="create-add-project"
                        aria-label="Choose a project folder"
                        onClick={() => void addProject()}
                        className="flex size-7 shrink-0 cursor-pointer items-center justify-center border border-ink-600 bg-ink-800 text-fg-muted hover:border-accent-bright hover:text-fg focus-visible:annot-outline"
                      >
                        <svg
                          viewBox="0 0 24 24"
                          width="14"
                          height="14"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v3" />
                          <path d="M18 14v6" />
                          <path d="M15 17h6" />
                        </svg>
                      </button>
                    }
                  />
                  <TooltipContent>Choose a project folder</TooltipContent>
                </Tooltip>
              </div>
              {typing ? (
                <div className="flex items-center gap-1.5 pt-1">
                  <input
                    data-test="create-project-path"
                    value={typedPath}
                    onChange={(e) => setTypedPath(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void addProject(typedPath);
                      }
                    }}
                    placeholder="/Users/you/dev/project"
                    spellCheck={false}
                    className={`flex-1 ${field}`}
                  />
                  <button
                    type="button"
                    data-test="create-project-path-add"
                    onClick={() => void addProject(typedPath)}
                    className="cursor-pointer border border-ink-600 bg-ink-700 px-2 py-1.5 text-[11px] text-fg hover:bg-ink-600"
                  >
                    Add
                  </button>
                </div>
              ) : null}
              {addError !== null ? (
                <span data-test="create-project-error" className="text-[10px] text-rust-300">
                  {addError}
                </span>
              ) : null}
            </div>

            <label className="flex flex-col gap-1">
              <span className={fieldLabel}>Title</span>
              <input
                ref={nameRef}
                data-test="create-title"
                value={title}
                onChange={(e) => onTitle(e.target.value)}
                placeholder="Rollout plan for the billing service"
                className={field}
              />
              <span className="text-[10px] text-fg-faint">
                What the tab is called, and the document's own title.
              </span>
            </label>

            <label className="flex flex-col gap-1">
              <span className={fieldLabel}>Filename</span>
              <input
                data-test="create-name"
                value={name}
                onChange={(e) => {
                  setNameOwned(true);
                  setName(e.target.value);
                }}
                placeholder="rollout-plan.html"
                spellCheck={false}
                className={field}
              />
              {/* A bare word is validated as itself and given `.html` on the
                  way out - silently, because there is one legal extension and
                  echoing the name back is noise, not information. Only a name
                  that cannot be fixed says anything. */}
              {name.length > 0 && !nameOk ? (
                <span data-test="create-name-error" className="text-[10px] text-rust-300">
                  Letters, digits, dot, dash, underscore - no directories.
                </span>
              ) : null}
            </label>

            <label className="flex flex-col gap-1">
              <span className={fieldLabel}>What should it be?</span>
              <textarea
                data-test="create-prompt"
                rows={4}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="A rollout plan for the new billing service: phases, owners, and the rollback for each."
                className={`${field} resize-y`}
              />
            </label>

            <div className="flex flex-col gap-1">
              <span className={fieldLabel}>Harness</span>
              {harnesses.length > 0 ? (
                // The registry's own names, offered: DEFAULT is a real row
                // (empty value - the hub resolves it), so the common case is
                // no interaction and the exception is one pick, never typing.
                <Select value={harness} onValueChange={(v) => pickHarness(v ?? "")}>
                  <SelectTrigger
                    data-test="create-harness"
                    aria-label="Harness"
                    className={selectField}
                  >
                    <SelectValue>
                      {(v: string) =>
                        v === "" ? `default${defaultHarness ? ` (${defaultHarness})` : ""}` : v
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">
                      default
                      {defaultHarness ? <span className={hint}>{defaultHarness}</span> : null}
                    </SelectItem>
                    {harnesses.map((h) => (
                      <SelectItem key={h} value={h}>
                        {h}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                // No registry known (an older hub, or none on disk): the raw
                // field stays as the escape hatch rather than a dead end.
                <input
                  data-test="create-harness"
                  value={harness}
                  onChange={(e) => pickHarness(e.target.value)}
                  placeholder="the harness registry's default"
                  spellCheck={false}
                  className={field}
                />
              )}
            </div>

            {/* Model and effort are the chosen harness's own vocabularies, so
                they sit under it - and a recipe that declares neither shows
                nothing at all, because a picker whose only row is "default" is
                furniture. */}
            {models.length > 0 || ladder.length > 0 ? (
              <div className="flex gap-3">
                {models.length > 0 ? (
                  <div className="flex flex-1 flex-col gap-1">
                    <span className={fieldLabel}>Model</span>
                    <Select value={model} onValueChange={(v) => pickModel(v ?? "")}>
                      <SelectTrigger
                        data-test="create-model"
                        aria-label="Model"
                        className={selectField}
                      >
                        <SelectValue>
                          {(v: string) =>
                            v === ""
                              ? `default${info?.defaultModel ? ` (${info.defaultModel})` : ""}`
                              : (models.find((m) => m.id === v)?.label ?? v)
                          }
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {/* Default is a real row that sends NOTHING: the CLI's
                            own choice, named here so it is visible. */}
                        <SelectItem value="">
                          default
                          {info?.defaultModel ? (
                            <span className={hint}>{info.defaultModel}</span>
                          ) : null}
                        </SelectItem>
                        {models.map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            {m.label ?? m.id}
                            {m.label ? <span className={hint}>{m.id}</span> : null}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}

                {ladder.length > 0 ? (
                  <div className="flex flex-1 flex-col gap-1">
                    <span className={fieldLabel}>Effort</span>
                    <Select value={effort} onValueChange={(v) => setEffort(v ?? "")}>
                      <SelectTrigger
                        data-test="create-effort"
                        aria-label="Effort"
                        className={selectField}
                      >
                        <SelectValue>
                          {(v: string) =>
                            v === ""
                              ? `default${info?.defaultEffort ? ` (${info.defaultEffort})` : ""}`
                              : v
                          }
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">
                          default
                          {info?.defaultEffort ? (
                            <span className={hint}>{info.defaultEffort}</span>
                          ) : null}
                        </SelectItem>
                        {ladder.map((e) => (
                          <SelectItem key={e} value={e}>
                            {e}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
              </div>
            ) : null}

            {attend === false ? (
              <div data-test="create-attend-hint" className="flex flex-col gap-1">
                <span className="text-[11px] text-fg-muted">{ATTEND_HINT}</span>
                <code className="self-start bg-ink-700 px-1.5 py-px text-[11px] text-fg">
                  lucid hub --attend
                </code>
              </div>
            ) : null}

            {error !== null ? (
              <div data-test="create-error" className="flex flex-col gap-1">
                <span className="text-[11px] text-rust-300">{error}</span>
                {error === ATTEND_HINT ? (
                  <code className="self-start bg-ink-700 px-1.5 py-px text-[11px] text-fg">
                    lucid hub --attend
                  </code>
                ) : null}
              </div>
            ) : null}

            <div className="flex items-center justify-end gap-2">
              {/* A dead button with no stated reason is the same complaint the
                  question drawer's answer-blocked line answers. */}
              {!canSubmit && !sending ? (
                <span data-test="create-blocked" className="text-[10px] text-fg-faint">
                  {project === ""
                    ? "Pick a project"
                    : name.trim() === ""
                      ? "Name the file"
                      : !nameOk
                        ? "Fix the filename"
                        : "Say what it should be"}
                </span>
              ) : null}
              <button
                type="submit"
                data-test="create-submit"
                disabled={!canSubmit}
                className="cursor-pointer border border-ink-600 bg-ink-700 px-2.5 py-[3px] text-[11px] font-semibold uppercase tracking-[0.05em] text-fg hover:bg-ink-600 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {sending ? "Sending…" : "Author it"}
              </button>
            </div>
          </form>
        ) : (
          // Quiet by design: authoring is a whole agent turn, and there is
          // nothing to do but wait. The tab opens itself the moment the
          // session appears in the listing.
          <div data-test="create-authoring" className="flex flex-col gap-1 py-2">
            {createFailed?.artifact === authoring ? (
              <>
                <span className="text-[13px] text-rust-300">
                  {createFailed.usageLimit
                    ? `The ${harness.trim() || defaultHarness || "default"} harness is over its usage limit - it cannot author anything right now.`
                    : createFailed.authFailure
                      ? `The ${harness.trim() || defaultHarness || "default"} harness could not authenticate.`
                      : // How the turn died, in the terms the log speaks: an
                        // exit code to grep the harness's own docs for, or
                        // `spawn-error` when nothing ever ran - which is a
                        // different problem (a recipe naming a binary that is
                        // not there) than a turn that started and failed.
                        `The authoring turn failed before it produced ${name} (${exitNote(createFailed.code)}).`}
                </span>
                {createFailed.usageLimit ? (
                  <span data-test="create-usage-limit" className="text-[11px] text-amber-300">
                    Pick a different harness and try again.
                  </span>
                ) : null}
                {/* The non-obvious half, and the whole reason this branch
                    exists: the human IS logged in, so the raw error sends them
                    to re-check a login that was never the problem. The hub runs
                    detached from any login session and cannot read the macOS
                    Keychain, and no amount of logging in again changes that. */}
                {createFailed.authFailure ? (
                  <span data-test="create-auth-failure" className="text-[11px] text-amber-300">
                    Being logged in here is not enough: the hub runs detached and cannot read
                    Keychain credentials. Give it an env token instead - run{" "}
                    <code className="bg-ink-700 px-1">claude setup-token</code> once, then start the
                    hub with <code className="bg-ink-700 px-1">CLAUDE_CODE_OAUTH_TOKEN</code> set.
                    See <code className="bg-ink-700 px-1">docs/LAUNCHER.md</code>.
                  </span>
                ) : null}
                <span className="text-[11px] text-fg-faint">{authoring}</span>
                {/* The harness's own last words: a usage limit, a missing
                    binary - the reason is almost always right here. */}
                <pre
                  data-test="create-failed-tail"
                  className="mt-1 overflow-x-auto border border-ink-500 bg-ink-700 p-2 font-mono text-[11px] leading-snug text-fg"
                >
                  {createFailed.tail || "(the log is empty)"}
                </pre>
                <span className="text-[11px] text-fg-muted">
                  Full log:{" "}
                  <code className="bg-ink-700 px-1">
                    .lucid/{name.replace(/\.html$/, "")}/create.out.log
                  </code>
                </span>
              </>
            ) : (
              <>
                <span className="shimmer text-[13px] text-fg/40">
                  authoring {name}… {Math.floor(elapsed / 60)}:
                  {String(elapsed % 60).padStart(2, "0")}
                </span>
                {/* The turn's own phase one-liner, when it narrates - the same
                    `lucid progress --label` channel the revise indicator reads. */}
                {progress?.label ? (
                  <span data-test="create-phase" className="text-[11px] text-fg-muted">
                    {progress.label}
                  </span>
                ) : null}
                <span className="text-[11px] text-fg-faint">{authoring}</span>
                {status === "silent" ? null : (
                  <span className="pt-1 text-[11px] text-fg-faint">
                    {progressAt !== null
                      ? "The hub is reporting this turn as running. A few minutes is normal; a failure interrupts this on its own."
                      : "Waiting for the hub's first report. A few minutes is normal; a failure interrupts this on its own."}
                  </span>
                )}
                {/* The log pointer belongs in the RUNNING state too, not only
                    after a failure or a silence (07#16). runSpawn awaits the
                    child with no timeout, so a wedged-but-alive harness
                    heartbeats forever and this state is truthful and permanent
                    - and the one actionable thing, the log, used to appear
                    only in the branches this turn never reaches. A pointer,
                    not a clock: nothing here infers failure from elapsed
                    time. */}
                {status === "silent" ? null : (
                  <span data-test="create-running-log" className="text-[11px] text-fg-faint">
                    Watch it work:{" "}
                    <code className="bg-ink-700 px-1">
                      .lucid/{name.replace(/\.html$/, "")}/create.out.log
                    </code>
                  </span>
                )}
              </>
            )}
            {status === "silent" && createFailed?.artifact !== authoring ? (
              <span data-test="create-silent" className="pt-1 text-[11px] text-fg-muted">
                {hubConnected
                  ? "The hub has stopped reporting on this turn. That does not mean it failed - it means this window is no longer being told. "
                  : "This window has lost its connection to the hub, so it is no longer being told anything about this turn. That does not mean it failed. "}
                Check{" "}
                <code className="bg-ink-700 px-1">
                  .lucid/{name.replace(/\.html$/, "")}/create.out.log
                </code>{" "}
                in the project. This dialog can be closed; the tab still appears on its own if the
                artifact lands.
              </span>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
};

export const CreateDialog = () => {
  const open = useHub((s) => s.createOpen);
  if (!open) return null;
  return <CreateDialogBody />;
};

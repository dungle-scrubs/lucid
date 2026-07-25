import { useEffect, useMemo, useRef, useState } from "react";
import { createRoots, openTab, projectName, setCreateOpen, useHub } from "./hub.ts";
import { effortLadder, harnessInfoFor } from "./selection.ts";
import { useShell } from "./shell.ts";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";
import { closeButton } from "./ui/close.ts";

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
const MAX_PROMPT = 4000;

/** How long to wait for the authored artifact to surface as a session before
 *  saying so. Authoring is a whole agent turn - minutes is normal, silence
 *  past this is not. */
const AUTHOR_TIMEOUT_MS = 120_000;

const ATTEND_HINT =
  "This hub does not spawn agents. Start it with attend mode to author artifacts:";

const field =
  "w-full rounded-md border border-ink-600 bg-bg-inset px-2 py-1.5 text-[13px] text-fg outline-none placeholder:text-fg-faint focus-visible:annot-outline";
const fieldLabel = "text-[10px] font-semibold uppercase tracking-[0.8px] text-fg-faint";
/** The vendored trigger's default is the header's version PILL, which reads as
 *  a different kind of control in a column of inputs: every Select in this
 *  dialog takes the shape of the text fields beside it. */
const selectField =
  "w-full justify-between rounded-md border-ink-600 bg-bg-inset px-2 py-1.5 text-[13px] text-fg";
/** The id shown beside a label, and the registry default shown beside the
 *  "default" row: present, subordinate, never competing with the choice. */
const hint = "ml-2 text-[10px] text-fg-faint";

/** Module scope, not a closure: the effects below dismiss the dialog, and a
 *  per-render identity would make them re-subscribe on every keystroke. */
const close = (): void => setCreateOpen(false);

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
  const activeProject = useShell((s) => s.activeProject);
  const roots = useMemo(() => createRoots(sessions), [sessions]);

  const [project, setProject] = useState("");
  const [name, setName] = useState("");
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
  const [timedOut, setTimedOut] = useState(false);
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

  // Prefill the project from the current scope once the listing is in. Only
  // while the field is untouched, so a later listing frame cannot move a
  // choice out from under the human.
  useEffect(() => {
    setProject((current) => {
      if (current !== "") return current;
      if (activeProject !== null && roots.includes(activeProject)) return activeProject;
      return roots[0] ?? "";
    });
  }, [roots, activeProject]);

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

  useEffect(() => {
    if (authoring === null) return;
    const timer = setTimeout(() => setTimedOut(true), AUTHOR_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [authoring]);

  // A headless turn prints NOTHING until it finishes, so the log stays empty
  // and the dialog has no evidence of life to show. The clock is that
  // evidence: a failure now arrives on its own (create-failed), so a running
  // clock means the turn is still going, not that anything is wedged.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (authoring === null) return;
    setElapsed(0);
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [authoring]);

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
    const res = await fetch("/hub/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project,
        name: resolvedName,
        prompt,
        ...(harness.trim() ? { harness: harness.trim() } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      }),
    }).catch(() => null);
    setSending(false);
    if (!res) {
      setError("The hub did not answer. Is it still running?");
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
    setAuthoring(typeof body?.artifact === "string" ? body.artifact : `${project}/${name}`);
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
              {roots.length === 0 ? (
                <span className="text-[12px] text-fg-muted">
                  The hub only knows projects that already hold a session, so there is nowhere to
                  put this yet.
                </span>
              ) : (
                <Select value={project} onValueChange={(v) => setProject(v ?? "")}>
                  <SelectTrigger
                    data-test="create-project"
                    aria-label="Project"
                    className={selectField}
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
            </div>

            <label className="flex flex-col gap-1">
              <span className={fieldLabel}>Filename</span>
              <input
                ref={nameRef}
                data-test="create-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="rollout-plan.html"
                spellCheck={false}
                className={field}
              />
              {name.length > 0 && !nameOk ? (
                <span data-test="create-name-error" className="text-[10px] text-rust-300">
                  A plain .html filename - letters, digits, dot, dash, underscore. No directories.
                </span>
              ) : nameOk && resolvedName !== name.trim() ? (
                <span data-test="create-name-resolved" className="text-[10px] text-fg-faint">
                  {resolvedName}
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

            <div className="flex justify-end">
              <button
                type="submit"
                data-test="create-submit"
                disabled={!canSubmit}
                className="cursor-pointer rounded-md border border-ink-600 bg-ink-700 px-2.5 py-[3px] text-[11px] font-semibold uppercase tracking-[0.05em] text-fg hover:bg-ink-600 disabled:cursor-not-allowed disabled:opacity-40"
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
                    : `The authoring turn failed before it produced ${name}.`}
                </span>
                {createFailed.usageLimit ? (
                  <span data-test="create-usage-limit" className="text-[11px] text-amber-300">
                    {createFailed.usageLimit} Pick a different harness and try again.
                  </span>
                ) : null}
                <span className="text-[11px] text-fg-faint">{authoring}</span>
                {/* The harness's own last words: a usage limit, a missing
                    binary - the reason is almost always right here. */}
                <pre
                  data-test="create-failed-tail"
                  className="mt-1 overflow-x-auto rounded border border-ink-500 bg-ink-700 p-2 font-mono text-[11px] leading-snug text-fg"
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
                <span className="text-[11px] text-fg-faint">{authoring}</span>
                <span className="pt-1 text-[11px] text-fg-faint">
                  A headless turn prints nothing until it finishes, so there is no progress to show.
                  A few minutes is normal; a failure interrupts this on its own.
                </span>
              </>
            )}
            {timedOut && createFailed?.artifact !== authoring ? (
              <span data-test="create-timeout" className="pt-1 text-[11px] text-fg-muted">
                Still nothing after two minutes. The turn may have failed - check{" "}
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

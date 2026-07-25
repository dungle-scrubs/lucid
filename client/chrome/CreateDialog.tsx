import { useEffect, useMemo, useRef, useState } from "react";
import { createRoots, openTab, projectName, setCreateOpen, useHub } from "./hub.ts";
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
  const createFailed = useHub((s) => s.createFailed);
  const activeProject = useShell((s) => s.activeProject);
  const roots = useMemo(() => createRoots(sessions), [sessions]);

  const [project, setProject] = useState("");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [harness, setHarness] = useState("");
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
              <span className="text-[10px] font-semibold uppercase tracking-[0.8px] text-fg-faint">
                Project
              </span>
              {roots.length === 0 ? (
                <span className="text-[12px] text-fg-muted">
                  The hub only knows projects that already hold a session, so there is nowhere to
                  put this yet.
                </span>
              ) : (
                <Select value={project} onValueChange={(v) => setProject(v ?? "")}>
                  {/* Overridden to the shape of the text fields beside it:
                      the vendored trigger's default is the header's version
                      PILL, which reads as a different kind of control in a
                      column of inputs. */}
                  <SelectTrigger
                    data-test="create-project"
                    aria-label="Project"
                    className="w-full justify-between rounded-md border-ink-600 bg-bg-inset px-2 py-1.5 text-[13px] text-fg"
                  >
                    <SelectValue>{(v: string) => projectName(v)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {roots.map((r) => (
                      <SelectItem key={r} value={r}>
                        {projectName(r)}
                        <span className="ml-2 text-[10px] text-fg-faint">{r}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-[0.8px] text-fg-faint">
                Filename
              </span>
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
              <span className="text-[10px] font-semibold uppercase tracking-[0.8px] text-fg-faint">
                What should it be?
              </span>
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
              <span className="text-[10px] font-semibold uppercase tracking-[0.8px] text-fg-faint">
                Harness
              </span>
              {harnesses.length > 0 ? (
                // The registry's own names, offered: DEFAULT is a real row
                // (empty value - the hub resolves it), so the common case is
                // no interaction and the exception is one pick, never typing.
                <Select value={harness} onValueChange={(v) => setHarness(v ?? "")}>
                  <SelectTrigger
                    data-test="create-harness"
                    aria-label="Harness"
                    className="w-full justify-between rounded-md border-ink-600 bg-bg-inset px-2 py-1.5 text-[13px] text-fg"
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
                      {defaultHarness ? (
                        <span className="ml-2 text-[10px] text-fg-faint">{defaultHarness}</span>
                      ) : null}
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
                  onChange={(e) => setHarness(e.target.value)}
                  placeholder="the harness registry's default"
                  spellCheck={false}
                  className={field}
                />
              )}
            </div>

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
                <span className="shimmer text-[13px] text-fg/40">authoring {name}…</span>
                <span className="text-[11px] text-fg-faint">{authoring}</span>
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

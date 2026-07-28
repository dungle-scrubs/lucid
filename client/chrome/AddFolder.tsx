import { useState } from "react";
import { addRoot } from "./hub.ts";
import { projectName } from "./naming.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

/**
 * "Add a folder" - the one control that makes an empty shell correctable.
 *
 * The hub scans `~/dev` by default, which is a GUESS: an agent that writes its
 * artifact to a scratchpad, or a checkout living anywhere else, leaves the
 * listing empty with nothing on screen to do about it. This names a folder,
 * the hub scans it for `<folder>/**​/.lucid/<stem>/log.ndjson`, and whatever
 * was already in there joins the listing - past reviews included.
 *
 * It reports what the folder HELD, because the question a human actually has
 * after picking is "was that the right folder", which "added" does not answer.
 */
export const AddFolder = ({
  className,
  label = "Add a project",
  icon = false,
  onAdded,
}: {
  readonly className?: string;
  readonly label?: string;
  /** Render as a folder+ icon (the projects drawer header) rather than a text
   *  button. The icon goes straight to the OS chooser: no path field until
   *  something actually needs one. */
  readonly icon?: boolean;
  /** Ran after a folder is added - the drawer closes itself on its way out. */
  readonly onAdded?: () => void;
}) => {
  /** The chooser is unavailable (not macOS, or it failed): take a path. */
  const [typing, setTyping] = useState(false);
  const [typedPath, setTypedPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const add = async (path?: string): Promise<void> => {
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const outcome = await addRoot(path);
      if ("cancelled" in outcome) return;
      if ("needsPath" in outcome) {
        setTyping(true);
        return;
      }
      if ("error" in outcome) {
        setError(outcome.error);
        return;
      }
      const { root, found } = outcome.added;
      // 0 found is the confusing case, and silence about WHY was the whole
      // problem: a project folder holds no reviews because agents write
      // artifacts into their own scratchpad, which Lucid already scans. Say
      // that, rather than leaving the human to conclude their work is lost.
      setResult(
        found === 0
          ? `Watching ${projectName(root)}, but no reviews are stored in it. Agents usually write artifacts to their session scratchpad - those are already listed here, under the project they were about.`
          : `Found ${found} ${found === 1 ? "review" : "reviews"} in ${projectName(root)}.`,
      );
      setTyping(false);
      setTypedPath("");
      onAdded?.();
    } finally {
      setBusy(false);
    }
  };

  const trigger = icon ? (
    <button
      type="button"
      data-test="add-folder"
      aria-label="Add a project folder"
      disabled={busy}
      onClick={(e) => {
        e.currentTarget.blur();
        void add();
      }}
      className="inline-flex flex-none cursor-pointer items-center border border-ink-500 p-[2px] text-fg-faint hover:border-accent-bright hover:text-fg disabled:cursor-default disabled:opacity-50"
    >
      {/* Lucide folder-plus */}
      <svg
        viewBox="0 0 24 24"
        width="13"
        height="13"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M4 20a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2Z" />
        <path d="M12 10v6M9 13h6" />
      </svg>
    </button>
  ) : (
    <button
      type="button"
      data-test="add-folder"
      disabled={busy}
      onClick={(e) => {
        e.currentTarget.blur();
        void add();
      }}
      className={className}
    >
      {label}
    </button>
  );

  return (
    // No alignment of its own: this sits in a centred pick screen and in a
    // left-aligned drawer, and a component that centres its own status text
    // under a left-aligned button is what read as broken.
    <div className={`flex max-w-[440px] flex-col gap-1.5 ${icon ? "" : ""}`}>
      <span className="flex items-baseline gap-2">
        <Tooltip>
          <TooltipTrigger render={trigger} />
          <TooltipContent>
            {icon
              ? "Add a project folder - opens a chooser (⌘⇧G in it for a hidden path)"
              : "Point Lucid at a folder and it lists the sessions already inside it"}
          </TooltipContent>
        </Tooltip>
        {/* Not a fallback for a missing chooser - a first-class route. The
            artifacts a human is usually hunting for sit under an agent's
            scratchpad in /private/tmp, which macOS HIDES in the native
            chooser; pasting the path is the only practical way there. */}
        {typing || icon ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  data-test="add-folder-type"
                  onClick={(e) => {
                    e.currentTarget.blur();
                    setTyping(true);
                  }}
                  className="cursor-pointer text-[10px] text-fg-faint underline-offset-2 hover:text-fg hover:underline"
                >
                  paste a path
                </button>
              }
            />
            <TooltipContent>Type or paste a folder path</TooltipContent>
          </Tooltip>
        )}
      </span>
      {typing ? (
        <div className="flex items-center gap-1.5">
          <input
            data-test="add-folder-path"
            value={typedPath}
            onChange={(e) => setTypedPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void add(typedPath);
              }
            }}
            placeholder="/Users/you/dev/project"
            spellCheck={false}
            className="w-[280px] border border-ink-600 bg-bg-inset px-2 py-1 text-[12px] text-fg outline-none placeholder:text-fg-faint focus-visible:annot-outline"
          />
          <button
            type="button"
            data-test="add-folder-path-add"
            disabled={busy}
            onClick={() => void add(typedPath)}
            className="cursor-pointer border border-ink-600 bg-ink-700 px-2 py-1 text-[11px] text-fg hover:bg-ink-600"
          >
            Add
          </button>
        </div>
      ) : null}
      {error !== null ? (
        <span data-test="add-folder-error" className="text-[10px] text-rust-300">
          {error}
        </span>
      ) : null}
      {result !== null ? (
        <span data-test="add-folder-result" className="text-[10px] leading-relaxed text-fg-faint">
          {result}
        </span>
      ) : null}
    </div>
  );
};

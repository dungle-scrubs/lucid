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
   *  button. Both go straight to the OS chooser. */
  readonly icon?: boolean;
  /** Ran after a folder is added - the drawer closes itself on its way out. */
  readonly onAdded?: () => void;
}) => {
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
        // The chooser is macOS-only. Nothing to fall back to now that the path
        // field is gone, so say so rather than failing silently.
        setError("This build has no folder chooser on this platform.");
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
    //
    // `relative` with the status hung BELOW it (see the absolute block at the
    // end): the outcome text runs to a couple of lines, and in the flow it grew
    // this control to 440px inside a one-line row - shoving "New artifact" to
    // the far edge and leaving the row looking broken the moment a folder was
    // picked. Out of flow, the row keeps its shape and the message still lands
    // directly under the button that produced it.
    <div className="relative flex flex-col">
      <span className="flex items-baseline gap-2">
        <Tooltip>
          <TooltipTrigger render={trigger} />
          <TooltipContent>
            {icon
              ? "Add a project folder - opens a chooser (⌘⇧G in it for a hidden path)"
              : "Point Lucid at a folder and it lists the sessions already inside it"}
          </TooltipContent>
        </Tooltip>
      </span>
      {error !== null || result !== null ? (
        <span className="absolute left-0 top-full z-10 mt-1 w-[320px] text-left">
          {error !== null ? (
            <span data-test="add-folder-error" className="block text-[10px] text-rust-300">
              {error}
            </span>
          ) : null}
          {result !== null ? (
            <span
              data-test="add-folder-result"
              className="block text-[10px] leading-relaxed text-fg-faint"
            >
              {result}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
};

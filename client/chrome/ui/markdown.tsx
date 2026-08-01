import { useEffect, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useActions, useSession } from "../context.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip.tsx";

/**
 * The one Markdown treatment the chrome speaks in: the transcript's agent turns
 * and the question panel render the same shapes the same way, because both are
 * agent-authored prose read in the same 380px column.
 */

/** A `lucid:section/<id>` link is an in-artifact permalink: the agent stamps a
 *  `data-lucid-id` on a new section and links to it, so the reader jumps there
 *  once without hunting. Ephemeral by design - it's a live chip only while the
 *  overlay still reports that id, and degrades to plain text the moment a later
 *  version drops it (no dead links left in the log). */
const SECTION_SCHEME = "lucid:section/";

/** react-markdown's default sanitizer strips unknown protocols, which would
 *  blank our `lucid:` hrefs; allow that one scheme through and sanitize the
 *  rest exactly as before (no javascript:, no data:). */
export const urlTransform = (url: string): string =>
  url.startsWith(SECTION_SCHEME) ? url : defaultUrlTransform(url);

/** Lucide `locate-fixed` - "find this in the artifact". */
const LocateGlyph = () => (
  <svg
    viewBox="0 0 24 24"
    width="11"
    height="11"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <line x1="2" x2="5" y1="12" y2="12" />
    <line x1="19" x2="22" y1="12" y2="12" />
    <line x1="12" x2="12" y1="2" y2="5" />
    <line x1="12" x2="12" y1="19" y2="22" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

/** Section permalinks scroll the artifact; every other agent-authored link
 *  opens away from the viewer and never navigates it. */
const MarkdownLink = ({
  href,
  children,
}: {
  readonly href?: string;
  readonly children?: ReactNode;
}) => {
  const { pulseSection, revealSection } = useActions();
  const sectionIds = useSession((s) => s.sectionIds);
  const sectionId = href?.startsWith(SECTION_SCHEME) ? href.slice(SECTION_SCHEME.length) : null;
  const addedInViewport = useSession((s) =>
    sectionId === null ? false : s.addedSectionVisibility[sectionId] === true,
  );

  useEffect(() => {
    if (sectionId !== null && addedInViewport) pulseSection(sectionId);
  }, [addedInViewport, pulseSection, sectionId]);

  if (sectionId !== null) {
    // Live while the id set is unknown (optimistic, pre-first-report) or holds
    // it; a dead permalink becomes plain text, not a chip that goes nowhere.
    const live = sectionIds === null || sectionIds.includes(sectionId);
    if (!live) return <span>{children}</span>;
    // The update is already under the reader's eyes. Plain prose plus the
    // surface pulse communicates it without offering a jump that goes nowhere.
    if (addedInViewport) return <span>{children}</span>;
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-test="section-link"
              onClick={() => revealSection(sectionId)}
              className="mx-px inline-flex items-center gap-1 border border-accent/40 bg-accent/10 px-1.5 align-baseline text-[0.9em] font-medium text-accent hover:bg-accent/20"
            >
              <LocateGlyph />
              {children}
            </button>
          }
        />
        <TooltipContent>Scroll the artifact to this section</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
    >
      {children}
    </a>
  );
};

/** Markdown images never load. Agent-authored `![](url)` would auto-fetch an
 *  arbitrary URL - a tracking pixel, or a GET at a loopback dev service the
 *  viewer sits beside. Real attachments arrive as Image parts (Thumb), not
 *  markdown, so nothing is lost by showing the reference as inert text. */
const MarkdownImage = ({ alt }: { readonly alt?: string }) => (
  <span className="text-fg-faint italic">{alt ? `[image: ${alt}]` : "[image]"}</span>
);

export const markdownComponents = { a: MarkdownLink, img: MarkdownImage } as const;

/**
 * A "prose-lite" for the panel: descendant utilities so one class carries
 * the whole document, sized down to the panel and pinned to the kit's tokens.
 * Block spacing lives on the container (`*+*`) so first children never inherit
 * a stray top margin. Fenced code gets a card LIGHTER than its surroundings (code must lift off the page, not sink into it); inline code a chip, with
 * the chip styling neutralised inside a fence so a block does not double up.
 */
export const prose = [
  "min-w-0 max-w-full text-fg leading-[1.45] [&>*+*]:mt-2 break-words",
  "[&_strong]:font-semibold [&_strong]:text-fg-strong [&_em]:italic",
  "[&_code]: [&_code]:bg-ink-700 [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[0.92em]",
  "[&_pre]:overflow-x-auto [&_pre]: [&_pre]:border [&_pre]:border-ink-500 [&_pre]:bg-ink-700 [&_pre]:p-2.5 [&_pre]:font-mono [&_pre]:text-[12px] [&_pre]:leading-[1.5]",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[1em]",
  "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:mt-0.5 [&_li]:marker:text-fg-faint",
  "[&_:is(h1,h2,h3,h4)]:mt-3 [&_:is(h1,h2,h3,h4)]:text-[13px] [&_:is(h1,h2,h3,h4)]:font-semibold [&_:is(h1,h2,h3,h4)]:text-fg-strong",
  "[&_blockquote]:border-l-2 [&_blockquote]:border-ink-500 [&_blockquote]:pl-3 [&_blockquote]:text-fg-muted [&_blockquote]:italic",
  "[&_hr]:my-3 [&_hr]:border-ink-600",
  "[&_table]:block [&_table]:overflow-x-auto [&_table]:border-collapse [&_table]:text-[12px] [&_:is(th,td)]:border [&_:is(th,td)]:border-ink-600 [&_:is(th,td)]:px-2 [&_:is(th,td)]:py-1 [&_th]:text-left [&_th]:font-semibold",
].join(" ");

/**
 * Agent-authored Markdown that arrives as a plain string rather than as a
 * message part (a question's text). The transcript renders through
 * assistant-ui's primitive instead, but both land on `prose` and the same
 * link/image components, so a fenced command looks identical either way.
 */
export const Markdown = ({ text }: { readonly text: string }) => (
  <div className={prose}>
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={urlTransform}
      components={markdownComponents}
    >
      {text}
    </ReactMarkdown>
  </div>
);

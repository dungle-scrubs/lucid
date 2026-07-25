import { useState } from "react";
import { useActions, useSession, useSessionHandle } from "./context.tsx";
import type { SessionSummary } from "./types.ts";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "./ui/sidebar.tsx";

/**
 * The project's other reviews. Every session is its own server on its own port,
 * so switching is a navigation between viewers rather than one server swapping
 * artifacts - which is why each session keeps its own origin, its own stream
 * and its own log appender.
 *
 * A dormant session has no viewer to navigate to. Rather than pretend, this
 * lists what it would take to bring it back: the `lucid open` that revives it,
 * and - when the last agent recorded one - the command that puts that
 * conversation back behind it. Both are copied for a terminal, never run from
 * here: the review surface reports, it does not execute.
 */

/** Copy-to-clipboard, the only action this panel offers for a dormant session. */
const CopyButton = ({
  cmd,
  label,
  test,
}: {
  readonly cmd: string;
  readonly label: string;
  readonly test: string;
}) => {
  const { notify } = useSessionHandle();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      data-test={test}
      title={cmd}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(cmd).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          },
          () => notify.warn("Couldn't copy - the command is in this button's tooltip."),
        );
      }}
      className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] text-fg-faint hover:bg-sidebar-accent hover:text-fg"
    >
      {copied ? (
        // lucide check
        <svg
          viewBox="0 0 24 24"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="shrink-0 text-agent"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : (
        // lucide copy
        <svg
          viewBox="0 0 24 24"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="shrink-0"
        >
          <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
        </svg>
      )}
      <span className="truncate">{copied ? "copied - paste it in a terminal" : label}</span>
    </button>
  );
};

const StatusDot = ({ s }: { readonly s: SessionSummary }) => (
  <span
    aria-hidden="true"
    className={`size-1.5 shrink-0 rounded-full ${
      s.live ? "bg-agent" : s.status === "ended" ? "bg-steel-600" : "bg-brass-600"
    }`}
  />
);

const SessionRow = ({ s, current }: { readonly s: SessionSummary; readonly current: boolean }) => {
  const { switchToSession } = useActions();
  return (
    <SidebarMenuItem data-test="session-row" data-live={s.live ? "true" : "false"}>
      <SidebarMenuButton
        isActive={current}
        disabled={current || !s.live}
        title={s.session}
        onClick={() => switchToSession(s)}
        className={s.live && !current ? "cursor-pointer" : "cursor-default"}
      >
        <StatusDot s={s} />
        <span className="truncate">{s.name}</span>
      </SidebarMenuButton>
      <SidebarMenuBadge>v{s.version}</SidebarMenuBadge>
      <div className="pb-1 pl-2 text-[11px] text-fg-faint">
        {current
          ? "you are here"
          : s.live
            ? `${s.annotations} annotation${s.annotations === 1 ? "" : "s"}`
            : s.status === "ended"
              ? "ended"
              : "dormant"}
      </div>
      {/* A dormant session cannot be opened from the browser - there is no server
        to answer. The way back is a terminal, so hand over the exact command. */}
      {!s.live && s.status !== "ended" && s.resume ? (
        <CopyButton cmd={s.resume} label="copy the command to reopen it" test="session-open-copy" />
      ) : null}
      {!current && s.lastAttendant?.resume ? (
        <CopyButton
          cmd={s.lastAttendant.resume}
          label={`copy the command to resume the ${s.lastAttendant.harness} conversation`}
          test="session-resume-copy"
        />
      ) : null}
    </SidebarMenuItem>
  );
};

export const Sessions = () => {
  const { loadSessions } = useActions();
  const sessions = useSession((s) => s.sessions);
  const loading = useSession((s) => s.sessionsLoading);
  const current = useSession((s) => s.session);

  if (loading && sessions === null) {
    return <div className="p-3 text-[12px] italic text-fg-faint">Looking for sessions…</div>;
  }
  if (sessions !== null && sessions.length === 0) {
    return (
      <div className="p-3 text-[12px] italic text-fg-faint">
        No other Lucid sessions in this project.
      </div>
    );
  }

  return (
    <SidebarGroup data-test="sessions-list">
      <SidebarGroupLabel className="justify-between">
        <span>This project</span>
        <button
          type="button"
          data-test="sessions-refresh"
          title="Refresh"
          onClick={() => void loadSessions()}
          className="cursor-pointer rounded p-0.5 text-fg-faint hover:text-fg"
        >
          {/* lucide refresh-cw */}
          <svg
            viewBox="0 0 24 24"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className={loading ? "animate-spin" : ""}
          >
            <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
            <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
            <path d="M8 16H3v5" />
          </svg>
        </button>
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {(sessions ?? []).map((s) => (
            <SessionRow key={s.session} s={s} current={s.session === current} />
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
};

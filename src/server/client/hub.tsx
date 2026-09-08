import {
  focusManager,
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
} from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ConversationPage, ListedConversation } from "../../protocol/conversations.js";
import { TOKEN_HEADER } from "../constants.js";
import { ConversationRename } from "./conversation-rename.js";
import { NewConversation, PENDING_CREATION } from "./new-conversation.js";
import { Button } from "./ui/button.js";

class SessionExpired extends Error {}

focusManager.setEventListener((notify) => {
  const refresh = () => notify();
  window.addEventListener("focus", refresh);
  window.addEventListener("visibilitychange", refresh);
  return () => {
    window.removeEventListener("focus", refresh);
    window.removeEventListener("visibilitychange", refresh);
  };
});

const queries = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 0, refetchOnWindowFocus: "always" } },
});

async function apiFetch(path: string, body?: string, signal?: AbortSignal): Promise<Response> {
  const token = await queries.fetchQuery({
    queryKey: ["session"],
    staleTime: Infinity,
    queryFn: async () => {
      const response = await fetch("/api/session");
      if (!response.ok) throw new Error("Cannot connect to Lucid. Refresh to try again.");
      return ((await response.json()) as { token: string }).token;
    },
  });
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { [TOKEN_HEADER]: token, "content-type": "application/json" },
    ...(body === undefined ? {} : { body }),
    signal,
  });
  if (response.status === 401) throw new SessionExpired("Lucid restarted. Reload to reconnect.");
  return response;
}
async function fetchPage(cursor: string | null, signal: AbortSignal): Promise<ConversationPage> {
  const response = await apiFetch(
    `conversations?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    undefined,
    signal,
  );
  if (!response.ok)
    throw new Error(
      "Conversations are unavailable. Check the configured record folder, then refresh.",
    );
  return (await response.json()) as ConversationPage;
}

const folderName = (path: string): string => path.split("/").filter(Boolean).at(-1) ?? path;

function Project({
  path,
  items,
}: {
  readonly path: string | null;
  readonly items: readonly ListedConversation[];
}) {
  return (
    <details className="hub-group" open>
      <summary>
        <span>{path === null ? "No project" : folderName(path)}</span>
        <span className="hub-count">{items.length}</span>
        {path === null ? null : <span className="hub-path">{path}</span>}
      </summary>
      <ul>
        {items.map((item) => (
          <li key={item.conversationId} className="hub-item">
            <a className="hub-row" href={`/c/${encodeURIComponent(item.conversationId)}`}>
              <span className="hub-title">{item.title}</span>
              <span className="hub-context">
                {item.workingDirectoryStatus === "missing"
                  ? "Working folder missing"
                  : path !== null && item.workingDirectory && item.workingDirectory !== path
                    ? item.workingDirectory
                    : item.conversationId}
              </span>
            </a>
            <ConversationRename item={item} request={apiFetch} />
          </li>
        ))}
      </ul>
    </details>
  );
}

function Hub() {
  const [creating, setCreating] = useState(() => sessionStorage.getItem(PENDING_CREATION) !== null);
  const [search, setSearch] = useState("");
  const query = useInfiniteQuery({
    queryKey: ["conversations"],
    queryFn: ({ pageParam, signal }) => fetchPage(pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: (query) => !(query.state.error instanceof SessionExpired),
    refetchInterval: (query) => (query.state.error instanceof SessionExpired ? false : 5000),
  });
  const records = new Map<string, ListedConversation>();
  const errors = new Map<string, string>();
  for (const page of query.data?.pages ?? []) {
    for (const item of page.conversations) records.set(item.conversationId, item);
    for (const issue of page.errors)
      errors.set(
        `${issue.conversationId}:${issue.message}`,
        `${issue.conversationId ? `${issue.conversationId}: ` : ""}${issue.message}`,
      );
  }
  const groups = new Map<string | null, ListedConversation[]>();
  const needle = search.trim().toLocaleLowerCase();
  for (const item of records.values()) {
    if (
      !`${item.title} ${item.conversationId} ${item.projectDirectory ?? "No project"} ${item.workingDirectory ?? ""}`
        .toLocaleLowerCase()
        .includes(needle)
    )
      continue;
    const group = groups.get(item.projectDirectory) ?? [];
    group.push(item);
    groups.set(item.projectDirectory, group);
  }
  const projects = [...groups].sort(([a], [b]) =>
    a === null ? 1 : b === null ? -1 : a.localeCompare(b),
  );
  return (
    <>
      <header className="hub-header">
        <a href="/" aria-label="Lucid hub" className="hub-logo">
          <span aria-hidden="true">.</span>lucid
        </a>
        <h1>Documents</h1>
        <Button variant="outline" onClick={() => setCreating(!creating)}>
          {creating ? "Close" : "+ New"}
        </Button>
        <Button
          variant="ghost"
          onClick={() =>
            query.error instanceof SessionExpired ? window.location.reload() : void query.refetch()
          }
          disabled={query.isFetching}
        >
          {query.error instanceof SessionExpired ? "Reload" : "Refresh"}
        </Button>
      </header>
      <main className="hub-main">
        {creating ? <NewConversation request={apiFetch} /> : null}
        <label className="hub-search">
          <span className="sr-only">
            {query.hasNextPage ? "Search loaded conversations" : "Search conversations"}
          </span>
          <input
            data-slot="input"
            type="search"
            placeholder={
              query.hasNextPage ? "Search loaded conversations…" : "Search conversations…"
            }
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        {query.error ? (
          <p role="alert" className="hub-error">
            {query.error.message}
          </p>
        ) : null}
        {errors.size > 0 ? (
          <aside className="hub-errors" aria-label="Discovery errors">
            <p>Some records need attention.</p>
            {(query.data?.pages[0]?.errorCount ?? 0) > errors.size ? (
              <p>
                Showing {errors.size} of {query.data?.pages[0]?.errorCount} record errors.
              </p>
            ) : null}
            <ul>
              {[...errors].map(([key, message]) => (
                <li key={key}>{message}</li>
              ))}
            </ul>
          </aside>
        ) : null}
        {query.isPending ? <p role="status">Loading conversations…</p> : null}
        {projects.map(([path, items]) => (
          <Project key={path ?? ""} path={path} items={items} />
        ))}
        {!query.isPending && !query.error && groups.size === 0 ? (
          <p className="hub-empty">
            {search
              ? "No matching conversations."
              : errors.size > 0
                ? "No readable conversations."
                : "No conversations yet. Conversations started in the terminal appear here."}
          </p>
        ) : null}
        {query.hasNextPage ? (
          <Button
            variant="outline"
            onClick={() => void query.fetchNextPage({ cancelRefetch: false })}
            disabled={query.isFetching}
          >
            {query.isFetchingNextPage ? "Loading…" : "Load more conversations"}
          </Button>
        ) : null}
        <footer className="hub-footer">
          <span>
            {records.size} conversations{query.hasNextPage ? " loaded" : ""}
          </span>
          <span>Grouped by repository or starting folder</span>
        </footer>
      </main>
    </>
  );
}

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queries}>
      <Hub />
    </QueryClientProvider>,
  );

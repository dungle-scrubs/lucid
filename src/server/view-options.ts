import { formatRoute } from "./client/route.js";

export type ConversationPanelVisibility = "open" | "closed";
export const CONVERSATION_PANEL_QUERY = "conversation-panel";

export const conversationViewUrl = (
  baseUrl: string,
  conversationId: string,
  visibility?: ConversationPanelVisibility,
): string => {
  const url = new URL(formatRoute({ conversationId }), baseUrl);
  if (visibility !== undefined) url.searchParams.set(CONVERSATION_PANEL_QUERY, visibility);
  return url.href;
};

export const initialConversationPanel = (search: string): boolean => {
  const values = new URLSearchParams(search).getAll(CONVERSATION_PANEL_QUERY);
  return values.length === 1 && values[0] === "open";
};

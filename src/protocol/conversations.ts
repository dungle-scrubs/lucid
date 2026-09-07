export interface ConversationSummary {
  readonly conversationId: string;
  readonly conversationTitle?: string;
  readonly titleRevision?: number;
  readonly titleOrigin?: "fallback" | "generated" | "manual";
  readonly projectDirectory: string | null;
  readonly workingDirectory: string | null;
  readonly workingDirectoryStatus: "available" | "missing" | "unknown";
}

export interface DiscoveryIssue {
  readonly code: "E-HUB-01";
  readonly reason: "ambiguous" | "unreadable" | "invalid-folders";
  readonly conversationId: string | null;
  readonly message: string;
}

export interface ListedConversation extends Omit<ConversationSummary, "conversationTitle"> {
  readonly title: string;
}

export interface ConversationPage {
  readonly conversations: readonly ListedConversation[];
  readonly errors: readonly DiscoveryIssue[];
  readonly nextCursor: string | null;
  readonly errorCount: number;
}

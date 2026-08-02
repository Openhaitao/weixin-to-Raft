/**
 * Agent interface — any AI backend that can handle a chat message.
 *
 * Implement this interface to connect WeChat to your own AI service.
 * The WeChat bridge calls `chat()` for each inbound message and sends
 * the returned response back to the user.
 */

export interface Agent {
  /** Process a single message and return a reply. */
  chat(request: ChatRequest): Promise<ChatResponse>;
  /** Optional fast preflight for whether this inbound message should show a typing indicator. */
  shouldShowTyping?(request: ChatRequest): Promise<boolean> | boolean;
  /** Clear/reset the session for a given conversation. */
  clearSession?(conversationId: string): void;
  /** Return the authoritative model menu for this agent. */
  getModelMenu?(conversationId: string): Promise<AgentModelMenu>;
  /** Validate and persist a bot-wide model selection. */
  selectModel?(conversationId: string, modelId: string): Promise<AgentModelSelection>;
}

export interface AgentModelOption {
  id: string;
  name: string;
  description?: string;
}

export interface AgentModelMenu {
  currentModelId?: string;
  options: AgentModelOption[];
}

export interface AgentModelSelection {
  modelId: string;
  name: string;
}

export interface ChatRequest {
  /** Conversation / user identifier. Use this to maintain per-user context. */
  conversationId: string;
  /** Text content of the message. */
  text: string;
  /** Channel timing markers for live cold-start diagnosis. */
  timing?: {
    /** Time when the SDK started processing this inbound message. */
    receivedAt?: number;
  };
  /**
   * First attached media file. LEGACY, kept so existing agents keep working —
   * new consumers should read `normalizeChatMedia(request)` instead, which
   * always yields the full ordered list. When a message carries several
   * attachments this is `mediaItems[0]`.
   */
  media?: MediaAttachment;
  /**
   * All attachments carried by this ONE inbound message, in their original
   * order. A WeChat message can pack several (two photos, an image plus a
   * PDF); before 2026-08-02 only the first was processed and the rest were
   * silently dropped.
   */
  mediaItems?: MediaAttachment[];
}

export interface MediaAttachment {
  type: "image" | "audio" | "video" | "file";
  /** Local file path (already downloaded and decrypted). */
  filePath: string;
  /** MIME type, e.g. "image/jpeg", "audio/wav". */
  mimeType: string;
  /** Original filename (available for file attachments). */
  fileName?: string;
}

/**
 * THE way to read attachments. Prefers the canonical plural field and falls
 * back to the legacy singular one, so no consumer has to write that branch
 * (and none can accidentally process the first item twice).
 */
export function normalizeChatMedia(
  request: Pick<ChatRequest, "media" | "mediaItems">,
): MediaAttachment[] {
  if (request.mediaItems?.length) return request.mediaItems;
  return request.media ? [request.media] : [];
}

export interface ChatResponse {
  /** Reply text (may contain markdown — will be converted to plain text before sending). */
  text?: string;
  /** Reply media file. */
  media?: {
    type: "image" | "video" | "file";
    /** Local file path or HTTPS URL. */
    url: string;
    /** Filename hint (for file attachments). */
    fileName?: string;
  };
}

/**
 * Agent interface — any AI backend that can handle a chat message.
 *
 * Implement this interface to connect WeChat to your own AI service.
 * The WeChat bridge calls `chat()` for each inbound message and sends
 * the returned response back to the user.
 */

export interface Agent {
  /**
   * Called after a turn's reply is confirmed sent, with the earlier messages
   * whose material that turn consumed. Until this runs the material is still
   * held, so a failed send can be retried with it intact.
   */
  confirmConsumed?(conversationId: string, deliveryIds: string[]): void | Promise<void>;

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
  /**
   * Ledger identity of the message that produced this request, when it has
   * one. Carried so an effect that OUTLIVES the request (material stashed for
   * a later command) can be committed durably at the moment it becomes durable.
   */
  deliveryId?: string;

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
  /**
   * Deliberate silence: the turn was handled and no reply is owed (material
   * stashed for a later command). Distinct from an empty response, which means
   * the agent failed to produce anything and the user IS owed an explanation.
   */
  silent?: boolean;

  /**
   * Earlier messages whose effect this turn just made durable — stashed
   * material that has now been consumed and answered. They may be committed
   * only once this turn's reply is confirmed sent.
   */
  consumedDeliveryIds?: string[];

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

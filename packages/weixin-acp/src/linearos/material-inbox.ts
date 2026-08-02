import path from "node:path";

import type { ChatRequest } from "weixin-agent-sdk";
import { MAX_MEDIA_ITEMS, normalizeChatMedia } from "weixin-agent-sdk";

type Media = NonNullable<ChatRequest["media"]>;

const MATERIAL_TTL_MS = 30 * 60 * 1000;
/** The inbox accumulates across MESSAGES for up to 30 minutes, so its ceiling
 * is a multiple of the per-message intake cap rather than a second literal.
 * Everything stashed must stay reachable in the merged block — an inbox that
 * silently shows only its first N items is the same vanishing-attachment bug
 * one layer up. */
const MATERIAL_LIST_MAX = MAX_MEDIA_ITEMS * 4;
const MATERIAL_LINK_RE = /\/(minutes|docx|docs|doc|sheets|sheet|base|bitable|wiki|file|wenjian)\/|minute_token|obj_token/i;
const URL_RE = /(?:https?:\/\/|www\.)\S+/i;

interface MaterialItem {
  text?: string;
  media?: Media;
  ts: number;
}

interface MaterialBox {
  conversationId: string;
  items: MaterialItem[];
  ts: number;
  /** Oldest materials evicted by the box ceiling. Surfaced in the merged block
   * so a truncated set is never presented as if it were complete. */
  dropped?: number;
}

function cleanText(text: string): string {
  return String(text || "").trim();
}

function isMaterialMedia(media: ChatRequest["media"]): media is Media {
  return Boolean(media && (media.type === "image" || media.type === "file" || media.type === "video"));
}

export function isMaterialInboxCancelText(text: string): boolean {
  const s = cleanText(text).replace(/[\s。！？!?，,.;；：:]+/g, "").toLowerCase();
  return /^(取消|算了|不用了|不需要了|先不用|先不用了|别处理了|不要处理|谢谢|多谢|感谢|thanks|thankyou|thx|换个话题|说另一个|聊别的|newtopic|forgetit|cancel|stop)$/i.test(s);
}

export function isBareMaterialRequest(request: ChatRequest): boolean {
  const text = cleanText(request.text);
  // Any attachment in the message counts, not just the first: an audio note
  // followed by a photo in the same message was misclassified when this only
  // looked at `request.media`.
  if (normalizeChatMedia(request).some(isMaterialMedia)) return !text;
  if (!text) return false;
  if (!MATERIAL_LINK_RE.test(text) && !URL_RE.test(text)) return false;
  const withoutUrls = text
    .replace(/(?:https?:\/\/|www\.)\S+/gi, "")
    .replace(/(?:minute_token|obj_token)\s*[:=]\s*[A-Za-z0-9_-]+/gi, "")
    .replace(/[\s,，。.;；:：!！?？()[\]（）【】"'“”‘’<>《》]+/g, "")
    .trim();
  return !withoutUrls;
}

function materialMediaLine(media: Media, index: number): string {
  const name = media.fileName?.trim() || path.basename(media.filePath);
  return [
    `${index}. ${name || media.type}`,
    `type=${media.type}`,
    `mime=${media.mimeType || "unknown"}`,
    `local_path=${media.filePath}`,
  ].join(" · ");
}

function materialTextBlock(items: MaterialItem[], triggerText: string, dropped = 0): string {
  const lines: string[] = [];
  // The box is already bounded at stash time, so everything held is listed —
  // showing a subset here would recreate the vanishing-attachment bug.
  items.forEach((item, i) => {
    if (item.text) {
      lines.push(`${i + 1}. ${item.text.replace(/\s+/g, " ").slice(0, 2000)}`);
    } else if (item.media) {
      lines.push(materialMediaLine(item.media, i + 1));
    }
  });
  return [
    cleanText(triggerText),
    "",
    "【Material Inbox / 刚才用户单独发送的材料】",
    `用户刚才连续发送了 ${items.length} 个材料，系统已静默缓存，没有单独回复。现在这句话才是触发意图。`,
    ...(dropped > 0
      ? [`注意：更早的 ${dropped} 个材料因超出缓存上限已丢弃，不要假设它们的内容。`]
      : []),
    "材料清单：",
    ...(lines.length ? lines : ["（材料已缓存）"]),
  ].join("\n").trim();
}

export class MaterialInbox {
  private boxes = new Map<string, MaterialBox>();

  has(conversationId: string): boolean {
    const box = this.boxes.get(conversationId);
    if (!box) return false;
    if (Date.now() - box.ts > MATERIAL_TTL_MS) {
      this.boxes.delete(conversationId);
      return false;
    }
    return box.items.length > 0;
  }

  stash(request: ChatRequest): void {
    const now = Date.now();
    const prev = this.boxes.get(request.conversationId);
    const box = prev && now - prev.ts <= MATERIAL_TTL_MS
      ? prev
      : { conversationId: request.conversationId, items: [], ts: now };
    const text = cleanText(request.text);
    const attachments = normalizeChatMedia(request).filter(isMaterialMedia);
    // One entry per attachment, in the SAME order the user sent them. The text
    // rides on the first entry. (An earlier version pushed slice(1) before the
    // first item, turning [a,b,c] into [b,c,a] — order is the whole point when
    // the user says "compare these two".)
    if (attachments.length) {
      attachments.forEach((media, i) => {
        box.items.push({
          ...(i === 0 && text ? { text: text.slice(0, 2000) } : {}),
          media,
          ts: now,
        });
      });

    } else {
      box.items.push({
        ...(text ? { text: text.slice(0, 2000) } : {}),
        ts: now,
      });
    }

    // Bound the accumulated box AFTER both branches: link-only materials take
    // the else path and used to accumulate without any ceiling for the full
    // 30-minute window. Keep the most recent and count what was evicted, so a
    // truncated set is never presented as complete.
    if (box.items.length > MATERIAL_LIST_MAX) {
      box.dropped = (box.dropped ?? 0) + (box.items.length - MATERIAL_LIST_MAX);
      box.items = box.items.slice(-MATERIAL_LIST_MAX);
    }
    box.ts = now;
    this.boxes.set(request.conversationId, box);
  }

  take(conversationId: string): MaterialBox | null {
    if (!this.has(conversationId)) return null;
    const box = this.boxes.get(conversationId) || null;
    this.boxes.delete(conversationId);
    return box;
  }

  mergeInto(request: ChatRequest): ChatRequest {
    const box = this.take(request.conversationId);
    if (!box) return request;
    const firstMedia = box.items.find((item) => item.media)?.media;
    return {
      ...request,
      text: materialTextBlock(box.items, request.text, box.dropped ?? 0),
      media: request.media || firstMedia,
    };
  }

  clear(conversationId: string): void {
    this.boxes.delete(conversationId);
  }
}

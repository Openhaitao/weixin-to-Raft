import path from "node:path";

import type { ChatRequest } from "weixin-agent-sdk";

type Media = NonNullable<ChatRequest["media"]>;

const MATERIAL_TTL_MS = 30 * 60 * 1000;
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
  if (isMaterialMedia(request.media)) return !text;
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

function materialTextBlock(items: MaterialItem[], triggerText: string): string {
  const lines: string[] = [];
  items.slice(0, 8).forEach((item, i) => {
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
    box.items.push({
      ...(text ? { text: text.slice(0, 2000) } : {}),
      ...(isMaterialMedia(request.media) ? { media: request.media } : {}),
      ts: now,
    });
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
      text: materialTextBlock(box.items, request.text),
      media: request.media || firstMedia,
    };
  }

  clear(conversationId: string): void {
    this.boxes.delete(conversationId);
  }
}

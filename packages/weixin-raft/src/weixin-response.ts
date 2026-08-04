import type { ChatResponse } from "weixin-agent-sdk";

import type { RaftAttachmentRef } from "./raft-message.js";
import type { PendingOutbound } from "./state.js";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "m4v", "avi", "mkv"]);

export function mediaTypeForFile(name: string): "image" | "video" | "file" {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  return "file";
}

export type AttachmentFetcher = (ref: RaftAttachmentRef) => Promise<string>;

/**
 * Turn a Raft reply into the WeChat message to deliver: prose plus the first
 * attachment as real media. WeChat carries one media per message, so extra
 * attachments are named in the text instead of silently dropped; a failed
 * download degrades to prose with the failure named.
 */
export async function buildWeixinResponse(
  item: PendingOutbound,
  options: { label: boolean; fetchAttachment?: AttachmentFetcher },
): Promise<ChatResponse> {
  let text = options.label ? [`来自 @${item.sender}：`, "", item.text].join("\n") : item.text;
  const [first, ...rest] = item.attachments ?? [];
  if (!first || !options.fetchAttachment) {
    if (first) text = `${text}\n（附件 ${[first, ...rest].map((ref) => ref.name).join("、")} 暂无法转发）`;
    return { text: text.trim() || "（空回复）" };
  }
  if (rest.length) {
    text = `${text}\n（另有附件：${rest.map((ref) => ref.name).join("、")}，本条只转发第一个）`;
  }
  try {
    const filePath = await options.fetchAttachment(first);
    return {
      ...(text.trim() ? { text: text.trim() } : {}),
      media: { type: mediaTypeForFile(first.name), url: filePath, fileName: first.name },
    };
  } catch {
    return { text: `${text}\n（附件 ${first.name} 下载失败，请在 Raft 里查看）`.trim() };
  }
}

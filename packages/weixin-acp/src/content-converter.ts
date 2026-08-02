import fs from "node:fs/promises";
import path from "node:path";

import type { ChatRequest, MediaAttachment } from "weixin-agent-sdk";
import { normalizeChatMedia } from "weixin-agent-sdk";
import type { ContentBlock } from "@agentclientprotocol/sdk";

import { extractPdfTextPreview, looksLikePdf } from "./linearos/pdf-text.js";

async function localMediaNotice(media?: MediaAttachment): Promise<string> {
  if (!media) return "";

  let sizeLine = "";
  try {
    const stat = await fs.stat(media.filePath);
    sizeLine = `size_bytes: ${stat.size}`;
  } catch {
    sizeLine = "size_bytes: unknown";
  }

  const name = media.fileName?.trim() || path.basename(media.filePath);
  const kind = media.type === "video" ? "Video" : "File";
  const lines = [
    `[${kind} attachment]`,
    `name: ${name}`,
    `mime: ${media.mimeType}`,
    `local_path: ${media.filePath}`,
    sizeLine,
    "",
    "The attachment has already been downloaded and decrypted locally.",
    "Use local_path only as the local file reference for the user's uploaded attachment.",
  ];

  if (media.type === "file" && looksLikePdf(media.filePath, media.mimeType)) {
    const text = await extractPdfTextPreview(media.filePath);
    lines.push(
      "",
      "[Extracted PDF text]",
      text || "(PDF text extraction returned empty; use local_path if you need OCR or deeper inspection.)",
    );
  }

  return lines.join("\n");
}

/**
 * Convert a ChatRequest into ACP ContentBlock[].
 */
export async function convertRequestToContentBlocks(
  request: ChatRequest,
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
  const textAlreadyCarriesAttachment = request.text?.includes("[Attachment material]");

  if (request.text) {
    blocks.push({ type: "text", text: request.text });
  }

  // EVERY attachment of this message becomes its own content block, in order.
  // Emitting only `request.media` meant a two-photo message reached the model
  // as one photo (2026-08-02). One unreadable attachment must not swallow the
  // rest, so each is converted independently and failures degrade to a note.
  for (const media of normalizeChatMedia(request)) {
    try {
      switch (media.type) {
        case "image": {
          const data = await fs.readFile(media.filePath);
          blocks.push({ type: "image", data: data.toString("base64"), mimeType: media.mimeType });
          break;
        }
        case "audio": {
          const data = await fs.readFile(media.filePath);
          blocks.push({ type: "audio", data: data.toString("base64"), mimeType: media.mimeType });
          break;
        }
        case "video":
        case "file": {
          if (textAlreadyCarriesAttachment) break;
          blocks.push({ type: "text", text: await localMediaNotice(media) });
          break;
        }
      }
    } catch (err) {
      // Say what was lost rather than dropping it silently.
      blocks.push({
        type: "text",
        text: `[Attachment unavailable] ${path.basename(media.filePath)} (${media.mimeType}) could not be read: ${String(err)}`,
      });
    }
  }

  return blocks;
}

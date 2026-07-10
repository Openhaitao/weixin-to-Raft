import fs from "node:fs/promises";
import path from "node:path";

import type { ChatRequest } from "weixin-agent-sdk";
import type { ContentBlock } from "@agentclientprotocol/sdk";

import { extractPdfTextPreview, looksLikePdf } from "./linearos/pdf-text.js";

async function localMediaNotice(request: ChatRequest): Promise<string> {
  const media = request.media;
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

  if (request.media) {
    const mimeType = request.media.mimeType;

    switch (request.media.type) {
      case "image": {
        const data = await fs.readFile(request.media.filePath);
        const base64 = data.toString("base64");
        blocks.push({ type: "image", data: base64, mimeType });
        break;
      }
      case "audio": {
        const data = await fs.readFile(request.media.filePath);
        const base64 = data.toString("base64");
        blocks.push({ type: "audio", data: base64, mimeType });
        break;
      }
      case "video":
      case "file": {
        if (textAlreadyCarriesAttachment) break;
        blocks.push({ type: "text", text: await localMediaNotice(request) });
        break;
      }
    }
  }

  return blocks;
}

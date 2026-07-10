import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const MAX_EXTRACTED_TEXT_CHARS = 50_000;

export function looksLikePdf(filePath: string, mimeType: string | undefined): boolean {
  return mimeType === "application/pdf" || path.extname(filePath).toLowerCase() === ".pdf";
}

export async function extractPdfTextPreview(filePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("pdftotext", ["-layout", "-enc", "UTF-8", filePath, "-"], {
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const text = String(stdout || "").replace(/\u0000/g, "").trim();
    if (!text) return "";
    return text.length > MAX_EXTRACTED_TEXT_CHARS
      ? `${text.slice(0, MAX_EXTRACTED_TEXT_CHARS)}\n[truncated]`
      : text;
  } catch {
    return "";
  }
}

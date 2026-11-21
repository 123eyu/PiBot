import { type AttachmentInput, RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import { z } from "zod";
import type { OfficePort } from "../../runtime/media/office-port.ts";
import { invalidAttachment } from "./attachment-files.ts";
import { extractAttachment } from "./extract-attachment.ts";

export interface ExtractedAttachment {
  text: string;
  totalChars: number;
  scanned: boolean;
  pages: number;
}
const cacheSchema = z.strictObject({
  totalChars: z.number().int().nonnegative(),
  scanned: z.boolean(),
  pages: z.number().int().nonnegative(),
});
export function encodeCache({ text, totalChars, scanned, pages }: ExtractedAttachment) {
  return `${JSON.stringify({ totalChars, scanned, pages })}\n${text}`;
}
export async function convertFile(
  input: AttachmentInput,
  bytes: Buffer,
  cache: string | undefined,
  signal: AbortSignal,
  officePort?: () => OfficePort,
): Promise<ExtractedAttachment> {
  const pdf = input.mimeType === "application/pdf";
  const docx = input.name.toLowerCase().endsWith(".docx");
  const office = input.name.toLowerCase().endsWith(".xlsx")
    ? "xlsx"
    : input.name.toLowerCase().endsWith(".pptx")
      ? "pptx"
      : undefined;
  if (pdf && bytes.subarray(0, 5).toString("ascii") !== "%PDF-") invalidAttachment();
  if (docx && !bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) invalidAttachment();
  if (cache !== undefined) {
    const line = cache.indexOf("\n");
    if (line < 0) invalidAttachment();
    return { ...cacheSchema.parse(JSON.parse(cache.slice(0, line))), text: cache.slice(line + 1) };
  }
  if (pdf || docx) return extractAttachment(bytes, pdf, signal);
  if (office) {
    if (!officePort) throw new RpcError(RpcErrorCodes.unsupported, "office_unavailable");
    try {
      return await officePort().extract(bytes, office, signal);
    } catch {
      // Match the original attachment Worker refusal without exposing decoder diagnostics.
      throw new RpcError(RpcErrorCodes.attachmentConversion, "attachment_conversion");
    }
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalidAttachment();
  }
  if (text.includes("\0")) invalidAttachment();
  return { text, totalChars: text.length, scanned: false, pages: 0 };
}

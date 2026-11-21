import { MemorySchema } from "@pibot/protocol";
import { z } from "zod";

export const TRANSFER_LIMIT = 1024 * 1024;
export const transferEntry = MemorySchema.pick({ text: true, category: true });
const transfer = z.strictObject({
  version: z.literal(1),
  entries: z.array(transferEntry).max(2000),
});
export type ImportEntry = z.infer<typeof transferEntry>;

// A data fence avoids interpreting arbitrary Markdown, embedded links or scope declarations.
export function decodeMemories(text: string): ImportEntry[] {
  if (new TextEncoder().encode(text).length > TRANSFER_LIMIT)
    throw new Error("memory_import_limit");
  const match = /^# Pi Bot memory export\r?\n\r?\n```pibot-memory\r?\n([\s\S]*)\r?\n```\s*$/.exec(
    text,
  );
  if (!match) throw new Error("memory_import_format");
  return transfer.parse(JSON.parse(match[1] ?? "")).entries;
}
export function encodeMemories(entries: ImportEntry[]): string {
  const data = transfer.parse({ version: 1, entries });
  // Escape backticks so user text cannot close the data fence.
  const body = JSON.stringify(data, null, 2).replaceAll("`", "\\u0060");
  const text = `# Pi Bot memory export\n\n\`\`\`pibot-memory\n${body}\n\`\`\`\n`;
  if (new TextEncoder().encode(text).length > TRANSFER_LIMIT)
    throw new Error("memory_export_limit");
  return text;
}

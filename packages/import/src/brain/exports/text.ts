// Enforce the common message size limit before untrusted export text reaches storage.
import { ImportFailure, type ImportRecord } from "../adapter.ts";

export type ConversationItem =
  | ImportRecord
  | { kind: "attachments"; count: number }
  | { kind: "instructions"; value: readonly (string | undefined)[] };

export function readableText(parts: readonly string[]) {
  const text = parts.filter((part) => part.trim()).join("\n");
  if (text.length > 65_536) throw new ImportFailure("limit");
  return text;
}

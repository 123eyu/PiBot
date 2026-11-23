// Adapters yield bounded records rather than exposing provider-specific objects to storage.
import type { ImportSource } from "@pibot/import-contract";
import { z } from "zod";

const time = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString());
export const ImportTopicSchema = z.strictObject({
  kind: z.literal("topic"),
  title: z.string().max(200),
  createdAt: time,
  updatedAt: time,
});
export const ImportMessageSchema = z.strictObject({
  kind: z.literal("message"),
  role: z.enum(["user", "assistant"]),
  text: z.string().max(65_536),
  createdAt: time,
});
export const ImportRecordSchema = z.discriminatedUnion("kind", [
  ImportTopicSchema,
  ImportMessageSchema,
]);
export type ImportRecord = z.input<typeof ImportRecordSchema>;

export const PreviewRecordSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("topic"), createdAt: time, updatedAt: time }),
  z.strictObject({ kind: z.literal("message"), createdAt: time }),
]);
export type PreviewRecord = z.input<typeof PreviewRecordSchema>;

export type ImportInput = (signal: AbortSignal) => AsyncIterable<Buffer>;

export interface ImportAdapter {
  detect(signal: AbortSignal): AsyncIterable<boolean>;
  preview(input: ImportInput, signal: AbortSignal): AsyncIterable<PreviewRecord>;
  /** Every topic precedes its messages. Topics and messages from different topics never interleave. */
  read(input: ImportInput, signal: AbortSignal): AsyncIterable<ImportRecord>;
}

export class ImportFailure extends Error {
  constructor(readonly reason: "source_changed" | "format" | "target" | "limit") {
    super(reason);
  }
}

export function adapters(fixture: ImportAdapter): Record<ImportSource, ImportAdapter> {
  const unsupported: ImportAdapter = {
    async *detect(signal) {
      signal.throwIfAborted();
      yield false;
    },
    preview() {
      throw new ImportFailure("format");
    },
    read() {
      throw new ImportFailure("format");
    },
  };
  return {
    fixture,
    chatgpt: unsupported,
    claude: unsupported,
    "claude-code": unsupported,
    codex: unsupported,
    cursor: unsupported,
    gemini: unsupported,
  };
}

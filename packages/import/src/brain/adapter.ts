// Adapters yield bounded records rather than exposing provider-specific objects to storage.
import { ExportDetailsSchema, type ImportSource } from "@pibot/import-contract";
import { z } from "zod";
import { geminiAdapter } from "./local/gemini.ts";
import { transcriptAdapter } from "./local/transcript.ts";

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

const exportSummary = ExportDetailsSchema.extend({ kind: z.literal("exportSummary") });
export const PreviewRecordSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("topic"), createdAt: time, updatedAt: time }),
  z.strictObject({ kind: z.literal("message"), createdAt: time }),
  z.strictObject({ kind: z.literal("skipped") }),
  exportSummary,
]);
export type PreviewRecord = z.input<typeof PreviewRecordSchema>;

export interface ImportFile {
  size: number;
  read(offset: number, length: number): Promise<Buffer>;
}

export interface ImportInput {
  (signal: AbortSignal): AsyncIterable<Buffer>;
  modifiedAt?: string;
  projectNote?: true;
  file?(signal: AbortSignal): AsyncIterable<ImportFile>;
}

export interface ImportAdapter {
  detect(signal: AbortSignal): AsyncIterable<boolean>;
  preview(input: ImportInput, signal: AbortSignal): AsyncIterable<PreviewRecord>;
  /** Every topic precedes its messages. Topics and messages from different topics never interleave. */
  read(input: ImportInput, signal: AbortSignal): AsyncIterable<ImportRecord>;
}

export class ImportFailure extends Error {
  constructor(readonly reason: "source_changed" | "format" | "target" | "limit" | "unsupported") {
    super(reason);
  }
}

export function adapters(
  fixture: ImportAdapter,
  chatgpt: ImportAdapter,
  claude: ImportAdapter,
): Record<ImportSource, ImportAdapter> {
  return {
    fixture,
    chatgpt,
    claude,
    "claude-code": transcriptAdapter("claude-code"),
    codex: transcriptAdapter("codex"),
    cursor: transcriptAdapter("cursor"),
    gemini: geminiAdapter,
  };
}

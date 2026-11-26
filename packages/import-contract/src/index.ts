// Desktop clients and the import worker share a content-free preview and progress contract.
import { IdSchema } from "@pibot/protocol-base";
import { z } from "zod";

export const ImportSourceSchema = z.enum([
  "fixture",
  "chatgpt",
  "claude",
  "claude-code",
  "codex",
  "cursor",
  "gemini",
]);
export type ImportSource = z.infer<typeof ImportSourceSchema>;

const count = z.number().int().nonnegative().safe();
export const ImportCountsSchema = z.strictObject({ topics: count, messages: count });
export type ImportCounts = z.infer<typeof ImportCountsSchema>;

export const ExportDetailsSchema = z.strictObject({
  memories: count,
  customInstructions: count,
  projects: count,
  skippedAttachments: count,
  skippedFiles: count,
});
export type ExportDetails = z.infer<typeof ExportDetailsSchema>;

const preview = ImportCountsSchema.extend({
  importId: IdSchema,
  source: ImportSourceSchema,
  from: z.iso.datetime().nullable(),
  through: z.iso.datetime().nullable(),
  projectNotes: count.optional(),
  skippedRecords: count.optional(),
  exportDetails: ExportDetailsSchema.optional(),
});
export type ImportPreview = z.infer<typeof preview>;

export const ImportStatusSchema = ImportCountsSchema.extend({
  importId: IdSchema,
  source: ImportSourceSchema,
  state: z.enum(["running", "completed", "cancelled", "failed", "undoing", "undone"]),
  removed: ImportCountsSchema.optional(),
  reason: z
    .enum([
      "source_changed",
      "format",
      "timeout",
      "target",
      "limit",
      "interrupted",
      "internal",
      "unsupported",
    ])
    .nullable(),
});
export type ImportStatus = z.infer<typeof ImportStatusSchema>;

const importId = z.strictObject({ importId: IdSchema });
const source = z.strictObject({ source: ImportSourceSchema });

export const ImportMethods = {
  "import.detect": { params: source, result: z.strictObject({ available: z.boolean() }) },
  "import.preview": { params: source, result: preview.nullable() },
  "import.start": { params: importId.extend({ botId: IdSchema }), result: ImportStatusSchema },
  "import.status": { params: importId, result: ImportStatusSchema },
  "import.cancel": { params: importId, result: ImportStatusSchema },
  "import.undo": { params: importId, result: ImportStatusSchema },
} as const;

export const ImportEvents = { "import.progress": ImportStatusSchema } as const;

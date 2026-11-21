import { z } from "zod";
import { IdSchema } from "../core/ids.ts";

export const DraftContentSchema = z
  .string()
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= 64 * 1024,
    "Draft content exceeds 64KiB",
  );
export const CalendarDraftContentSchema = z.strictObject({
  title: z.string().min(1).max(512),
  // Zone-less dates have different meanings in JavaScript and Windows DateTimeOffset.
  start: z.iso.datetime({ offset: true }).max(64),
  end: z.iso.datetime({ offset: true }).max(64),
  calendarId: z.string().max(4096).optional(),
  location: z.string().max(1024).optional(),
  notes: z.string().max(8192).optional(),
  allDay: z.boolean().optional(),
});
export const DraftBindingSchema = z
  .strictObject({
    contentField: z.string().min(1).max(200),
    targetField: z.string().min(1).max(200),
    targetTemplate: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (value) => /\{[A-Za-z][A-Za-z0-9_]*\}/.test(value),
        "Draft target template requires a field placeholder",
      )
      .optional(),
  })
  .refine((value) => value.contentField !== value.targetField);
export const DraftMetadataSchema = z.strictObject({
  identity: z.enum(["user", "bot"]),
  connectorName: z.string().min(1).max(200).optional(),
  target: z.string().min(1).max(4096),
  connectorId: IdSchema,
  tool: z.string().min(1).max(4096),
  revision: z.number().int().positive().safe(),
  catalogVersion: z.number().int().nonnegative().safe(),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  contentLength: z
    .number()
    .int()
    .nonnegative()
    .max(64 * 1024),
  operation: z.literal("calendar_create").optional(),
  editable: z.boolean(),
  canRememberTool: z.boolean().optional(),
  canRememberTarget: z.boolean(),
});
export const DraftStatusSchema = z.enum([
  "pending",
  "sending",
  "sent",
  "discarded",
  "expired",
  "failed",
  "unknown",
]);
export const DraftViewSchema = z.strictObject({
  approvalId: IdSchema,
  botId: IdSchema,
  conversationId: IdSchema,
  draft: DraftMetadataSchema,
  edited: z.boolean(),
  status: DraftStatusSchema,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
});
const resolve = z
  .strictObject({
    approvalId: IdSchema,
    action: z.enum(["send", "discard"]),
    content: DraftContentSchema.optional(),
    rememberTarget: z.boolean().optional(),
    rememberTool: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.action !== "discard" ||
      (value.content === undefined && !value.rememberTarget && !value.rememberTool),
  );
export const DraftMethods = {
  "drafts.status": {
    params: z.strictObject({ approvalId: IdSchema, conversationId: IdSchema }),
    result: z.strictObject({ status: DraftStatusSchema }),
  },
  "drafts.get": {
    params: z.strictObject({ approvalId: IdSchema, conversationId: IdSchema }),
    result: DraftViewSchema.extend({
      content: DraftContentSchema,
      calendarName: z.string().max(512).optional(),
      calendarTimeZone: z.string().min(1).max(200).optional(),
    }),
  },
  "drafts.list": {
    params: z.strictObject({
      before: IdSchema.optional(),
      limit: z.number().int().min(1).max(200).optional(),
      botId: IdSchema.optional(),
    }),
    result: z.array(DraftViewSchema),
  },
  "drafts.resolve": {
    params: resolve,
    result: z.strictObject({ ok: z.literal(true), status: DraftStatusSchema }),
  },
} as const;
export const DraftEvents = {
  "drafts.changed": z.strictObject({
    approvalId: IdSchema,
    conversationId: IdSchema,
    status: DraftStatusSchema,
  }),
} as const;
export type DraftMetadata = z.output<typeof DraftMetadataSchema>;
export type DraftBinding = z.output<typeof DraftBindingSchema>;
export type DraftView = z.output<typeof DraftViewSchema>;
export type DraftStatus = z.output<typeof DraftStatusSchema>;
export type DraftResolve = z.output<typeof resolve>;

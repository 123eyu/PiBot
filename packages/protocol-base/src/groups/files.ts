import { z } from "zod";
import { PreviewFileSchema } from "../chat/file-preview.ts";
import { IdSchema } from "../core/ids.ts";

export const GroupRelativePathSchema = z
  .string()
  .max(4096)
  .refine(
    (value) =>
      value === "" ||
      (!/[\\\p{Cc}\p{Cf}]/u.test(value) &&
        value.split("/").length <= 32 &&
        value
          .split("/")
          .every((part) => !!part && part !== "." && part !== ".." && !part.includes(":"))),
  );
export const GroupFolderSelectionSchema = z.union([IdSchema, z.literal("home")]);
const request = z.strictObject({ groupId: IdSchema, requestId: IdSchema });
export const GroupFileMethods = {
  "groups.files.list": {
    params: request.extend({
      folderId: GroupFolderSelectionSchema.optional(),
      path: GroupRelativePathSchema.default(""),
      cursor: z.string().min(1).max(8192).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }),
    result: z.strictObject({
      entries: z
        .array(
          z.strictObject({
            name: z.string().min(1).max(4096),
            path: GroupRelativePathSchema,
            kind: z.enum(["file", "directory", "blocked"]),
          }),
        )
        .max(200),
      rootToken: z.string().min(1).max(128),
      cursor: z.string().min(1).max(8192).optional(),
      truncated: z.boolean(),
    }),
  },
  "groups.files.open": {
    params: request.extend({
      folderId: GroupFolderSelectionSchema.optional(),
      path: GroupRelativePathSchema.refine((value) => !!value),
      rootToken: z.string().min(1).max(128),
    }),
    result: z.strictObject({
      ok: z.literal(true),
      preview: z
        .strictObject({
          groupId: IdSchema,
          folderId: GroupFolderSelectionSchema.optional(),
          path: GroupRelativePathSchema,
          rootToken: z.string().min(1).max(128),
        })
        .optional(),
    }),
  },
  "groups.files.preview": {
    params: request.extend({
      folderId: GroupFolderSelectionSchema.optional(),
      path: GroupRelativePathSchema.refine((v) => !!v),
      rootToken: z.string().min(1).max(128),
      expectedRevision: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    }),
    result: PreviewFileSchema,
  },
  "groups.files.cancel": {
    params: request,
    result: z.strictObject({ ok: z.literal(true) }),
  },
} as const;

import {
  OfficeAppsSchema,
  OfficeFormatSchema,
  OfficePreviewSchema,
  OfficeRenderCheckSchema,
  OfficeRenderedPagesSchema,
  PreviewFileSchema,
  previewSourceParams,
} from "@pibot/protocol-base";
import { z } from "zod";

const revision = z.string().regex(/^[a-f0-9]{64}$/);
const page = z.number().int().nonnegative();
const renderKey = {
  runId: z.uuid(),
  messageId: z.uuid(),
  toolCallId: z.string().min(1).max(300),
};
export const OfficeMethods = {
  "office.renderStep": {
    params: z.strictObject(renderKey),
    result: z
      .strictObject({
        name: z.string().min(1).max(255),
        format: OfficeFormatSchema,
        status: z.enum(["rendered", "partial", "unsupported", "restricted", "failed"]),
        check: OfficeRenderCheckSchema,
        pages: OfficeRenderedPagesSchema,
        /** Kept with the message after the in-memory images expire. */
        imagesExpired: z.boolean().optional(),
      })
      .nullable(),
  },
  "office.renderSnapshot": {
    params: z.strictObject({ ...renderKey, page: z.number().int().min(1).max(10_000) }),
    result: PreviewFileSchema,
  },
  /** Same sources as preview.read: a message attachment or a file a run changed. */
  "office.preview": {
    params: previewSourceParams({
      requestId: z.uuid(),
      expectedRevision: revision.optional(),
      page: page.optional(),
      sheet: page.optional(),
      offset: page.optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    result: OfficePreviewSchema,
  },
  "office.apps": {
    params: z.strictObject({ format: OfficeFormatSchema }),
    result: OfficeAppsSchema,
  },
  "office.cancel": { params: z.strictObject({ requestId: z.uuid() }), result: z.null() },
  "office.open": {
    params: previewSourceParams({ appId: z.string().min(1).max(300).optional() }),
    result: z.null(),
  },
};

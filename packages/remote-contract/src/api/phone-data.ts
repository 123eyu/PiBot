import {
  FILE_LIMIT,
  IdSchema,
  IMAGE_LIMIT,
  IMAGE_MIMES,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol-base";
import { z } from "zod";
import { PREVIEW_DATA_CHUNK } from "./preview.ts";

// The computer's Bots use the paired phone (photos, SMS verification codes) and the phone
// shares into Pi Bot. Desktop → phone calls ride the same encrypted session as the phone's own
// requests, in the opposite direction; only the phone answers them, and only for the switches its
// owner turned on for this computer.

/** Request IDs of desktop → phone calls; the two directions never share an ID space. */
export const PHONE_CALL_ID_PREFIX = "pd:";
/** The phone's answer to a desktop call stays under the gateway's 900 kB response cap. */
export const PHONE_RESULT_MAX_BYTES = 900_000;
export const PHONE_MEDIA_MAX = 100;
/** What a model receives of one photo or video cover. */
export const PHONE_IMAGE_MAX_EDGE = 1600;
export const PHONE_IMAGE_MAX_BYTES = 1024 * 1024;
/** The longest a Bot may wait for a code to arrive. */
export const PHONE_SMS_MAX_WAIT_MS = 5 * 60_000;
export const PHONE_SMS_MIN_WAIT_MS = 5_000;

/** Why a phone did not answer; the desktop maps each to one fixed message for the Bot. */
export const PhoneDataErrorSchema = z.enum([
  "capability_off",
  "phone_offline",
  "phone_category_off",
  "unsupported_platform",
  "phone_consent_denied",
  "phone_permission_denied",
  "phone_media_not_found",
  "phone_sms_timeout",
  "phone_busy",
]);
export type PhoneDataError = z.infer<typeof PhoneDataErrorSchema>;
export function phoneDataError(code: PhoneDataError): never {
  throw new RpcError(RpcErrorCodes.unsupported, code);
}

const assetId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:/-]+$/);
const time = z.iso.datetime();
const dimension = z.number().int().min(0).max(100_000);
export const PhoneMediaKindSchema = z.enum(["photo", "video"]);
export const PhoneMediaItemSchema = z.strictObject({
  id: assetId,
  kind: PhoneMediaKindSchema,
  takenAt: time,
  width: dimension,
  height: dimension,
  durationMs: z.number().int().nonnegative().max(86_400_000).optional(),
  /** Whether the item carries a location; never the coordinates. null = the phone cannot tell. */
  hasLocation: z.boolean().nullable(),
});
export const PhoneMediaQuerySchema = z
  .strictObject({
    from: time.optional(),
    to: time.optional(),
    kind: z.enum(["photo", "video", "all"]).optional(),
    limit: z.number().int().min(1).max(PHONE_MEDIA_MAX).optional(),
    after: z.string().min(1).max(200).optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, "Invalid range");
export const PhoneMediaPageSchema = z.strictObject({
  items: z.array(PhoneMediaItemSchema).max(PHONE_MEDIA_MAX),
  nextAfter: z.string().min(1).max(200).nullable(),
  /** iOS "selected photos only": the owner shares a subset; the Bot sees only that subset. */
  limited: z.boolean(),
});
export const PhoneMediaGetSchema = z.strictObject({
  id: assetId,
  /** Base64 offset of the slice; 0 prepares the image (downscaled JPEG) on the phone. */
  offset: z
    .number()
    .int()
    .nonnegative()
    .max(Math.ceil(PHONE_IMAGE_MAX_BYTES / 3) * 4),
});
export const PhoneMediaSliceSchema = z.strictObject({
  item: PhoneMediaItemSchema,
  /** A photo, or a video's cover frame; always JPEG within the image limits. */
  width: z.number().int().min(1).max(PHONE_IMAGE_MAX_EDGE),
  height: z.number().int().min(1).max(PHONE_IMAGE_MAX_EDGE),
  total: z
    .number()
    .int()
    .min(4)
    .max(Math.ceil(PHONE_IMAGE_MAX_BYTES / 3) * 4),
  offset: z.number().int().nonnegative(),
  chunk: z.string().max(PREVIEW_DATA_CHUNK),
});
export const PhoneSmsQuerySchema = z.strictObject({
  /** A phone number narrows the system consent to that sender; other text matches the message. */
  senderHint: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v))
    .optional(),
  waitMs: z.number().int().min(PHONE_SMS_MIN_WAIT_MS).max(PHONE_SMS_MAX_WAIT_MS),
});
export const PhoneSmsCodeSchema = z.strictObject({
  code: z.string().regex(/^[A-Za-z0-9]{4,8}$/),
  /** Last four digits of the sender, when the phone knows it (the consent sheet does not say). */
  senderLast4: z
    .string()
    .regex(/^\d{4}$/)
    .nullable(),
});
export const PhoneDataStateSchema = z.strictObject({
  platform: z.enum(["ios", "android"]),
  media: z.boolean(),
  smsCode: z.boolean(),
});

export const PhoneReadPageQuerySchema = z.strictObject({
  before: z
    .strictObject({ at: z.number().int().nonnegative().safe(), id: z.string().max(512) })
    .optional(),
  limit: z.number().int().min(1).max(25).default(25),
});
const cursor = z
  .strictObject({ at: z.number().int().nonnegative().safe(), id: z.string().max(512) })
  .nullable();
export const PhoneCallsPageSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        id: z.string().max(512),
        at: z.number(),
        duration: z.number().nonnegative(),
        type: z.number().int(),
      }),
    )
    .max(25),
  next: cursor,
});
export const PhoneNotificationsPageSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        id: z.string().max(512),
        at: z.number(),
        app: z.string().max(256),
        title: z.string().max(512).nullable(),
        text: z.string().max(2048).nullable(),
      }),
    )
    .max(25),
  next: cursor,
});
/** Desktop → phone (answered by the phone app, never by a desktop handler). */
export const PhoneDataMethods = {
  "phoneData.calls": { params: PhoneReadPageQuerySchema, result: PhoneCallsPageSchema },
  "phoneData.notifications": {
    params: PhoneReadPageQuerySchema,
    result: PhoneNotificationsPageSchema,
  },
  "phoneData.media": { params: PhoneMediaQuerySchema, result: PhoneMediaPageSchema },
  "phoneData.mediaGet": { params: PhoneMediaGetSchema, result: PhoneMediaSliceSchema },
  "phoneData.smsCode": { params: PhoneSmsQuerySchema, result: PhoneSmsCodeSchema },
} as const;
export type PhoneDataMethod = keyof typeof PhoneDataMethods;

// Share upload: the phone sends one file in frame-sized slices; the desktop gateway keeps
// it until this session's chat.send names it, then the kernel stores it like any attachment.
const SHARE_MAX_BASE64 = Math.ceil(FILE_LIMIT / 3) * 4;
export const RemoteShareUploadSchema = z
  .strictObject({
    /** Continues an upload; absent on the first slice. */
    uploadId: IdSchema.optional(),
    kind: z.enum(["image", "file"]),
    name: z
      .string()
      .min(1)
      .max(255)
      .refine((v) => !/[\\/\p{Cc}\p{Cf}]/u.test(v) && v !== "." && v !== ".."),
    mimeType: z.string().min(1).max(200),
    /** Base64 length of the whole file. */
    total: z.number().int().min(4).max(SHARE_MAX_BASE64),
    offset: z.number().int().nonnegative().max(SHARE_MAX_BASE64),
    chunk: z
      .string()
      .min(1)
      .max(PREVIEW_DATA_CHUNK)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  })
  .refine((u) => u.offset === 0 || !!u.uploadId, "Later slices need an upload")
  .refine((u) => u.kind === "file" || (IMAGE_MIMES as readonly string[]).includes(u.mimeType))
  .refine((u) => u.kind === "file" || u.total <= Math.ceil(IMAGE_LIMIT / 3) * 4);
export const RemoteShareReceiptSchema = z.strictObject({
  uploadId: IdSchema,
  received: z.number().int().nonnegative(),
  /** Set once the last slice arrived: name it in this session's chat.send `attachmentIds`. */
  attachmentId: IdSchema.optional(),
});

/** Capability port: other capabilities reach the phone through the remote capability. */
export const PHONE_DATA_PORT = "remote.phoneData";
export interface PhoneDataPort {
  /** The categories each online phone reported; empty when no phone is online. */
  online(): { deviceId: string; state: z.infer<typeof PhoneDataStateSchema> | null }[];
  call<K extends PhoneDataMethod>(
    method: K,
    params: z.input<(typeof PhoneDataMethods)[K]["params"]>,
    signal: AbortSignal,
    deviceId?: string,
  ): Promise<{ deviceId: string; result: z.output<(typeof PhoneDataMethods)[K]["result"]> }>;
}

export type PhoneMediaItem = z.infer<typeof PhoneMediaItemSchema>;
export type PhoneMediaQuery = z.infer<typeof PhoneMediaQuerySchema>;
export type PhoneMediaPage = z.infer<typeof PhoneMediaPageSchema>;
export type PhoneMediaSlice = z.infer<typeof PhoneMediaSliceSchema>;
export type PhoneSmsQuery = z.infer<typeof PhoneSmsQuerySchema>;
export type PhoneSmsCode = z.infer<typeof PhoneSmsCodeSchema>;
export type PhoneDataState = z.infer<typeof PhoneDataStateSchema>;
export type RemoteShareUpload = z.infer<typeof RemoteShareUploadSchema>;
export type RemoteShareReceipt = z.infer<typeof RemoteShareReceiptSchema>;

import type { Message } from "@pibot/protocol";
import { IdSchema } from "@pibot/protocol-base";
import { z } from "zod";

export const ComputerSchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1).max(200),
  relay: z
    .url()
    .refine(
      (v) =>
        new URL(v).protocol === "wss:" &&
        !new URL(v).username &&
        !new URL(v).password &&
        !new URL(v).search &&
        !new URL(v).hash,
    ),
  publicKey: z.string().min(1).max(512),
  safetyCode: z.string().regex(/^\d{6}$/),
});
export const TargetSchema = z
  .strictObject({
    botId: IdSchema.optional(),
    groupId: IdSchema.optional(),
    topicId: IdSchema,
    threadId: IdSchema.optional(),
  })
  .refine((t) => !!t.botId !== !!t.groupId);
export const PendingFileSchema = z.strictObject({
  kind: z.enum(["image", "file"]),
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(200),
  blob: z.string().regex(/^[A-Za-z0-9-]{1,80}$/),
  bytes: z.number().int().positive(),
});
export const PendingSchema = z
  .strictObject({
    clientId: IdSchema,
    computerId: IdSchema,
    target: TargetSchema,
    text: z.string().trim().max(8000),
    /** Group only: Bots picked from the @ list, so the brain never guesses between names. */
    mentions: z.array(IdSchema).max(6).optional(),
    /** Files shared into the conversation, uploaded right before the send. */
    files: z.array(PendingFileSchema).min(1).max(5).optional(),
    createdAt: z.iso.datetime(),
  })
  .refine((m) => !!m.text || !!m.files?.length, "Empty message");
export interface LocalData {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  removePrefix(prefix: string): Promise<void>;
  close(): Promise<void>;
}
export interface SecretData {
  get(id: string): Promise<string | null>;
  set(id: string, value: string): Promise<void>;
  remove(id: string): Promise<void>;
}
export type CachedMessage = Message;

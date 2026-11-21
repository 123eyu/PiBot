import {
  IdSchema,
  PhoneRunnerReceiptSchema,
  RunnerOfflineContextSchema,
  ThinkingLevelSchema,
  UserQuestionSchema,
} from "@pibot/protocol-base";
import { z } from "zod";

// What a paired phone needs to answer a private chat by itself while the computer is
// unreachable, and what it brings back afterwards. The computer stays the record: it decides which
// models and Bots a phone may use, builds each Bot's prompt, and imports the phone's offline chats.
// Everything here travels only over the paired, end-to-end encrypted phone session.

/** APIs a phone can stream itself (pi-ai adapters without Node builtins). */
export const OfflineApiSchema = z.enum([
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
]);
// Provider catalogs can contain more models than the old per-Bot grant cap. The manifest is one
// RPC reply and a link frame is at most 1 MiB; a model entry is about 400 bytes, so 1000 models
// (~400 KB) leave room for Bots and groups (Claude review 2026-11-12).
export const OFFLINE_MAX_MODELS = 1000;
/** The computer's own device view lists every candidate; it never crosses the phone link. */
export const OFFLINE_MAX_VIEW_MODELS = 5000;
export const OFFLINE_MAX_PROVIDERS = 50;
export const OFFLINE_MAX_MODELS_PER_PROVIDER = 300;
export const OFFLINE_MAX_BOTS = 50;
export const OFFLINE_MAX_GROUPS = 50;
/** Tools a phone runs itself; anything else in a snapshot is ignored by the phone. */
export const OFFLINE_RUNNER_TOOLS = [
  "run_command",
  "read_file",
  "write_file",
  "list_dir",
  "background_command",
] as const;
export const OFFLINE_TOOL_NAMES = [
  ...OFFLINE_RUNNER_TOOLS,
  "phone_media",
  "phone_media_get",
  "phone_sms_code",
  "phone_calls",
  "phone_notifications",
  "ask_user",
  "memory_add",
] as const;
export const OfflineToolNameSchema = z.enum(OFFLINE_TOOL_NAMES);
/** Content digests: the phone compares them to skip unchanged data on reconnect. */
const version = z.string().regex(/^[a-f0-9]{16,64}$/);
const label = z.string().min(1).max(200);
const price = z.number().nonnegative().max(1_000_000);

/** One model the user allowed for this phone; `delivered` once its key was sent on request. */
export const OfflineModelSchema = z.strictObject({
  grantId: IdSchema,
  providerId: label,
  providerName: label,
  modelId: z.string().min(1).max(256),
  modelName: label,
  api: OfflineApiSchema,
  baseUrl: z.url().max(2048),
  reasoning: z.boolean(),
  input: z
    .array(z.enum(["text", "image"]))
    .min(1)
    .max(2),
  contextWindow: z.number().int().positive().max(100_000_000),
  maxTokens: z.number().int().positive().max(10_000_000),
  thinkingLevel: ThinkingLevelSchema,
  cost: z.strictObject({ input: price, output: price, cacheRead: price, cacheWrite: price }),
  delivered: z.boolean(),
});
export const OfflineBotSchema = z.strictObject({
  id: IdSchema,
  name: label,
  avatarShape: label,
  avatarColor: label,
  avatarEyes: label,
  isMain: z.boolean(),
  /** The user's 「离线可用」 switch for this phone. */
  offline: z.boolean(),
  /** The granted model it uses offline: its own model when granted, else the first one. */
  grantId: IdSchema.nullable(),
  modelId: z.string().max(256).nullable(),
  /** Version of its prompt snapshot; null when it cannot run offline. */
  snapshotVersion: version.nullable(),
  /** An external agent Bot; it runs only on the computer, never offline. */
  kind: z.literal("agent").optional(),
});
/** Profile only: groups are never orchestrated on the phone (待决定 1). */
export const OfflineGroupSchema = z.strictObject({
  id: IdSchema,
  name: label,
  memberIds: z.array(IdSchema).max(OFFLINE_MAX_BOTS),
});
export const OfflineManifestSchema = z.strictObject({
  version,
  language: z.enum(["zh", "en"]),
  models: z.array(OfflineModelSchema).max(OFFLINE_MAX_MODELS),
  bots: z.array(OfflineBotSchema).max(OFFLINE_MAX_BOTS),
  groups: z.array(OfflineGroupSchema).max(OFFLINE_MAX_GROUPS),
});
/** A key travels only for a delivered model and only when the phone's copy differs. */
/** Custom request headers of a provider, delivered like the key (maintainers 2026-11-12). */
export const OfflineHeadersSchema = z
  .record(z.string().regex(/^[A-Za-z0-9-]{1,128}$/), z.string().max(4096))
  .refine((value) => Object.keys(value).length <= 32, "Too many headers");
export const OfflineKeyDeliverySchema = z.strictObject({
  grantId: IdSchema,
  key: z.string().min(1).max(4096),
  headers: OfflineHeadersSchema.optional(),
  digest: version,
});
export const OfflineToolDefinitionSchema = z.strictObject({
  name: OfflineToolNameSchema,
  description: z.string().min(1).max(8000),
  parameters: z.record(z.string(), z.unknown()),
});
/**
 * Built by the computer's own prompt assembly: the phone uses it as it is. `reference`
 * carries the curated memory notes; like the desktop's context reference it is reference material,
 * not system content, so the phone places it in front of the conversation, never in the system.
 */
export const OfflineSnapshotSchema = z.strictObject({
  runner: RunnerOfflineContextSchema.optional(),
  botId: IdSchema,
  version,
  grantId: IdSchema,
  language: z.enum(["zh", "en"]),
  systemPrompt: z.string().min(1).max(120_000),
  reference: z.string().max(24_000),
  tools: z.array(OfflineToolDefinitionSchema).max(OFFLINE_TOOL_NAMES.length),
});

// Phone → computer upload. Client IDs make every item idempotent.
const text = (max: number) => z.string().max(max);
export const OfflineUsageSchema = z.strictObject({
  input: z.number().int().nonnegative().safe(),
  output: z.number().int().nonnegative().safe(),
  cacheRead: z.number().int().nonnegative().safe(),
  cacheWrite: z.number().int().nonnegative().safe(),
  totalTokens: z.number().int().nonnegative().safe(),
  costUsd: z.number().nonnegative().max(10_000),
  requests: z.number().int().min(0).max(1000),
});
export const OfflineToolRecordSchema = z.strictObject({
  name: z.string().min(1).max(80),
  outcome: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/),
});
export const OfflineMessageSchema = z.strictObject({
  clientId: IdSchema,
  role: z.enum(["user", "assistant"]),
  content: text(16_000),
  status: z.enum(["done", "error", "aborted"]),
  createdAt: z.iso.datetime(),
  usage: OfflineUsageSchema.optional(),
  tools: z.array(OfflineToolRecordSchema).max(20).optional(),
  question: UserQuestionSchema.optional(),
});
export const OfflineAuditSchema = z.strictObject({
  clientId: IdSchema,
  at: z.iso.datetime(),
  tool: z.string().min(1).max(80),
  category: z.enum(["phone_data", "planning", "memory_proposal", "unavailable"]),
  decision: z.enum(["allow", "deny"]),
  outcome: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/),
  itemCount: z.number().int().min(0).max(100).optional(),
});
export const OfflineMemoryProposalSchema = z.strictObject({
  clientId: IdSchema,
  /** The assistant message that proposed it. */
  messageClientId: IdSchema,
  text: z.string().trim().min(1).max(2000),
  category: z.enum(["about_you", "work", "how_to"]),
  why: z.string().trim().min(1).max(1000).optional(),
  how: z.string().trim().min(1).max(1000).optional(),
});
/** One request the phone sent to a model vendor: who, which Bot, how many messages; no text. */
export const OfflineEgressSchema = z.strictObject({
  clientId: IdSchema,
  at: z.iso.datetime(),
  providerId: label,
  modelId: z.string().min(1).max(256),
  messageCount: z.number().int().min(0).max(1000),
});
export const OfflineRunnerReceiptSchema = PhoneRunnerReceiptSchema;
export type OfflineRunnerReceipt = z.infer<typeof OfflineRunnerReceiptSchema>;
export const OFFLINE_UPLOAD_MESSAGES = 40;
export const OfflineUploadSchema = z.strictObject({
  /** The phone's local topic: one per offline period and Bot. */
  localTopicId: IdSchema,
  botId: IdSchema,
  /**
   * The Bot's computer topic this offline chat continues (its current topic when the link
   * dropped), so the replies join it in time order. Absent (phones before 2026-11-14) or no longer
   * usable (archived, another Bot's): the chat gets a topic of its own, as before. A computer
   * without this field refuses it as an unknown key; the phone then sends the part without it.
   */
  topicId: IdSchema.optional(),
  grantId: IdSchema,
  providerId: label,
  modelId: z.string().min(1).max(256),
  /** Parts of one topic in order; the last one lets the computer seed the model history. */
  part: z.number().int().min(0).max(100),
  final: z.boolean(),
  messages: z.array(OfflineMessageSchema).max(OFFLINE_UPLOAD_MESSAGES),
  runnerReceipts: z.array(OfflineRunnerReceiptSchema).max(32).optional(),
  audit: z.array(OfflineAuditSchema).max(200),
  memory: z.array(OfflineMemoryProposalSchema).max(20),
  egress: z.array(OfflineEgressSchema).max(200),
});
export const OfflineUploadReceiptSchema = z.strictObject({
  topicId: IdSchema,
  imported: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
});

/** The computer's settings page: which models and Bots this phone may use offline. */
export const OfflineDeviceViewSchema = z.strictObject({
  deviceId: IdSchema,
  models: z
    .array(
      z.strictObject({
        providerId: z.string().max(200),
        providerName: z.string().max(200),
        modelId: z.string().min(1).max(256),
        modelName: z.string().max(200),
        /** Why it cannot be handed to a phone (subscription login, protocol, custom headers). */
        unavailable: z.enum(["subscription", "protocol", "headers", "no_key", "cloud"]).optional(),
        selected: z.boolean(),
        delivered: z.boolean(),
      }),
    )
    .max(OFFLINE_MAX_VIEW_MODELS),
  bots: z
    .array(
      z.strictObject({
        botId: IdSchema,
        name: label,
        offline: z.boolean(),
        modelName: label.nullable(),
      }),
    )
    .max(OFFLINE_MAX_BOTS),
  /** Selected models whose key has not been delivered yet. */
  pending: z.boolean(),
});
export const OfflineMethods = {
  // Phone sessions only (the phone gateway answers them; no desktop renderer handler).
  "remote.offline.manifest": {
    params: z.strictObject({
      ifVersion: version.optional(),
      keys: z.array(z.strictObject({ grantId: IdSchema, digest: version })).max(OFFLINE_MAX_MODELS),
    }),
    result: z.strictObject({
      version,
      manifest: OfflineManifestSchema.optional(),
      keys: z.array(OfflineKeyDeliverySchema).max(OFFLINE_MAX_MODELS),
    }),
  },
  "remote.offline.snapshot": {
    params: z.strictObject({ botId: IdSchema }),
    result: OfflineSnapshotSchema,
  },
  "remote.offline.upload": {
    timeoutMs: 60_000,
    params: OfflineUploadSchema,
    result: OfflineUploadReceiptSchema,
  },
  // The computer's own settings page.
  "remote.offline.get": {
    params: z.strictObject({ deviceId: IdSchema }),
    result: OfflineDeviceViewSchema,
  },
  "remote.offline.set": {
    // Maintainers 2026-11-12: models and keys follow the Bots automatically; only Bots are switched.
    params: z.strictObject({
      deviceId: IdSchema,
      bot: z.strictObject({ botId: IdSchema, offline: z.boolean() }),
    }),
    result: OfflineDeviceViewSchema,
  },
} as const;
export const OfflineEvents = {
  /** To a phone: pull the manifest again; `clear` = drop everything offline for this computer. */
  "remote.offline.changed": z.strictObject({ clear: z.literal(true).optional() }),
} as const;
export type OfflineModel = z.infer<typeof OfflineModelSchema>;
export type OfflineBot = z.infer<typeof OfflineBotSchema>;
export type OfflineManifest = z.infer<typeof OfflineManifestSchema>;
export type OfflineSnapshot = z.infer<typeof OfflineSnapshotSchema>;
export type OfflineUpload = z.infer<typeof OfflineUploadSchema>;
export type OfflineMessage = z.infer<typeof OfflineMessageSchema>;
export type OfflineAudit = z.infer<typeof OfflineAuditSchema>;
export type OfflineMemoryProposal = z.infer<typeof OfflineMemoryProposalSchema>;
export type OfflineEgress = z.infer<typeof OfflineEgressSchema>;
export type OfflineUsage = z.infer<typeof OfflineUsageSchema>;
export type OfflineDeviceView = z.infer<typeof OfflineDeviceViewSchema>;

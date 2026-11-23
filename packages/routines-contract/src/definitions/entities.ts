import {
  AbsolutePathSchema,
  CanonicalTimeSchema,
  GithubTriggerSchema,
  GithubTriggerStateSchema,
  RoutinePreauthInputSchema,
  RoutinePreauthSchema,
  SessionFileSchema,
  TimezoneSchema,
} from "@pibot/protocol-base";
import { z } from "zod";
import { RoutineWaitCheckpointSchema } from "../runs/checkpoint.ts";
import { KeepAwakeStatusSchema, PowerSupplySchema } from "../runs/runtime.ts";
import {
  CalendarTriggerSchema,
  CalendarTriggerStateSchema,
  ConnectionTriggerSchema,
  ConnectionTriggerStateSchema,
} from "./app-triggers.ts";
import { OnceTimeInputSchema } from "./once.ts";

export * from "@pibot/protocol-base";

import {
  FilenamePatternSchema,
  IdSchema,
  PageSchema,
  WorkflowBindingSchema,
} from "@pibot/protocol-base";

// Calendar semantics and minimum interval belong to scheduler; the boundary rejects malformed syntax.
export const CronExpressionSchema = z
  .string()
  .trim()
  .max(200)
  .refine(
    (v) => v.split(/\s+/).length === 5 && /^[\d*,/\-\s]+$/.test(v),
    "Expected five numeric cron fields",
  );
export const OnceTriggerSchema = z.strictObject({
  kind: z.literal("once"),
  at: CanonicalTimeSchema,
  timezone: TimezoneSchema,
});
export const RoutineTriggerInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("cron"), expr: CronExpressionSchema, timezone: TimezoneSchema }),
  z.strictObject({
    kind: z.literal("folder"),
    path: AbsolutePathSchema,
    events: z.enum(["new", "new_and_changed"]).default("new"),
    pattern: FilenamePatternSchema.default("*"),
    recursive: z.boolean().default(false),
    cooldownMin: z.number().int().min(1).max(60).default(5),
  }),
  OnceTriggerSchema,
  ConnectionTriggerSchema,
  CalendarTriggerSchema,
  /** Retired. Readable so the person is told to re-pick; the brain refuses to save it. */
  GithubTriggerSchema,
]);
export const RoutineWorkplaceSchema = z.discriminatedUnion("kind", [
  /** @deprecated "follow the Bot's current folder"; saving a routine replaces it. */
  z.strictObject({ kind: z.literal("bot") }),
  // The routine's own primary (writable) folder plus read-only references.
  z.strictObject({
    kind: z.literal("folder"),
    folderId: z.union([z.literal("home"), IdSchema]),
    readonly: z.array(IdSchema).max(32).optional(),
    /**
     * Where commands start when that is not the primary: only migration 0027 writes it, for a
     * routine whose old folder choice was a read-only working directory (it stays read-only).
     */
    cwd: z.union([z.literal("home"), IdSchema]).optional(),
  }),
]);
/**
 * A folder inside the routine's primary folder, written relative to it with "/" between
 * names. Anything that could leave the primary (absolute, drive letters, "..", empty names) is
 * rejected here; the brain checks the resolved path against the real boundary again.
 */
export const RoutineOutputFolderSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (p) =>
      [...p].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127) &&
      !/[<>:"|?*\\]/.test(p) &&
      !p.startsWith("/") &&
      p.split("/").every((s) => s.trim() !== "" && s !== "." && s !== ".." && !/[. ]$/.test(s)),
    "Relative folder inside the primary folder required",
  );
/**
 * Artifact folders: each run writes into `<primary>/<folder>/<period>/` and the next period
 * reads the previous one. `folder: null` is the default `.pibot/out/<task name>`; `period: auto`
 * follows the trigger (monthly / weekly / daily cron, otherwise daily).
 */
export const RoutineOutputSchema = z.strictObject({
  enabled: z.boolean().default(true),
  folder: RoutineOutputFolderSchema.nullable().default(null),
  period: z.enum(["auto", "day", "week", "month"]).default("auto"),
});
export const RoutineOutputDefaults = Object.freeze(RoutineOutputSchema.parse({}));
export const RoutineSettingsSchema = z.strictObject({
  missedPolicy: z.enum(["catchup", "skip", "ask"]).default("catchup"),
  keepAwake: z.enum(["on_ac", "always", "never"]).default("on_ac"),
  pauseWhenAway: z.boolean().default(true),
});
export const RoutineTriggersInputSchema = z
  .array(RoutineTriggerInputSchema)
  .min(1)
  .max(32)
  .refine(
    (values) => !values.some((v) => v.kind === "once") || values.length === 1,
    "A once appointment must be the only trigger",
  );
const RoutineDraftObjectSchema = z.strictObject({
  botId: IdSchema,
  name: z.string().trim().min(1).max(40),
  // A bound workflow can run from its contract alone; otherwise ordinary instructions stay required.
  instructions: z.string().trim().max(4000),
  triggers: RoutineTriggersInputSchema,
  workplace: RoutineWorkplaceSchema.default({ kind: "bot" }),
  preauth: z.array(RoutinePreauthInputSchema).max(200).default([]),
  notify: z.enum(["always", "on_attention", "never"]).default("always"),
  maxDurationMin: z.number().int().min(5).max(120).default(30),
  carryLastResult: z.boolean().default(true),
  output: RoutineOutputSchema.default(RoutineOutputDefaults),
  /**
   * Run this workflow skill of the routine's Bot instead of free text (`instructions` are
   * then added as notes). Pre-checks run before every run; the run ledger and period folders apply.
   */
  workflow: WorkflowBindingSchema.nullable().default(null),
  missedPolicy: z.enum(["catchup", "skip", "ask"]).nullable().default(null),
  enabled: z.boolean().default(true),
});
export const RoutineDraftSchema = RoutineDraftObjectSchema.refine(
  (draft) => draft.workflow !== null || draft.instructions.length > 0,
  {
    path: ["instructions"],
    message: "Instructions required without workflow",
  },
);
// Zod defaults inside optional fields would turn an empty patch into a silent settings reset.
export const RoutinePartialDraftSchema = z
  .strictObject({
    botId: IdSchema,
    name: RoutineDraftObjectSchema.shape.name,
    instructions: RoutineDraftObjectSchema.shape.instructions,
    triggers: RoutineDraftObjectSchema.shape.triggers,
    workplace: RoutineWorkplaceSchema,
    preauth: z.array(RoutinePreauthInputSchema).max(200),
    notify: z.enum(["always", "on_attention", "never"]),
    maxDurationMin: z.number().int().min(5).max(120),
    carryLastResult: z.boolean(),
    // Always sent whole by the editor; a partial object fills the rest with the defaults.
    output: RoutineOutputSchema,
    workflow: WorkflowBindingSchema.nullable(),
    missedPolicy: z.enum(["catchup", "skip", "ask"]).nullable(),
    enabled: z.boolean(),
  })
  .partial();
export const RoutinePatchSchema = RoutinePartialDraftSchema.refine(
  (v) => Object.values(v).some((x) => x !== undefined),
  "Empty patch",
).refine((v) => v.instructions === undefined || v.instructions.length > 0 || v.workflow != null, {
  path: ["instructions"],
  message: "Instructions required without workflow",
});
export const RoutineSettingsPatchSchema = z
  .strictObject({
    missedPolicy: RoutineSettingsSchema.shape.missedPolicy.removeDefault(),
    keepAwake: RoutineSettingsSchema.shape.keepAwake.removeDefault(),
    pauseWhenAway: z.boolean(),
  })
  .partial();
export const FolderSnapshotEntrySchema = z.strictObject({
  relativePath: z
    .string()
    .min(1)
    .max(32768)
    .refine(
      (p) =>
        !/[\0\r\n]/.test(p) &&
        !p.startsWith("/") &&
        !/^[A-Za-z]:/.test(p) &&
        !p.split(/[\\/]/).some((s) => s === ".." || s === "." || s === ""),
    ),
  size: z.number().int().nonnegative().safe(),
  mtimeMs: z.number().nonnegative().finite(),
});
export const FolderSnapshotSchema = z
  .strictObject({
    entries: z.array(FolderSnapshotEntrySchema).max(10000),
    at: CanonicalTimeSchema,
    complete: z.boolean(),
  })
  .refine((s) => new Set(s.entries.map((e) => e.relativePath)).size === s.entries.length);
export const RoutineTriggerStateSchema = z.strictObject({
  github: GithubTriggerStateSchema.optional(),
  connection: ConnectionTriggerStateSchema.optional(),
  calendar: CalendarTriggerStateSchema.optional(),
  consumedAt: CanonicalTimeSchema.nullable().optional(),
  snapshot: FolderSnapshotSchema.optional(),
  lastScheduledAt: CanonicalTimeSchema.nullable().optional(),
  lastTriggeredAt: CanonicalTimeSchema.nullable().optional(),
  pendingPaths: z.array(AbsolutePathSchema).max(50).optional(),
  pendingCount: z.number().int().nonnegative().safe().optional(),
  folderBatchId: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export const RoutineTriggerSchema = z.strictObject({
  id: IdSchema,
  routineId: IdSchema,
  config: RoutineTriggerInputSchema,
  state: RoutineTriggerStateSchema,
  createdAt: CanonicalTimeSchema,
});
export const RoutineSchema = RoutineDraftObjectSchema.omit({
  triggers: true,
  preauth: true,
}).extend({
  id: IdSchema,
  triggers: z.array(RoutineTriggerSchema).max(32),
  preauth: z.array(RoutinePreauthSchema).max(200),
  /** Display/dispatch failure only; never authority and never persisted as consent. */
  authorizationError: z.literal("routine_preauth_reauthorization_required").optional(),
  pausedReason: z.enum(["away_7d", "bot_archived", "trigger_error"]).nullable(),
  lastScheduledAt: CanonicalTimeSchema.nullable(),
  topicConversationId: IdSchema,
  createdAt: CanonicalTimeSchema,
  updatedAt: CanonicalTimeSchema,
  deletedAt: CanonicalTimeSchema.nullable(),
  version: z.number().int().positive().safe(),
});
export const RoutineRunStatusSchema = z.enum([
  "scheduled",
  "running",
  "waiting",
  "done",
  "failed",
  "cancelled",
  "timeout",
  "missed",
  "skipped_overlap",
  "skipped_missed",
]);
export const RoutineRunRecordSchema = z.strictObject({
  id: IdSchema,
  routineId: IdSchema.nullable(),
  botId: IdSchema,
  triggerId: IdSchema.nullable(),
  reason: z.enum([
    "cron",
    "folder",
    "once",
    "github",
    "connection",
    "calendar",
    "manual",
    "trial",
    "catchup",
  ]),
  scheduledFor: CanonicalTimeSchema,
  queuedAt: CanonicalTimeSchema.nullable(),
  queueExpiresAt: CanonicalTimeSchema.nullable(),
  maxDurationMin: z.number().int().min(5).max(120),
  startedAt: CanonicalTimeSchema.nullable(),
  finishedAt: CanonicalTimeSchema.nullable(),
  status: RoutineRunStatusSchema,
  runId: IdSchema.nullable(),
  conversationId: IdSchema.nullable(),
  triggerMessageId: IdSchema.nullable(),
  errorCode: z.string().max(100).nullable(),
  summary: z.string().max(2000).nullable(),
  /** Set by the run itself (routine_flag_attention): why the user should look at the result. */
  attentionReason: z.string().min(1).max(200).nullable().optional(),
  /** The failed / interrupted run this one continues (same occurrence, same period). */
  resumeOf: IdSchema.nullable().optional(),
  /** The first run of this occurrence; null means the run is its own occurrence. */
  occurrenceId: IdSchema.nullable().optional(),
  /** The output period this run writes (e.g. 2026-10-22, 2026-W43, 2026-10). */
  periodKey: z.string().min(1).max(40).nullable().optional(),
  allowedOps: z.array(RoutinePreauthInputSchema).max(200),
  trialDraft: RoutineDraftSchema.nullable(),
  dedupeKey: z.string().min(1).max(1024),
  activeMs: z.number().int().nonnegative().safe(),
  waitingMs: z.number().int().nonnegative().safe(),
  activeSince: CanonicalTimeSchema.nullable(),
  waitingSince: CanonicalTimeSchema.nullable(),
  waitExpiresAt: CanonicalTimeSchema.nullable(),
  ownerToken: IdSchema.nullable(),
  sessionFile: SessionFileSchema.nullable(),
  attempt: z.number().int().nonnegative().safe(),
  waitCheckpoint: RoutineWaitCheckpointSchema.nullable(),
  decisionConsumedAt: CanonicalTimeSchema.nullable(),
  createdAt: CanonicalTimeSchema,
});
export const RoutineRunSchema = RoutineRunRecordSchema.refine((r) =>
  r.reason === "trial"
    ? r.routineId === null && r.trialDraft !== null
    : r.routineId !== null && r.trialDraft === null,
);
// Execution ownership, SDK paths and unconfirmed draft content never cross into renderer.
export const RoutineRunViewSchema = RoutineRunRecordSchema.omit({
  ownerToken: true,
  sessionFile: true,
  trialDraft: true,
  dedupeKey: true,
  attempt: true,
  waitCheckpoint: true,
  decisionConsumedAt: true,
});
export const RoutineProposalPayloadSchema = z.strictObject({
  routineId: IdSchema.optional(),
  draft: RoutinePartialDraftSchema,
  /** Frozen on acceptance: later routine edits must not rewrite this confirmation's receipt. */
  acceptedDraft: RoutineDraftSchema.optional(),
  missingFields: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(200)
        .refine((v) => !["__proto__", "constructor", "prototype"].includes(v)),
    )
    .max(20)
    .default([]),
  expectedVersion: z.number().int().positive().optional(),
  questions: z.array(z.string().max(500)).max(20).optional(),
  onceRequest: OnceTimeInputSchema.optional(),
  blockedPreauth: z
    .array(
      z.strictObject({
        operation: RoutinePreauthInputSchema,
        reason: z.enum(["permission_ceiling", "invalid_scope"]),
      }),
    )
    .max(200)
    .default([]),
});
export const RoutineProposalSchema = z.strictObject({
  id: IdSchema,
  botId: IdSchema,
  messageId: IdSchema.nullable(),
  payload: RoutineProposalPayloadSchema,
  status: z.enum(["open", "accepted", "declined", "expired"]),
  resolvedRoutineId: IdSchema.nullable(),
  dedupeKey: z.string().min(1).max(1024),
  createdAt: CanonicalTimeSchema,
  resolvedAt: CanonicalTimeSchema.nullable(),
});
export const PowerStateSchema = z.strictObject({
  state: z.enum(["awake", "resuming", "suspended"]),
  supply: PowerSupplySchema,
  keepAwake: KeepAwakeStatusSchema,
  at: CanonicalTimeSchema,
});
export const RoutineListQuerySchema = PageSchema.extend({
  botId: IdSchema.optional(),
  includeDeleted: z.boolean().optional(),
});
export type Routine = z.infer<typeof RoutineSchema>;
export type RoutineDraft = z.output<typeof RoutineDraftSchema>;
export type RoutineDraftInput = z.input<typeof RoutineDraftSchema>;
export type RoutinePatch = z.input<typeof RoutinePatchSchema>;
export type RoutineTrigger = z.infer<typeof RoutineTriggerSchema>;
export type RoutineTriggerState = z.infer<typeof RoutineTriggerStateSchema>;
export type RoutineRun = z.infer<typeof RoutineRunSchema>;
export type RoutineRunStatus = z.infer<typeof RoutineRunStatusSchema>;
export type RoutineProposal = z.infer<typeof RoutineProposalSchema>;
export type RoutineSettings = z.output<typeof RoutineSettingsSchema>;
export type RoutineOutput = z.output<typeof RoutineOutputSchema>;

export function toRoutineRunView(run: RoutineRun) {
  return RoutineRunViewSchema.strip().parse(run);
}

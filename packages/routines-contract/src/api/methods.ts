import {
  AbsolutePathSchema,
  ActivityCountQuerySchema,
  ConnectionCheckIdSchema,
  IdSchema,
  PageSchema,
} from "@pibot/protocol-base";
import { z } from "zod";
import {
  CanonicalTimeSchema,
  PowerEventSchema,
  PowerStateSchema,
  RoutineDraftSchema,
  RoutineListQuerySchema,
  RoutinePartialDraftSchema,
  RoutinePatchSchema,
  RoutinePreauthSchema,
  RoutineProposalSchema,
  RoutineRunSchema,
  RoutineRunViewSchema,
  RoutineSchema,
  RoutineSettingsPatchSchema,
  RoutineSettingsSchema,
  TimezoneSchema,
} from "../definitions/entities.ts";
import { OnceTimeInputSchema, OnceTimeResultSchema } from "../definitions/once.ts";
import { RoutineHistoryQuerySchema, RoutineHistoryViewSchema } from "../runs/history.ts";
import { RoutineRunLedgerSchema } from "../runs/ledger.ts";
import {
  BackgroundStateSchema,
  KeepAwakeLeaseSchema,
  KeepAwakeRequestSchema,
  KeepAwakeStatusSchema,
  PowerSupplySchema,
  RoutineCountsSchema,
  RoutineNextSchema,
  RoutineSummarySchema,
} from "../runs/runtime.ts";
import {
  PowerContextSchema,
  RoutinePlannedCursorSchema,
  RoutinePlannedPageSchema,
  RoutineRowsSchema,
} from "../views/display.ts";

const noParams = z.union([z.undefined(), z.strictObject({})]);
const id = z.strictObject({ id: IdSchema });
const ok = z.strictObject({ ok: z.literal(true) });
const runId = z.strictObject({ runId: IdSchema });
const page = PageSchema;
export const TrayUpdateSchema = z.strictObject({
  next: RoutineNextSchema.nullable(),
  counts: RoutineCountsSchema,
  running: z
    .array(
      z.strictObject({
        routineId: IdSchema.nullable(),
        routineRunId: IdSchema,
        runId: IdSchema,
        status: z.enum(["running", "waiting"]),
        botId: IdSchema,
        name: z.string().min(1).max(40),
        conversationId: IdSchema.nullable(),
      }),
    )
    .max(20),
  pausedUntil: CanonicalTimeSchema.nullable(),
});
/**
 * "Until I resume" (tray menu, 2026-10-28) is this far deadline rather than a second flag, so the
 * existing pause path keeps doing everything: one settings row that survives restarts, the same
 * per-routine audit entries, every scheduler check that treats any deadline as paused. The tick
 * never reaches it, so only a resume clears it.
 */
export const INDEFINITE_PAUSE_UNTIL = "9999-12-31T23:59:59.999Z";
/**
 * The one check every view (desktop, Bot profile, tray, phone) uses before printing a pause
 * deadline, so none of them shows the year 9999. Any deadline from year 9000 on counts: another
 * client may have written a different far date, and the phone reads the value leniently, so
 * this takes any string and treats an unparsable one as an ordinary (not indefinite) deadline.
 */
export function isIndefinitePause(until: string | null | undefined): boolean {
  if (!until) return false;
  const at = Date.parse(until);
  return Number.isFinite(at) && new Date(at).getUTCFullYear() >= 9000;
}
export const RoutineControlSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("power-event"),
    event: PowerEventSchema,
    supply: PowerSupplySchema,
  }),
  z.strictObject({
    type: z.literal("power-snapshot"),
    supply: PowerSupplySchema,
    keepAwake: KeepAwakeStatusSchema,
    at: CanonicalTimeSchema,
  }),
  z.strictObject({ type: z.literal("ui-active"), at: CanonicalTimeSchema }),
  z.strictObject({ type: z.literal("routines-pause"), until: CanonicalTimeSchema }),
  z.strictObject({ type: z.literal("routines-resume") }),
]);
export const RoutineMethods = {
  "routines.validateCron": {
    params: z.strictObject({ expr: z.string().max(200), timezone: z.string().min(1).max(200) }),
    result: z.strictObject({
      minimumMinutes: z.number().positive(),
      issue: z
        .enum(["syntax", "minute", "hour", "day", "month", "weekday", "minimum", "timezone"])
        .nullable(),
    }),
  },
  "routines.resolveOnceTime": { params: OnceTimeInputSchema, result: OnceTimeResultSchema },
  "routines.rows": {
    params: z.strictObject({
      ids: z
        .array(IdSchema)
        .min(1)
        .max(200)
        .refine((ids) => new Set(ids).size === ids.length),
    }),
    result: RoutineRowsSchema,
  },
  "routines.planned": {
    params: z.strictObject({
      date: z.iso.date(),
      timezone: TimezoneSchema,
      cursor: RoutinePlannedCursorSchema.optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    result: RoutinePlannedPageSchema,
  },
  "routines.pickFolder": { params: noParams, result: AbsolutePathSchema.nullable() },
  /**
   * What the trigger editor can offer this Bot: each visible connection with the preset
   * checks its read-only tools support (none means "no ready-made check yet"), and the local
   * calendar connections it can read. Reads only the local catalog; never calls a connection.
   */
  "routines.triggerSources": {
    params: z.strictObject({ botId: IdSchema }),
    result: z.strictObject({
      connections: z
        .array(
          z.strictObject({
            connectorId: IdSchema,
            name: z.string().max(500),
            checks: z.array(ConnectionCheckIdSchema).max(10),
          }),
        )
        .max(200),
      calendars: z
        .array(z.strictObject({ connectorId: IdSchema, name: z.string().max(500) }))
        .max(10),
      /**
       * Connections this Bot sees that a routine can't check on its own yet, with why: the
       * connection asks every time, isn't running, has no read-only tool, or the Bot may never
       * use connections.
       */
      blocked: z
        .array(
          z.strictObject({
            connectorId: IdSchema,
            name: z.string().max(500),
            reason: z.enum(["ask", "not_running", "permission", "no_read"]),
          }),
        )
        .max(200)
        .default([]),
    }),
  },
  /** The calendars a calendar trigger can watch (one audited read-only call). */
  "routines.calendarList": {
    params: z.strictObject({ botId: IdSchema, connectorId: IdSchema }),
    result: z.strictObject({
      items: z
        .array(z.strictObject({ id: z.string().min(1).max(4096), title: z.string().max(512) }))
        .max(100),
    }),
  },
  "routines.summary": { params: noParams, result: RoutineSummarySchema },
  "routines.list": { params: RoutineListQuerySchema, result: z.array(RoutineSchema).max(200) },
  "routines.get": { params: id, result: RoutineSchema },
  "routines.create": {
    // A trial run of this draft (from the same editor) whose conversation becomes the task's topic,
    // so a task has one topic for all its runs (maintainers 2026-10-21).
    params: RoutineDraftSchema.safeExtend({ trialRunId: IdSchema.optional() }),
    result: RoutineSchema,
  },
  "routines.update": {
    params: id.extend({ patch: RoutinePatchSchema, expectedVersion: z.number().int().positive() }),
    result: RoutineSchema,
  },
  "routines.delete": { params: id, result: ok },
  "routines.setEnabled": { params: id.extend({ enabled: z.boolean() }), result: RoutineSchema },
  // runId is the real routine_runs ID; the subsequent event also exposes the linked execution runId.
  "routines.runNow": { params: id, result: runId },
  "routines.trialRun": { params: RoutineDraftSchema, result: runId },
  "routines.trialResult": { params: runId, result: RoutineRunViewSchema },
  // Id is the routine_runs ID; the result holds facts only (paths, sizes, hashes, states).
  "routines.runLedger": { params: id, result: RoutineRunLedgerSchema },
  // Continue a failed / timed-out / stopped run as the same occurrence (one resume per run).
  "routines.resumeRun": { params: id, result: runId },
  "routines.runs": {
    params: id.extend(page.shape),
    result: z.array(RoutineRunViewSchema).max(200),
  },
  "routines.history": {
    params: RoutineHistoryQuerySchema,
    result: z.array(RoutineHistoryViewSchema).max(200),
  },
  "routines.history.count": {
    params: ActivityCountQuerySchema.pick({ botId: true, from: true }),
    result: z.number().int().nonnegative().safe(),
  },
  "routines.settings.get": { params: noParams, result: RoutineSettingsSchema },
  "routines.settings.set": {
    params: RoutineSettingsPatchSchema,
    result: RoutineSettingsSchema,
  },
  "routines.proposals": {
    params: page.extend({
      botId: IdSchema.optional(),
      messageId: IdSchema.optional(),
      id: IdSchema.optional(),
    }),
    result: z.array(RoutineProposalSchema).max(200),
  },
  "routines.proposal.resolve": {
    params: z.strictObject({
      proposalId: IdSchema,
      accept: z.boolean(),
      edits: RoutinePartialDraftSchema.optional(),
      answers: z
        .record(z.string().min(1).max(200), z.string().trim().min(1).max(1000))
        .refine((v) => Object.keys(v).length <= 20)
        .optional(),
    }),
    result: z.strictObject({ proposal: RoutineProposalSchema, routine: RoutineSchema.nullable() }),
  },
  "routines.preauth.list": {
    params: page.extend({ routineId: IdSchema.optional(), botId: IdSchema.optional() }),
    result: z.array(RoutinePreauthSchema).max(200),
  },
  "routines.preauth.revoke": { params: id, result: ok },
  "routines.pauseAll": { params: z.strictObject({ until: CanonicalTimeSchema }), result: ok },
  "routines.resumeAll": { params: noParams, result: ok },
  "routines.resumeAway": {
    params: z.strictObject({ ids: z.array(IdSchema).min(1).max(200).optional() }),
    result: ok,
  },
  "routines.missed.resolve": {
    params: z.strictObject({
      runId: IdSchema,
      action: z.enum(["catchup", "skip"]),
      missedPolicy: RoutineSettingsSchema.shape.missedPolicy.removeDefault().optional(),
    }),
    result: RoutineRunViewSchema,
  },
  "routines.timeline": {
    params: page.extend({
      date: z.iso.date(),
      timezone: TimezoneSchema,
      source: z.enum(["power", "runs"]),
    }),
    result: z.discriminatedUnion("source", [
      z.strictObject({
        source: z.literal("power"),
        events: z.array(PowerEventSchema).max(200),
        context: PowerContextSchema,
      }),
      z.strictObject({ source: z.literal("runs"), runs: z.array(RoutineRunViewSchema).max(200) }),
    ]),
  },
} as const;
export const RoutineEvents = {
  "routines.changed": z.strictObject({
    id: IdSchema.optional(),
    botId: IdSchema.optional(),
    proposalId: IdSchema.optional(),
    messageId: IdSchema.optional(),
  }),
  "routine.run": z.strictObject({
    routineId: IdSchema.nullable(),
    routineRunId: IdSchema,
    runId: IdSchema.nullable(),
    botId: IdSchema,
    status: RoutineRunSchema.shape.status,
    conversationId: IdSchema.nullable(),
    messageId: IdSchema.nullable(),
  }),
  "power.state": PowerStateSchema,
} as const;
export const RoutineHostMethods = {
  "host.keepAwake": {
    params: KeepAwakeRequestSchema,
    result: KeepAwakeLeaseSchema,
  },
  "host.backgroundState": { params: noParams, result: BackgroundStateSchema },
  "tray.update": { params: TrayUpdateSchema, result: z.null() },
} as const;

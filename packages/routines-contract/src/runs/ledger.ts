import { AbsolutePathSchema, CanonicalTimeSchema, IdSchema } from "@pibot/protocol-base";
import { z } from "zod";

/**
 * Run ledger: a small structured record of one routine run, kept apart from the chat
 * transcript. Facts only (paths, sizes, hashes, delivery states); never file content or message
 * bodies, so it can be shown to the user and handed to the next run.
 */
export const RoutineLedgerFileSchema = z.strictObject({
  path: AbsolutePathSchema,
  size: z.number().int().nonnegative().safe(),
  /** Hex SHA-256; null when the file was too large to hash or only listed (size + time). */
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  mtimeMs: z.number().nonnegative().finite().optional(),
});
export const RoutineLedgerInputSchema = z.discriminatedUnion("kind", [
  /** A file a folder trigger reported for this run. */
  z.strictObject({ kind: z.literal("trigger_file"), file: RoutineLedgerFileSchema }),
  /** A file already in this period's folder when the run started (a resume or second run). */
  z.strictObject({ kind: z.literal("existing_output"), file: RoutineLedgerFileSchema }),
  /** The previous period's manifest this run received to compare with. */
  z.strictObject({
    kind: z.literal("previous_period"),
    runId: IdSchema,
    periodKey: z.string().min(1).max(40),
    folder: AbsolutePathSchema,
    files: z.number().int().nonnegative().safe(),
  }),
  /** GitHub events a GitHub trigger reported for this run. */
  z.strictObject({ kind: z.literal("github_events"), count: z.number().int().nonnegative() }),
  /** New items a connection check found (the items themselves are not kept). */
  z.strictObject({ kind: z.literal("connection_items"), count: z.number().int().nonnegative() }),
  /** Calendar events a calendar trigger fired for. */
  z.strictObject({ kind: z.literal("calendar_events"), count: z.number().int().nonnegative() }),
]);
export const RoutineLedgerDeliverySchema = z.enum([
  // A draft exists in an earlier or this attempt and is still waiting, sending or done.
  "pending",
  "sending",
  "sent",
  "unknown",
  // Definitely not delivered: a later attempt may send it again.
  "failed",
  "discarded",
  "expired",
  // Intended but no draft was ever created (denied before, or the run stopped first).
  "none",
  // Not sent because an earlier attempt of this occurrence already covers this send.
  "duplicate",
]);
export const RoutineLedgerSendSchema = z.strictObject({
  key: z.string().regex(/^[0-9a-f]{32}$/),
  connectorId: IdSchema,
  tool: z.string().min(1).max(200),
  target: z.string().max(500),
  contentDigest: z.string().min(1).max(200),
  /** The n-th send to the same connector tool and target within one attempt (0-based). */
  ordinal: z.number().int().nonnegative().max(1000),
  approvalId: IdSchema.nullable(),
  duplicateOf: IdSchema.nullable(),
  delivery: RoutineLedgerDeliverySchema,
  at: CanonicalTimeSchema,
});
export const RoutineLedgerOutputSkipSchema = z.enum([
  "disabled",
  "trial",
  "outside_primary",
  "readonly",
  "unavailable",
]);
export const RoutineRunLedgerSchema = z.strictObject({
  routineRunId: IdSchema,
  occurrenceId: IdSchema,
  /** Every attempt of this occurrence, oldest first (this run included). */
  attempts: z.array(IdSchema).max(50),
  periodKey: z.string().min(1).max(40).nullable(),
  outputFolder: AbsolutePathSchema.nullable(),
  outputSkipped: RoutineLedgerOutputSkipSchema.nullable(),
  /** The saved Bot folder was stale and this run used the Bot home instead. */
  workplaceFallback: z.boolean().optional(),
  inputs: z.array(RoutineLedgerInputSchema).max(200),
  outputs: z.array(RoutineLedgerFileSchema).max(400),
  sends: z.array(RoutineLedgerSendSchema).max(200),
});
export type RoutineLedgerFile = z.infer<typeof RoutineLedgerFileSchema>;
export type RoutineLedgerInput = z.infer<typeof RoutineLedgerInputSchema>;
export type RoutineLedgerSend = z.infer<typeof RoutineLedgerSendSchema>;
export type RoutineLedgerDelivery = z.infer<typeof RoutineLedgerDeliverySchema>;
export type RoutineLedgerOutputSkip = z.infer<typeof RoutineLedgerOutputSkipSchema>;
export type RoutineRunLedger = z.infer<typeof RoutineRunLedgerSchema>;

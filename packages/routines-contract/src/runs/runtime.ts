// Subpath: the desktop preload imports this module; the root evaluates every schema.
import { CanonicalTimeSchema, IdSchema } from "@pibot/protocol-base/desktop-bridge";
import { z } from "zod";

export const PowerSupplySchema = z.enum(["ac", "battery", "unknown"]);
export const KeepAwakeStatusSchema = z.enum(["requested", "unsupported", "off"]);
export const KeepAwakeRequestSchema = z.strictObject({
  mode: z.enum(["on_ac", "always", "never"]),
  reason: z.enum(["upcoming", "running", "waiting", "none"]),
  leaseId: IdSchema,
  leaseMs: z.number().int().min(1000).max(1800000),
});
export const KeepAwakeLeaseSchema = z
  .strictObject({
    status: KeepAwakeStatusSchema,
    leaseId: IdSchema,
    expiresAt: CanonicalTimeSchema.nullable(),
  })
  .refine((v) => (v.status === "requested") === (v.expiresAt !== null));
export const BackgroundStateSchema = z.strictObject({
  state: z.enum(["starting", "ready", "restarting", "failed", "stopped"]),
  startedAt: CanonicalTimeSchema.nullable(),
  uptimeMs: z.number().int().nonnegative().safe(),
  restartCount: z.number().int().nonnegative().safe(),
  at: CanonicalTimeSchema,
});
export const RoutineCountsSchema = z.strictObject({
  enabled: z.number().int().nonnegative().safe(),
  awayPaused: z.number().int().nonnegative().safe(),
  scheduled: z.number().int().nonnegative().safe(),
  running: z.number().int().nonnegative().safe(),
  waiting: z.number().int().nonnegative().safe(),
});
export const RoutineNextSchema = z.strictObject({
  routineId: IdSchema,
  name: z.string().min(1).max(40),
  at: CanonicalTimeSchema,
  conversationId: IdSchema,
});
export const RoutineSummarySchema = z.strictObject({
  counts: RoutineCountsSchema,
  next: RoutineNextSchema.nullable(),
  pausedUntil: CanonicalTimeSchema.nullable(),
  background: BackgroundStateSchema,
  at: CanonicalTimeSchema,
});
const milliseconds = (min: number, max: number) => z.number().int().safe().min(min).max(max);
// No defaults: constructing a full production timing object is separate from applying a dev patch.
export const RoutineTimingSchema = z.strictObject({
  cronMinIntervalMs: milliseconds(60000, 86400000),
  approvalWaitMs: milliseconds(1000, 86400000),
  awayAfterMs: milliseconds(10000, 604800000),
  awayCheckMs: milliseconds(1000, 3600000),
  missedMaxAgeMs: milliseconds(1000, 86400000),
  resumeGraceMs: milliseconds(100, 60000),
  queueWaitMs: milliseconds(1000, 1800000),
  waitingKeepAwakeMs: milliseconds(1000, 1800000),
});
export const RoutineTimingDefaults = Object.freeze(
  RoutineTimingSchema.parse({
    cronMinIntervalMs: 300000,
    approvalWaitMs: 86400000,
    awayAfterMs: 604800000,
    awayCheckMs: 3600000,
    missedMaxAgeMs: 86400000,
    resumeGraceMs: 60000,
    queueWaitMs: 1800000,
    waitingKeepAwakeMs: 1800000,
  }),
);
export const RoutineTimingPatchSchema = RoutineTimingSchema.partial().refine((p) =>
  Object.values(p).some((v) => v !== undefined),
);
// Separate trusted dev channel only; not spread into BrainControl or renderer Methods.
export const RoutineDevControlSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("dev-routine-timing"), patch: RoutineTimingPatchSchema }),
  z.strictObject({
    type: z.literal("dev-power"),
    supply: PowerSupplySchema,
    event: z
      .enum(["suspend", "resume", "on-ac", "on-battery", "lock-screen", "unlock-screen"])
      .optional(),
    at: CanonicalTimeSchema,
  }),
  z.strictObject({ type: z.literal("dev-ui-active"), lastActiveAt: CanonicalTimeSchema }),
  z.strictObject({ type: z.literal("dev-check-away") }),
]);
export type RoutineTiming = z.infer<typeof RoutineTimingSchema>;
export type RoutineDevControl = z.infer<typeof RoutineDevControlSchema>;

// Renderer -> main bridge, separate from brain RPC so restart acknowledgement survives child exit.
export const DesktopBackgroundMethods = {
  "background.state": {
    params: z.union([z.undefined(), z.strictObject({})]),
    result: BackgroundStateSchema,
  },
  "background.restart": {
    params: z.union([z.undefined(), z.strictObject({})]),
    result: z.strictObject({ status: z.literal("requested") }),
  },
} as const;
export type BackgroundState = z.infer<typeof BackgroundStateSchema>;
export type DesktopBackgroundMethod = keyof typeof DesktopBackgroundMethods;
export type DesktopBackgroundParams = {
  [K in DesktopBackgroundMethod]: z.input<(typeof DesktopBackgroundMethods)[K]["params"]>;
};
export type DesktopBackgroundResults = {
  [K in DesktopBackgroundMethod]: z.output<(typeof DesktopBackgroundMethods)[K]["result"]>;
};

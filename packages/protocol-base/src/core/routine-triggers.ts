import { z } from "zod";
import { CanonicalTimeSchema } from "./boundaries.ts";
import { IdSchema } from "./ids.ts";

/**
 * GitHub triggers are retired in favour of "a connection has something new". Rows saved
 * before stay readable so the editor and list can tell the person to pick the new trigger; the
 * routines brain refuses to save one, and migration 0116 paused every routine that had one.
 */
export const GithubTriggerSchema = z.strictObject({
  kind: z.literal("github"),
  connectorId: IdSchema,
  repository: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    .max(201)
    .refine((value) => value.split("/").every((part) => part !== "." && part !== "..")),
  event: z.enum(["issue", "pull_request", "mention"]),
});
export const GithubTriggerStateSchema = z.strictObject({
  startedAt: z.iso.datetime().optional(),
  since: z.iso.datetime(),
  lastPolledAt: z.iso.datetime().optional(),
  seen: z.array(z.string().min(1).max(240)).max(500).default([]),
});
export const GithubTriggerEventSchema = z.strictObject({
  id: z.string().min(1).max(240),
  title: z.string().max(1000),
  url: z.url({ protocol: /^https$/ }).refine((value) => new URL(value).hostname === "github.com"),
  at: z.iso.datetime(),
});
/** Trigger data of runs started by a GitHub trigger before it was retired (history only). */
export const GithubTriggerMessageSchema = z.strictObject({
  repository: GithubTriggerSchema.shape.repository,
  event: GithubTriggerSchema.shape.event,
  events: z.array(GithubTriggerEventSchema).max(50),
  total: z.number().int().nonnegative().safe(),
});
export type GithubTrigger = z.infer<typeof GithubTriggerSchema>;
export type GithubTriggerState = z.infer<typeof GithubTriggerStateSchema>;
export type GithubTriggerEvent = z.infer<typeof GithubTriggerEventSchema>;

/** The preset checks a "connection has something new" trigger can run. */
export const ConnectionCheckIdSchema = z.enum(["github.assigned_issues", "github.pr_comments"]);
export type ConnectionCheckId = z.infer<typeof ConnectionCheckIdSchema>;
/**
 * What a connection trigger tells the run. Only how many items changed: the check stores a
 * fingerprint, never the result, and the run reads the connection itself for the details.
 */
export const ConnectionTriggerMessageSchema = z.strictObject({
  connectorName: z.string().max(200),
  check: ConnectionCheckIdSchema,
  changed: z.number().int().nonnegative().safe(),
});
export const CalendarTriggerEventSchema = z.strictObject({
  title: z.string().max(512),
  start: CanonicalTimeSchema,
  end: CanonicalTimeSchema.nullable(),
  calendarName: z.string().max(512),
  allDay: z.boolean(),
});
/** The events a calendar trigger fired for; the run is about these events. */
export const CalendarTriggerMessageSchema = z.strictObject({
  event: z.enum(["before_start", "new_event"]),
  minutesBefore: z.number().int().min(1).max(1440).optional(),
  events: z.array(CalendarTriggerEventSchema).max(20),
  total: z.number().int().nonnegative().safe(),
});
export type ConnectionTriggerMessage = z.infer<typeof ConnectionTriggerMessageSchema>;
export type CalendarTriggerMessage = z.infer<typeof CalendarTriggerMessageSchema>;
export type CalendarTriggerEvent = z.infer<typeof CalendarTriggerEventSchema>;

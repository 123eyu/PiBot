import { CanonicalTimeSchema, ConnectionCheckIdSchema, IdSchema } from "@pibot/protocol-base";
import { z } from "zod";

/**
 * "a connection has something new". The program itself calls the connection's read-only
 * tool that the preset `check` names, every `intervalMin` minutes, and runs the routine only when
 * the result's fingerprint shows new items; no model request is made to look.
 */
export const ConnectionTriggerSchema = z.strictObject({
  kind: z.literal("connection"),
  connectorId: IdSchema,
  check: ConnectionCheckIdSchema,
  intervalMin: z.union([z.literal(5), z.literal(15), z.literal(60)]).default(15),
});
/**
 * The local calendar connection. `before_start` fires once per event `minutesBefore` its
 * start; `new_event` fires when an event appears that was not there at the previous check.
 * An empty `calendarIds` reads every calendar the connection can read.
 */
export const CalendarTriggerSchema = z.strictObject({
  kind: z.literal("calendar"),
  connectorId: IdSchema,
  event: z.enum(["before_start", "new_event"]),
  minutesBefore: z.number().int().min(1).max(1440).default(15),
  calendarIds: z
    .array(z.string().min(1).max(4096))
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, "Duplicate calendar")
    .default([]),
});
/** Truncated SHA-256 of one item's identity; the item itself is never stored. */
const ItemKeySchema = z.string().regex(/^[a-f0-9]{32}$/);
/**
 * Every item seen across checks (not just the last page), so an old item coming back into the
 * result is not new. `count` is the preset's counter for the item (PR comments); `at` is when it
 * was last seen, and the oldest entries go first once the list is full.
 */
export const ConnectionTriggerStateSchema = z.strictObject({
  checkedAt: CanonicalTimeSchema,
  seen: z
    .array(
      z.strictObject({
        key: ItemKeySchema,
        count: z.number().int().nonnegative().safe().optional(),
        at: CanonicalTimeSchema,
      }),
    )
    .max(500),
});
export const CalendarTriggerStateSchema = z.strictObject({
  checkedAt: CanonicalTimeSchema,
  /** `new_event`: events seen in the previous window, which ended at `seenUntil`. */
  seen: z.array(ItemKeySchema).max(1000),
  seenUntil: CanonicalTimeSchema,
  /** `before_start`: events already fired for, kept until they start. */
  fired: z.array(z.strictObject({ key: ItemKeySchema, start: CanonicalTimeSchema })).max(500),
  /** `before_start`: the earliest moment an unfired event in the window becomes due. */
  nextDueAt: CanonicalTimeSchema.nullable(),
});
/** Calendar reads run at most this often; a due `before_start` event pulls the next read in. */
export const CALENDAR_CHECK_INTERVAL_MS = 5 * 60_000;
/**
 * A new connection trigger first looks this long after it is saved (as the retired GitHub trigger
 * did); that look only records what is there. A calendar trigger looks after a minute: events that
 * became due since it was saved still fire then.
 */
export const CONNECTION_FIRST_CHECK_MS = 5 * 60_000;
export const CALENDAR_FIRST_CHECK_MS = 60_000;
export type ConnectionTrigger = z.infer<typeof ConnectionTriggerSchema>;
export type CalendarTrigger = z.infer<typeof CalendarTriggerSchema>;
export type ConnectionTriggerState = z.infer<typeof ConnectionTriggerStateSchema>;
export type CalendarTriggerState = z.infer<typeof CalendarTriggerStateSchema>;

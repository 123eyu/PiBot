import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import { ConnectorConfirmationModeSchema } from "./connectors.ts";

export const ConnectionTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("bot"), id: IdSchema }),
  z.strictObject({ kind: z.literal("group"), id: IdSchema }),
]);
export const ConnectionReasonSchema = z.enum([
  "not_connected",
  "needs_auth",
  "error",
  "platform_unsupported",
  "disabled",
  "no_access",
  "tool_disabled",
  "unknown_tool",
  "read_only_mode",
  "available",
]);
export const ConnectionAvailabilitySchema = z.strictObject({
  connection: z.string().min(1).max(200),
  connectorId: IdSchema.optional(),
  name: z.strictObject({ zh: z.string().max(200), en: z.string().max(200) }),
  trustedName: z.strictObject({ zh: z.string().max(200), en: z.string().max(200) }).optional(),
  reason: ConnectionReasonSchema,
  confirmationMode: ConnectorConfirmationModeSchema.optional(),
});
export type ConnectionTarget = z.infer<typeof ConnectionTargetSchema>;
export type ConnectionAvailability = z.infer<typeof ConnectionAvailabilitySchema>;

const USER_ACTIONS = new Set<ConnectionAvailability["reason"]>([
  "not_connected",
  "needs_auth",
  "error",
  "disabled",
  "no_access",
  "tool_disabled",
  "read_only_mode",
]);
/**
 * Whether the chat should ask the person to do something on the Connections page. A connection
 * that is available, a name the Bot looked up that does not exist, an unknown tool name and an
 * unsupported platform are the Bot's own findings: nothing there for the person to fix.
 */
export function connectionNeedsUser(availability: ConnectionAvailability): boolean {
  return availability.connection !== "unknown" && USER_ACTIONS.has(availability.reason);
}

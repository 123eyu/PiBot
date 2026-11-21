import { openPushRoute, unbase64 } from "@pibot/link";
import { z } from "zod";
import { readCredential } from "./credential.ts";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
/** What a push carries besides the fixed text: its kind and the route sealed by the computer. */
export const PushDataSchema = z.object({
  kind: z.enum(["approval", "run_done", "run_failed"]),
  route: z.string().min(1).max(1024),
});
const RouteSchema = z.strictObject({
  eventId: z
    .string()
    .regex(/^(approval|run_done|run_failed):[A-Za-z0-9_-]{1,64}$/)
    .optional(),
  approvalId: id.optional(),
  runId: id.optional(),
});
export interface PushEvent {
  eventId: string;
  kind: z.infer<typeof PushDataSchema>["kind"];
  approvalId?: string;
  runId?: string;
}
/**
 * Opens a push's route with one paired computer's room key (only that computer and this phone
 * hold it; the relay, Expo and Google / Apple cannot read it). Undefined for any other computer's
 * push, a forged one or a malformed one. The key bytes are wiped right after.
 */
export function openPushEvent(credential: string, data: unknown): PushEvent | undefined {
  const push = PushDataSchema.safeParse(data);
  if (!push.success) return undefined;
  let key: Uint8Array | undefined;
  try {
    key = unbase64(readCredential(credential).roomKey, 32);
    const route = RouteSchema.parse(JSON.parse(openPushRoute(key, push.data.route)));
    const target = push.data.kind === "approval" ? route.approvalId : route.runId;
    if (!target) return undefined;
    const eventId = `${push.data.kind}:${target}`;
    // A desktop that predates `eventId` is keyed the same way; a mismatch is a malformed route.
    if (route.eventId && route.eventId !== eventId) return undefined;
    return {
      eventId,
      kind: push.data.kind,
      ...(route.approvalId ? { approvalId: route.approvalId } : {}),
      ...(route.runId ? { runId: route.runId } : {}),
    };
  } catch {
    // Not this computer's key, or not a route at all: the caller tries the next computer.
    return undefined;
  } finally {
    key?.fill(0);
  }
}

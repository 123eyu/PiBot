import type { PushRequest } from "@pibot/link/room";
import { readJson } from "./body.ts";

const EXPO_URL = "https://exp.host/--/api/v2/push/send";
const bodies = {
  approval: "有 Bot 需要你审批 · Approval requested",
  run_done: "任务已完成 · Task completed",
  run_failed: "任务未完成 · Task failed",
};
// Android channels the phone creates (apps/mobile/src/push/local.ts); same ids for local notices.
const channels = { approval: "approvals", run_done: "tasks", run_failed: "tasks" };
/** `unregistered`: Expo says the token is dead (DeviceNotRegistered); the desktop forgets it. */
export type ExpoResult = "ok" | "unregistered" | "failed";
function ticketResult(value: unknown): ExpoResult {
  if (!value || typeof value !== "object" || !("data" in value)) return "failed";
  // One message in, one ticket out; Expo returns it as an object (or a one-item array).
  const data: unknown = Array.isArray(value.data) ? value.data[0] : value.data;
  if (!data || typeof data !== "object" || !("status" in data)) return "failed";
  if (data.status === "ok") return "ok";
  const details = "details" in data ? data.details : undefined;
  return details &&
    typeof details === "object" &&
    "error" in details &&
    details.error === "DeviceNotRegistered"
    ? "unregistered"
    : "failed";
}
export async function sendExpo(
  push: PushRequest,
  accessToken: string,
  signal: AbortSignal,
  transport: typeof fetch = fetch,
): Promise<ExpoResult> {
  // No caller-controlled title/body/URL: the only route information remains encrypted.
  const response = await transport(EXPO_URL, {
    method: "POST",
    // Workerd supports manual/follow only. Reject non-2xx below without forwarding credentials.
    redirect: "manual",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      to: push.expoToken,
      ...(push.kind === "wake"
        ? {
            // A data-only message: neither the notification tray nor third parties get content.
            priority: "high",
            ttl: 30,
            data: { kind: "wake", id: push.route },
          }
        : {
            title: "Pi Bot",
            body: bodies[push.kind],
            data: { route: push.route, kind: push.kind },
            channelId: channels[push.kind],
          }),
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    return "failed";
  }
  try {
    return ticketResult(await readJson(response.body, signal));
  } catch {
    return "failed";
  }
}

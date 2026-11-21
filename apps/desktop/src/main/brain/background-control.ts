/*
 * The desktop/client and preferences requests the host sends into the brain child, one pending
 * reply per request id, bounded by a timeout so a stopped or hanging child cannot stall callers.
 */
import { randomUUID } from "node:crypto";
import type { BackgroundPreferences } from "@pibot/protocol";

export interface BackgroundControlReply {
  id: string;
  ok: boolean;
  preferences?: BackgroundPreferences;
}

export function createBackgroundControl(deps: {
  /** Whether a ready brain child can take a message right now. */
  available(): boolean;
  post(message: unknown): void;
}) {
  const requests = new Map<
    string,
    {
      resolve(value: BackgroundPreferences): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const request = (
    operation: "client" | "preferences",
    connected?: boolean,
    preferences?: BackgroundPreferences,
  ) =>
    new Promise<BackgroundPreferences>((resolve, reject) => {
      if (!deps.available()) {
        reject(new Error("brain_unavailable"));
        return;
      }
      const id = randomUUID();
      const timer = setTimeout(() => {
        requests.delete(id);
        reject(new Error("brain_control_timeout"));
      }, 90_000);
      requests.set(id, { resolve, reject, timer });
      deps.post({
        type: "background-control",
        id,
        operation,
        ...(connected === undefined ? {} : { connected }),
        ...(preferences ? { preferences } : {}),
      });
    });
  return {
    request,
    /** Settle the caller of one reply; an unknown id is a late reply to a timed-out request. */
    settle(reply: BackgroundControlReply) {
      const pending = requests.get(reply.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      requests.delete(reply.id);
      if (reply.ok && reply.preferences) pending.resolve(reply.preferences);
      else pending.reject(new Error("brain_control_failed"));
    },
    /** Reject everything still pending: the child these requests belong to is gone. */
    fail(error: Error) {
      for (const pending of requests.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      requests.clear();
    },
  };
}

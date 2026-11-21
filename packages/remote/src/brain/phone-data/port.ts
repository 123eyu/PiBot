import type {
  PhoneDataMethod,
  PhoneDataMethods,
  PhoneDataPort,
  PhoneDataState,
} from "@pibot/remote-contract";
import { phoneDataError } from "@pibot/remote-contract";
import type { z } from "zod";
import type { RemoteConnections } from "../sessions/connections.ts";

const category: Record<PhoneDataMethod, keyof Omit<PhoneDataState, "platform">> = {
  "phoneData.calls": "media",
  "phoneData.notifications": "media",
  "phoneData.media": "media",
  "phoneData.mediaGet": "media",
  "phoneData.smsCode": "smsCode",
};
/** Phone-side work on top of the relay round trip; an SMS wait adds its own duration. */
const deadline = (method: PhoneDataMethod, params: unknown) =>
  method === "phoneData.smsCode"
    ? (params as { waitMs: number }).waitMs + 30_000
    : method === "phoneData.mediaGet"
      ? 45_000
      : 20_000;

/**
 * Phone-data capability port: reaches the paired phone over its live session. With several phones online
 * the one that reported the category on is asked first; the phone itself still decides, so a
 * stale report can only cost a refusal, never widen access.
 */
export function phoneDataPort(connections: RemoteConnections): PhoneDataPort {
  return {
    online: () => connections.phones().map(({ deviceId, state }) => ({ deviceId, state })),
    async call<K extends PhoneDataMethod>(
      method: K,
      params: z.input<(typeof PhoneDataMethods)[K]["params"]>,
      signal: AbortSignal,
      deviceId?: string,
    ) {
      const phones = connections.phones();
      const phone = deviceId
        ? phones.find((p) => p.deviceId === deviceId)
        : (phones.find((p) => p.state?.[category[method]]) ?? phones[0]);
      if (!phone) phoneDataError("phone_offline");
      const result = await phone.gateway.call(method, params, signal, deadline(method, params));
      signal.throwIfAborted();
      if (
        !connections
          .phones()
          .some((p) => p.deviceId === phone.deviceId && p.gateway === phone.gateway)
      )
        phoneDataError("phone_offline");
      return { deviceId: phone.deviceId, result };
    },
  };
}

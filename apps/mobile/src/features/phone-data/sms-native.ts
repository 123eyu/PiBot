import { PhoneDataErrorSchema, RpcError, RpcErrorCodes } from "@pibot/protocol";
import { type PibotAndroidModule, pibotAndroid } from "../../../modules/pibot-android/index.ts";
import type { PhoneSmsSource } from "./serve.ts";

const POLL_MS = 3_000;
/** Messages from just before the request still count (the page may have sent the SMS first). */
const LEAD_MS = 60_000;
const failure = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return new RpcError(
    RpcErrorCodes.unsupported,
    PhoneDataErrorSchema.safeParse(code).data ?? "phone_failed",
  );
};
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", stop);
      resolve();
    }
    function stop() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", stop, { once: true });
  });

function smsSource(android: PibotAndroidModule): PhoneSmsSource {
  return {
    capabilities: () => android.smsCapabilities(),
    async waitConsent(senderHint, waitMs, signal) {
      signal.throwIfAborted();
      // The computer gave up (session ended or the Bot's call was cancelled): stop listening.
      const cancel = () => void android.cancelConsentCode().catch(() => undefined);
      signal.addEventListener("abort", cancel, { once: true });
      try {
        return await android.waitForConsentCode(senderHint ?? null, waitMs);
      } catch (error) {
        throw failure(error);
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    },
    async scanRecent(senderHint, waitMs, signal) {
      const start = Date.now();
      while (Date.now() - start < waitMs) {
        let found: Awaited<ReturnType<typeof android.readRecentCode>>;
        try {
          found = await android.readRecentCode(senderHint ?? null, start - LEAD_MS);
        } catch {
          throw new RpcError(RpcErrorCodes.unsupported, "phone_permission_denied");
        }
        if (found) return found;
        await sleep(Math.min(POLL_MS, waitMs - (Date.now() - start)), signal);
      }
      throw new RpcError(RpcErrorCodes.unsupported, "phone_sms_timeout");
    },
  };
}
/** The Android module; undefined on iOS and in builds without the module. */
export const nativeSms = pibotAndroid ? smsSource(pibotAndroid) : undefined;

/** The READ_SMS fallback switch asks the system permission; false when this build lacks it. */
export async function requestSmsRead() {
  if (!pibotAndroid) return false;
  try {
    return (await pibotAndroid.requestReadSms()).granted;
  } catch {
    return false;
  }
}

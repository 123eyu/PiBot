import {
  type PhoneDataError,
  PhoneDataMethods,
  phoneDataError,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import { pibotAndroid } from "../../../modules/pibot-android/index.ts";
import { nativeWait } from "../../runtime/native-wait.ts";

// Codes the Kotlin side raises on purpose (PhoneReadPages.kt); anything else is a generic failure.
const NATIVE_CODES: readonly PhoneDataError[] = [
  "phone_busy",
  "phone_permission_denied",
  "phone_offline",
  "unsupported_platform",
];
const nativeCode = (error: unknown) => {
  const text = error instanceof Error ? error.message : "";
  return NATIVE_CODES.find((code) => text.includes(code));
};
type Settled<T> = { ok: true; value: T } | { ok: false; code: PhoneDataError | undefined };

/**
 * One native step under the request signal and a step limit. Native rejections become fixed
 * phone codes (never their message); the request's own abort stays an abort; a step timeout is
 * `phone_timeout`.
 */
async function step<T>(operation: Promise<T>, request: AbortSignal, timeoutMs: number) {
  let settled: Settled<T>;
  try {
    settled = await nativeWait(
      operation.then(
        (value): Settled<T> => ({ ok: true, value }),
        (error: unknown): Settled<T> => ({ ok: false, code: nativeCode(error) }),
      ),
      request,
      timeoutMs,
    );
  } catch {
    request.throwIfAborted();
    throw new RpcError(RpcErrorCodes.timeout, "phone_timeout");
  }
  if (settled.ok) return settled.value;
  if (settled.code) phoneDataError(settled.code);
  throw new RpcError(RpcErrorCodes.unsupported, "phone_failed");
}

export const nativeReadPages = pibotAndroid?.beginPhonePage
  ? {
      supported: async (kind: "calls" | "notifications", signal: AbortSignal) =>
        !!pibotAndroid &&
        (await nativeWait(pibotAndroid.readPagePermission(kind), signal, 5000)) !== "unsupported",
      async read(kind: "calls" | "notifications", input: unknown, parent: AbortSignal) {
        // The overall limit counts as a timeout, the caller's abort as an abort.
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(), 20000);
        const signal = AbortSignal.any([parent, deadline.signal]);
        const timed = <T>(operation: Promise<T>, ms: number) =>
          step(operation, signal, ms).catch((error: unknown) => {
            parent.throwIfAborted();
            if (deadline.signal.aborted) throw new RpcError(RpcErrorCodes.timeout, "phone_timeout");
            throw error;
          });
        try {
          signal.throwIfAborted();
          const native = pibotAndroid;
          if (!native) return phoneDataError("unsupported_platform");
          if ((await timed(native.readPagePermission(kind), 5000)) !== "granted")
            return phoneDataError("phone_permission_denied");
          const method = kind === "calls" ? "phoneData.calls" : "phoneData.notifications";
          const args = PhoneDataMethods[method].params.parse(input);
          const reservation = native.beginPhonePage();
          const release = (id: string) =>
            nativeWait(native.cancelPhonePage(id), AbortSignal.timeout(3000), 3000).catch(() => {
              /* Module teardown also cancels every reservation. */
            });
          void reservation.then(
            (id) => {
              if (signal.aborted) void release(id);
            },
            () => {
              /* The awaited reservation reports failure; no native message is logged. */
            },
          );
          const requestId = await timed(reservation, 20000);
          const abort = () => {
            void release(requestId);
          };
          signal.addEventListener("abort", abort, { once: true });
          try {
            signal.throwIfAborted();
            const raw = await timed(
              native.readPhonePage(
                requestId,
                kind,
                args.before?.at ?? Number.MAX_SAFE_INTEGER,
                args.before?.id ?? "9223372036854775807",
                args.limit,
              ),
              10000,
            );
            signal.throwIfAborted();
            if ((await timed(native.readPagePermission(kind), 5000)) !== "granted")
              return phoneDataError("phone_permission_denied");
            const page = PhoneDataMethods[method].result.safeParse(raw);
            if (!page.success) throw new RpcError(RpcErrorCodes.unsupported, "phone_failed");
            return page.data;
          } finally {
            signal.removeEventListener("abort", abort);
            await release(requestId);
          }
        } finally {
          clearTimeout(timer);
        }
      },
    }
  : undefined;

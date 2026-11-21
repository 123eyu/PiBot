import { randomUUID } from "node:crypto";
import type { Port } from "@pibot/protocol";
import { RpcError, RpcErrorCodes } from "@pibot/protocol";
import {
  PHONE_CALL_ID_PREFIX,
  PHONE_RESULT_MAX_BYTES,
  type PhoneDataMethod,
  PhoneDataMethods,
  phoneDataError,
} from "@pibot/remote-contract";
import type { z } from "zod";

interface Pending {
  method: PhoneDataMethod;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  cleanup(): void;
}
// The phone serves one Bot at a time in practice; a few in flight cover a list plus a fetch.
const MAX_PENDING = 4;

/**
 * Desktop → phone calls over one authenticated phone session. They share the session's
 * encrypted port with the phone's own requests; IDs carry their own prefix, so a reply can only
 * settle a call this side made, and a phone request can never pose as one. Every call has a
 * deadline and the caller's signal; closing the session settles them all as `phone_offline`.
 */
export function phoneCaller(port: Pick<Port, "post" | "cancelRequest">) {
  const pending = new Map<string, Pending>();
  let closed = false;
  return {
    call<K extends PhoneDataMethod>(
      method: K,
      params: z.input<(typeof PhoneDataMethods)[K]["params"]>,
      signal: AbortSignal,
      timeoutMs: number,
    ): Promise<z.output<(typeof PhoneDataMethods)[K]["result"]>> {
      signal.throwIfAborted();
      if (closed) phoneDataError("phone_offline");
      if (pending.size >= MAX_PENDING) phoneDataError("phone_busy");
      const parsed = PhoneDataMethods[method].params.parse(params);
      const id = `${PHONE_CALL_ID_PREFIX}${randomUUID()}`;
      return new Promise((resolve, reject) => {
        const settle = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          pending.delete(id);
        };
        const abort = () => {
          settle();
          reject(signal.reason);
          try {
            port.cancelRequest?.(id);
          } catch {
            // The session owner still drains a call when its transport closed before cancellation.
          }
        };
        const timer = setTimeout(() => {
          settle();
          reject(new RpcError(RpcErrorCodes.timeout, "phone_timeout"));
          try {
            port.cancelRequest?.(id);
          } catch {
            // A timed-out caller cannot retract work on an already closed session.
          }
        }, timeoutMs);
        signal.addEventListener("abort", abort, { once: true });
        pending.set(id, {
          method,
          resolve: resolve as (value: unknown) => void,
          reject,
          cleanup: settle,
        });
        try {
          port.post({ jsonrpc: "2.0", id, method, params: parsed });
        } catch (error) {
          settle();
          reject(error);
        }
      });
    },
    /** true when the message was the answer to one of this side's calls (consumed here). */
    receive(raw: unknown) {
      if (!raw || typeof raw !== "object" || "method" in raw) return false;
      const message = raw as Record<string, unknown>;
      if (typeof message.id !== "string" || !message.id.startsWith(PHONE_CALL_ID_PREFIX))
        return false;
      const call = pending.get(message.id);
      // A late or forged answer is dropped; it is still not a phone request.
      if (!call) return true;
      call.cleanup();
      if (Buffer.byteLength(JSON.stringify(raw)) > PHONE_RESULT_MAX_BYTES) {
        call.reject(new RpcError(RpcErrorCodes.invalidRequest, "phone_result_too_large"));
        return true;
      }
      const error = message.error as { code?: unknown; message?: unknown } | undefined;
      if (error && typeof error === "object") {
        // Only the phone's own error vocabulary passes through; anything else is generic.
        const code = typeof error.code === "number" ? error.code : RpcErrorCodes.internal;
        const text = typeof error.message === "string" ? error.message : "";
        call.reject(
          new RpcError(code, /^[a-z][a-z0-9_]{2,60}$/.test(text) ? text : "phone_failed"),
        );
        return true;
      }
      const result = PhoneDataMethods[call.method].result.safeParse(message.result);
      if (result.success) call.resolve(result.data);
      else call.reject(new RpcError(RpcErrorCodes.internal, "phone_result_invalid"));
      return true;
    },
    close() {
      closed = true;
      for (const call of [...pending.values()]) {
        call.cleanup();
        call.reject(new RpcError(RpcErrorCodes.unsupported, "phone_offline"));
      }
    },
  };
}
export type PhoneCaller = ReturnType<typeof phoneCaller>;

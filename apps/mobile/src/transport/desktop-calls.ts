import {
  PHONE_CALL_ID_PREFIX,
  PHONE_RESULT_MAX_BYTES,
  type PhoneDataMethod,
  PhoneDataMethods,
  type Port,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";

/** Answers one desktop call; throw an RpcError whose message is a phone error code. */
export type DesktopCallHandler = (
  method: PhoneDataMethod,
  params: unknown,
  signal: AbortSignal,
) => Promise<unknown>;
// Two at once cover a listing next to a photo fetch; more would only queue native work.
const MAX_ACTIVE = 2;
const KNOWN = /^capability_off$|^phone_[a-z_]{2,40}$|^unsupported_platform$/;
const isDesktopCall = (raw: unknown): raw is { id: string; method: string; params?: unknown } => {
  if (!raw || typeof raw !== "object") return false;
  const message = raw as Record<string, unknown>;
  return (
    typeof message.method === "string" &&
    typeof message.id === "string" &&
    message.id.startsWith(PHONE_CALL_ID_PREFIX)
  );
};
const fail = (code: string) => new RpcError(RpcErrorCodes.unsupported, code);

/**
 * Splits the computer's calls to this phone off the session port. The phone's own Peers see the
 * port without them (they would otherwise answer "method not found"); calls reach the one
 * registered handler, are schema-checked both ways and stay under the frame cap. Without a
 * handler, or once the session ends, the answer is `phone_offline`.
 */
export function splitDesktopCalls(
  port: Port,
  closed: AbortSignal,
  allowed: (method: PhoneDataMethod) => boolean = () => true,
) {
  let handler: DesktopCallHandler | undefined;
  let active = 0;
  const activeRequests = new Map<string, AbortController>();
  const reply = (id: string, body: { result: unknown } | { error: RpcError }) => {
    if (closed.aborted) return;
    if ("error" in body)
      port.post({
        jsonrpc: "2.0",
        id,
        error: { code: body.error.code, message: body.error.message },
      });
    else port.post({ jsonrpc: "2.0", id, result: body.result });
  };
  async function answer(id: string, method: string, params: unknown) {
    if (!Object.hasOwn(PhoneDataMethods, method))
      return reply(id, { error: new RpcError(RpcErrorCodes.methodNotFound, "phone_method") });
    const name = method as PhoneDataMethod;
    const parsed = PhoneDataMethods[name].params.safeParse(params);
    if (!parsed.success)
      return reply(id, { error: new RpcError(RpcErrorCodes.invalidParams, "phone_params") });
    if (!allowed(name)) return reply(id, { error: fail("capability_off") });
    const current = handler;
    if (!current) return reply(id, { error: fail("phone_offline") });
    if (activeRequests.has(id)) return reply(id, { error: fail("phone_busy") });
    if (active >= MAX_ACTIVE) return reply(id, { error: fail("phone_busy") });
    const controller = new AbortController();
    activeRequests.set(id, controller);
    active++;
    try {
      const signal = AbortSignal.any([closed, controller.signal]);
      const result = PhoneDataMethods[name].result.parse(await current(name, parsed.data, signal));
      signal.throwIfAborted();
      if (!allowed(name)) throw fail("capability_off");
      if (JSON.stringify(result).length > PHONE_RESULT_MAX_BYTES - 200) throw fail("phone_busy");
      reply(id, { result });
    } catch (error) {
      // Only the phone's own snake_case codes leave the phone; native messages never do.
      const known = error instanceof RpcError && KNOWN.test(error.message);
      reply(id, { error: known ? error : fail("phone_failed") });
    } finally {
      if (activeRequests.get(id) === controller) activeRequests.delete(id);
      active--;
    }
  }
  const off = port.onMessage((raw) => {
    if (isDesktopCall(raw)) void answer(raw.id, raw.method, raw.params);
  });
  const offCancel = port.onRequestCancel?.((id) => activeRequests.get(id)?.abort()) ?? (() => {});
  const stop = () => {
    off();
    offCancel();
    for (const controller of activeRequests.values()) controller.abort();
    activeRequests.clear();
  };
  closed.addEventListener("abort", stop, { once: true });
  if (closed.aborted) stop();
  return {
    port: {
      post: (message: unknown) => port.post(message),
      onMessage: (listener: (message: unknown) => void) =>
        port.onMessage((raw) => {
          const control = raw as { method?: unknown } | null;
          if (!isDesktopCall(raw) && control?.method !== "endpoint.enabled") listener(raw);
        }),
      cancelRequest: (id) => port.cancelRequest?.(id),
      onRequestCancel: (listener) => port.onRequestCancel?.(listener) ?? (() => {}),
      dispose: () => port.dispose?.(),
    } satisfies Port,
    invalidate() {
      for (const controller of activeRequests.values()) controller.abort();
    },
    /** Registers the handler for this session; the returned function removes it. */
    serve(next: DesktopCallHandler) {
      handler = next;
      return () => {
        if (handler === next) handler = undefined;
      };
    },
  };
}

import {
  ExtensionHelloSchema,
  type ExtensionMethodName,
  ExtensionResponseSchema,
  ExtensionStopSchema,
  parseExtensionParams,
} from "@pibot/browser-contract";
import { RpcError, RpcErrorCodes } from "@pibot/protocol";

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };

/** Owns one connected extension and turns its framed messages into host browser calls. */
export class ExtensionHost {
  private readonly pending = new Map<string, Pending>();
  private sequence = 0;
  private closed = false;
  browser?: string;

  constructor(
    private readonly send: (message: unknown) => Promise<void>,
    private readonly onStop: (params: { botId: string; tab?: string }) => void,
  ) {}

  get connected() {
    return !this.closed && this.browser !== undefined;
  }

  hello(payload: unknown) {
    this.browser = ExtensionHelloSchema.parse(payload).browser;
  }

  response(value: unknown) {
    const response = ExtensionResponseSchema.parse(value);
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.error) pending.reject(extensionError(response.error.code, response.error.message));
    else pending.resolve(response.result);
  }

  stop(payload: unknown) {
    this.onStop(ExtensionStopSchema.parse(payload));
  }

  call<K extends ExtensionMethodName>(method: K, params: unknown, signal?: AbortSignal) {
    if (!this.connected)
      return Promise.reject(
        new RpcError(RpcErrorCodes.unsupported, "browser_extension_disconnected"),
      );
    const id = `pibot-${++this.sequence}`;
    let parsed: unknown;
    try {
      parsed = parseExtensionParams(method, params);
    } catch {
      // A call the extension's contract does not take is the caller's mistake, said so plainly.
      return Promise.reject(new RpcError(RpcErrorCodes.invalidParams, "browser_extension_params"));
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(RpcErrorCodes.timeout, "browser_extension_timeout"));
      }, 30_000);
      const abort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new RpcError(RpcErrorCodes.cancelled, "browser_extension_cancelled"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, { resolve, reject, timer });
      void this.send({ id, method, params: parsed }).catch((error: unknown) => {
        abort();
        reject(error instanceof Error ? error : new Error("browser_extension_send_failed"));
      });
    });
  }

  close() {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RpcError(RpcErrorCodes.closed, "browser_extension_disconnected"));
    }
    this.pending.clear();
  }
}

function extensionError(code: string, message: string): RpcError {
  const rpcCode =
    code === "browser_screenshot_rate_limited"
      ? RpcErrorCodes.busy
      : code === "browser_screenshot_unavailable" ||
          code === "browser_screenshot_restricted" ||
          code === "browser_screenshot_window_obscured" ||
          code === "browser_screenshot_window_minimized"
        ? RpcErrorCodes.unsupported
        : RpcErrorCodes.invalidParams;
  return new RpcError(rpcCode, code, { extensionCode: code, extensionMessage: message });
}

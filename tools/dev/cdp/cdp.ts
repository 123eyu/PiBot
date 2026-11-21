import { assertCdpProcess, type CdpIdentity, ownedRenderer } from "./identity.ts";
// Minimal Chrome DevTools Protocol client over Node's built-in WebSocket (no dependency).
// Local only: it talks to 127.0.0.1 and never sends anything elsewhere.

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
}

export class Cdp {
  private next = 1;
  private readonly pending = new Map<
    number,
    { resolve(v: unknown): void; reject(e: Error): void }
  >();
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  private readonly socket: WebSocket;

  /** Other local targets (the background owner's Bot browser), without changing app code. */
  static async target(port: number, matches: (url: string) => boolean, timeoutMs = 30_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2000),
      })
        .then((response) => response.json())
        .catch(() => []);
      if (Array.isArray(targets)) {
        const found = targets.find((item) => item.type === "page" && matches(item.url));
        if (found) {
          const address = new URL(found.webSocketDebuggerUrl);
          if (
            address.protocol !== "ws:" ||
            address.hostname !== "127.0.0.1" ||
            Number(address.port) !== port
          )
            throw new Error("cdp_nonlocal_target");
          const socket = new WebSocket(address);
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              socket.close();
              reject(new Error("cdp_connect_timeout"));
            }, 5000);
            socket.addEventListener(
              "open",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
            socket.addEventListener(
              "error",
              () => {
                clearTimeout(timer);
                reject(new Error("cdp_socket_failed"));
              },
              { once: true },
            );
          });
          return new Cdp(socket);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("cdp_target_timeout");
  }
  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("close", () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error("cdp_closed"));
      this.pending.clear();
    });
    socket.addEventListener("message", (message) => {
      const data = JSON.parse(String(message.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
        method?: string;
        params?: Record<string, unknown>;
      };
      if (data.id !== undefined) {
        const waiter = this.pending.get(data.id);
        this.pending.delete(data.id);
        if (data.error) waiter?.reject(new Error(data.error.message));
        else waiter?.resolve(data.result);
      } else if (data.method)
        for (const listener of this.listeners)
          listener({ method: data.method, params: data.params ?? {} });
    });
  }

  /** Attach to the app's main renderer page (the one serving renderer/index.html). */
  static async attach(port: number, timeoutMs = 30_000): Promise<Cdp> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      try {
        const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
          type: string;
          url: string;
          webSocketDebuggerUrl: string;
        }[];
        const page = targets.find(
          (target) =>
            target.type === "page" && /renderer\/index\.html|localhost:\d+\/?$/.test(target.url),
        );
        if (page) {
          const socket = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise<void>((resolve, reject) => {
            socket.addEventListener("open", () => resolve(), { once: true });
            socket.addEventListener("error", () => reject(new Error("cdp_socket_failed")), {
              once: true,
            });
          });
          return new Cdp(socket);
        }
      } catch {
        // The app is still starting; the deadline below bounds the wait.
      }
      if (Date.now() > until) throw new Error(`no Pi Bot renderer on 127.0.0.1:${port}`);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  /** Certify the browser process before selecting or evaluating any renderer. */
  static async attachOwned(
    identity: CdpIdentity,
    signal = AbortSignal.timeout(60_000),
  ): Promise<Cdp> {
    const local = (raw: string) => {
      const url = new URL(raw);
      if (
        url.protocol !== "ws:" ||
        url.hostname !== "127.0.0.1" ||
        Number(url.port) !== identity.port
      )
        throw new Error("cdp_nonlocal_target");
      return url;
    };
    const connect = async (raw: string) => {
      signal.throwIfAborted();
      const socket = new WebSocket(local(raw));
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          socket.removeEventListener("open", opened);
          socket.removeEventListener("error", failed);
          if (error) {
            socket.close();
            reject(error);
          } else resolve();
        };
        const opened = () => finish(),
          failed = () => finish(new Error("cdp_socket_failed"));
        const abort = () => finish(new Error("cdp_cancelled"));
        const timer = setTimeout(() => finish(new Error("cdp_connect_timeout")), 5000);
        socket.addEventListener("open", opened, { once: true });
        socket.addEventListener("error", failed, { once: true });
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      return new Cdp(socket);
    };
    const json = async (path: string) =>
      (
        await fetch(`http://127.0.0.1:${identity.port}${path}`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
          redirect: "error",
        })
      ).json();
    let version: { webSocketDebuggerUrl?: string } | undefined;
    while (!version) {
      signal.throwIfAborted();
      try {
        version = await json("/json/version");
      } catch {
        signal.throwIfAborted();
      }
      if (!version)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
          }, 100);
          const abort = () => {
            clearTimeout(timer);
            reject(new Error("cdp_cancelled"));
          };
          signal.addEventListener("abort", abort, { once: true });
        });
    }
    if (typeof version.webSocketDebuggerUrl !== "string") throw new Error("cdp_identity_mismatch");
    const browser = await connect(version.webSocketDebuggerUrl);
    try {
      const abort = () => browser.close();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      try {
        assertCdpProcess(
          identity,
          await browser.send("Browser.getBrowserCommandLine", {}, 5000),
          await browser.send("SystemInfo.getProcessInfo", {}, 5000),
        );
      } finally {
        signal.removeEventListener("abort", abort);
      }
    } finally {
      browser.close();
    }
    signal.throwIfAborted();
    const pages: unknown = await json("/json/list");
    if (!Array.isArray(pages) || pages.length > 100) throw new Error("cdp_identity_mismatch");
    const matches = pages.filter(
      (row) =>
        row?.type === "page" && typeof row.url === "string" && ownedRenderer(row.url, identity),
    );
    if (matches.length !== 1 || typeof matches[0].webSocketDebuggerUrl !== "string")
      throw new Error("cdp_identity_mismatch");
    return connect(matches[0].webSocketDebuggerUrl);
  }

  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 60_000,
  ): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp_timeout:${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch {
        this.pending.get(id)?.reject(new Error("cdp_send_failed"));
        this.pending.delete(id);
      }
    });
  }

  on(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.socket.close();
  }
}

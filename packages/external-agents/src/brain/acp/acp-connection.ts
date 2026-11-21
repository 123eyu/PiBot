// A minimal ACP (JSON-RPC 2.0 over newline-delimited stdio) client on top of execution's stdio
// stream. Pi Bot is the client: it sends initialize / session/* requests and answers the agent's
// requests. Every inbound frame is untrusted and checked by @pibot/acp-schemas at this boundary;
// nothing here logs message content.

import { parseRpcFrame, type RpcFrame, type RpcId } from "@pibot/acp-schemas";
import type { ConnectorServerStream, SandboxBlockItem } from "@pibot/execution";

/** A JSON-RPC error answer of the agent; `message` is agent text and stays out of logs. */
export class AcpRemoteError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message.slice(0, 500));
    this.name = "AcpRemoteError";
  }
}
export class AcpClosedError extends Error {
  constructor() {
    super("acp_closed");
    this.name = "AcpClosedError";
  }
}

type RequestHandler = (params: unknown, signal: AbortSignal) => Promise<unknown>;
type NotificationHandler = (params: unknown) => void;

/** Too many frames that are not JSON-RPC means the other side is not an ACP agent. */
const MAX_INVALID_FRAMES = 20;
/** Requests the agent may have open toward Pi Bot at once (permission cards wait on a person). */
const MAX_INBOUND_REQUESTS = 16;

export class AcpConnection {
  private nextId = 1;
  private readonly pending = new Map<
    RpcId,
    { resolve(value: unknown): void; reject(error: unknown): void }
  >();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private readonly inbound = new Map<RpcId, AbortController>();
  private readonly closeListeners = new Set<() => void>();
  private invalid = 0;
  private closed = false;
  private readonly lifetime = new AbortController();
  private readonly detach: (() => void)[] = [];

  constructor(
    private readonly stream: ConnectorServerStream,
    private readonly onProtocolNote: (note: { event: string; method?: string }) => void = () => {},
  ) {
    this.detach.push(stream.onMessage((line) => this.receive(line)));
    this.detach.push(stream.onClose(() => this.markClosed()));
  }

  get isClosed() {
    return this.closed;
  }

  onRequest(method: string, handler: RequestHandler) {
    this.requestHandlers.set(method, handler);
  }
  onNotification(method: string, handler: NotificationHandler) {
    this.notificationHandlers.set(method, handler);
  }
  onClose(listener: () => void) {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /**
   * Sends one request. Aborting `signal` ends the local wait only (an earlier SDK lesson: a
   * remote cancellation is a separate notification and never settles a request by itself).
   */
  request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new AcpClosedError());
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        reject(signal.reason);
      };
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      const settle = {
        resolve: (value: unknown) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      };
      this.pending.set(id, settle);
      this.send({ jsonrpc: "2.0", id, method, params }, signal).catch((error: unknown) => {
        this.pending.delete(id);
        settle.reject(error);
      });
    });
  }

  notify(method: string, params: unknown, signal: AbortSignal) {
    return this.send({ jsonrpc: "2.0", method, params }, signal);
  }

  async close() {
    this.markClosed();
    await this.stream.close();
  }

  stderrTail() {
    return this.stream.stderrTail();
  }

  /** Snapshot current sandbox denials while keeping the monitor for the next turn. */
  async sandboxDenials(): Promise<readonly SandboxBlockItem[]> {
    return (await this.stream.diagnose(true)).denials;
  }

  private send(frame: Record<string, unknown>, signal: AbortSignal) {
    if (this.closed) return Promise.reject(new AcpClosedError());
    return this.stream.write(JSON.stringify(frame), signal);
  }

  private markClosed() {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort();
    for (const stop of this.detach) stop();
    for (const controller of this.inbound.values()) controller.abort();
    this.inbound.clear();
    for (const entry of this.pending.values()) entry.reject(new AcpClosedError());
    this.pending.clear();
    for (const listener of this.closeListeners) listener();
  }

  private receive(line: string) {
    let frame: RpcFrame | undefined;
    try {
      frame = parseRpcFrame(JSON.parse(line));
    } catch {
      frame = undefined;
    }
    if (!frame) {
      // Agents may print stray text on stdout; drop it, and give up on a stream that is not ACP.
      this.onProtocolNote({ event: "invalid_frame" });
      if (++this.invalid > MAX_INVALID_FRAMES) void this.close();
      return;
    }
    if (frame.type === "request") return this.handleRequest(frame.id, frame.method, frame.params);
    if (frame.type === "notification") {
      const handler = this.notificationHandlers.get(frame.method);
      if (!handler) return;
      try {
        handler(frame.params);
      } catch {
        // A handler failure is Pi Bot's bug; record the method only and keep the session.
        this.onProtocolNote({ event: "notification_failed", method: frame.method });
      }
      return;
    }
    if (frame.id === null) return;
    const entry = this.pending.get(frame.id);
    if (!entry) return;
    this.pending.delete(frame.id);
    if (frame.type === "error")
      entry.reject(new AcpRemoteError(frame.error.code, frame.error.message, frame.error.data));
    else entry.resolve(frame.result);
  }

  private handleRequest(id: RpcId, method: string, params: unknown) {
    const handler = this.requestHandlers.get(method);
    const reply = (body: Record<string, unknown>) =>
      this.send({ jsonrpc: "2.0", id, ...body }, this.lifetime.signal).catch(() => {
        // The process is gone; its close listener settles everything that waited on it.
      });
    if (!handler) {
      // fs/* and terminal/* are not offered (clientCapabilities false): refuse explicitly.
      void reply({ error: { code: -32601, message: "Method not found" } });
      return;
    }
    if (this.inbound.size >= MAX_INBOUND_REQUESTS || this.inbound.has(id)) {
      void reply({ error: { code: -32000, message: "Too many requests" } });
      return;
    }
    const controller = new AbortController();
    this.inbound.set(id, controller);
    handler(params, AbortSignal.any([controller.signal, this.lifetime.signal]))
      .then(
        (result) => reply({ result: result ?? null }),
        (error: unknown) => {
          this.onProtocolNote({ event: "request_failed", method });
          return reply({
            error: {
              code: error instanceof AcpRemoteError ? error.code : -32603,
              message: error instanceof AcpRemoteError ? error.message : "Internal error",
            },
          });
        },
      )
      .finally(() => this.inbound.delete(id));
  }
}

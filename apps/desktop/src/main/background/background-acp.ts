import { randomUUID } from "node:crypto";
import {
  ACP_MAX_FRAME,
  type AcpChannel,
  AcpChannelSchema,
  type AcpClient,
  ACP_MAX_CONNECTIONS as MAX_ACP_CONNECTIONS,
  type Port,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";

/**
 * Up to MAX_CONNECTIONS editors / tools at once (maintainers 2026-11-05: parallel dev-Bot
 * tasks over pibot-dev, or an editor beside it). Each slot is held until utility confirms its
 * disposal, including a dead socket.
 */
type Connection = {
  id: string;
  send(message: unknown): Promise<void>;
  close(): void;
  closing?: Promise<void>;
};
export function createBackgroundAcp(failed: () => void) {
  const listeners = new Set<(message: unknown) => void>();
  const pending = new Map<
    string,
    { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  const active = new Map<string, Connection>();
  const retries = new Set<ReturnType<typeof setTimeout>>();
  let stopping = false;
  const post = (message: AcpChannel) => {
    for (const listener of listeners) listener(message);
  };
  const request = (message: AcpChannel & { id: string }) => {
    // The per-connection budget (16) times the slots: one busy tool cannot starve the others.
    if (pending.size >= 16 * MAX_ACP_CONNECTIONS) return Promise.reject(new Error("acp_capacity"));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(message.id);
        reject(new Error("acp_drain_unconfirmed"));
      }, 30_000);
      pending.set(message.id, { resolve, reject, timer });
      try {
        post(message);
      } catch {
        clearTimeout(timer);
        pending.delete(message.id);
        reject(new Error("acp_channel_failed"));
      }
    });
  };
  const disconnectOne = (current: Connection) => {
    current.closing ??= (async () => {
      await request({ type: "detach", id: randomUUID(), connection: current.id });
      await current.send({ kind: "acp-error", code: "app_quit" }).catch(() => {
        /* A vanished editor cannot receive the final code. */
      });
      current.close();
      if (active.get(current.id) === current) active.delete(current.id);
    })().catch((error) => {
      current.closing = undefined;
      // 2026-11-06: a detach that utility did not confirm within 30 s (a run still aborting under
      // load, or after a network drop) left the slot held until the app restarted; four such
      // drains made every later tool get acp_busy. The slot still waits for a confirmed drain,
      // so no new run overlaps the old one, but the drain is asked again until it is confirmed.
      if (!stopping && active.get(current.id) === current) {
        const timer = setTimeout(() => {
          retries.delete(timer);
          // The failure that scheduled this retry was already reported to the caller; later
          // attempts reschedule themselves the same way, so nothing is lost by not rethrowing.
          void disconnectOne(current).catch(() => {});
        }, 30_000);
        timer.unref?.();
        retries.add(timer);
      }
      throw error;
    });
    return current.closing;
  };
  const cancelRetries = () => {
    for (const timer of retries) clearTimeout(timer);
    retries.clear();
  };
  /** One connection, or every connection (quit, the GUI's disconnect). */
  const disconnect = async (id?: string) => {
    if (id) {
      const current = active.get(id);
      if (current) await disconnectOne(current);
      return;
    }
    const results = await Promise.allSettled([...active.values()].map(disconnectOne));
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw (failure as PromiseRejectedResult).reason;
  };
  const port: Port = {
    post(raw) {
      const result = AcpChannelSchema.safeParse(raw);
      if (!result.success) {
        failed();
        return;
      }
      const message = result.data;
      if (message.type === "reply" || message.type === "ack") {
        if (message.type === "ack" && !active.has(message.connection)) return;
        const wait = pending.get(message.id);
        if (!wait) return;
        pending.delete(message.id);
        clearTimeout(wait.timer);
        if (message.type === "reply" && !message.ok) wait.reject(new Error("acp_channel_refused"));
        else wait.resolve();
      } else if (message.type === "frame" && active.has(message.connection)) {
        const current = active.get(message.connection) as Connection;
        if (Buffer.byteLength(JSON.stringify(message.message)) > ACP_MAX_FRAME) {
          failed();
          void disconnect(current.id).catch(failed);
          return;
        }
        void current
          .send({ kind: "acp", message: message.message })
          .then(() => {
            if (active.get(current.id) === current)
              post({ type: "ack", id: message.id, connection: current.id });
          })
          .catch(() => {
            void disconnect(current.id).catch(failed);
          });
      } else if (message.type === "closed" && active.has(message.connection)) {
        // GUI disconnection may initiate shutdown inside utility instead of this owner.
        if (!active.get(message.connection)?.closing)
          void disconnect(message.connection).catch(failed);
      }
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    port,
    owns: (id: string) => active.has(id),
    async attach(
      id: string,
      client: AcpClient,
      send: (message: unknown) => Promise<void>,
      close: () => void,
    ) {
      if (stopping) throw new RpcError(RpcErrorCodes.closed, "app_quit");
      if (process.platform === "win32")
        throw new RpcError(RpcErrorCodes.unsupported, "attach_unsupported_platform");
      if (active.size >= MAX_ACP_CONNECTIONS || active.has(id))
        throw new RpcError(RpcErrorCodes.busy, "acp_busy");
      const current: Connection = { id, send, close };
      active.set(id, current);
      try {
        await request({ type: "attach", id: randomUUID(), connection: id, client });
      } catch (error) {
        await disconnect(id).catch(failed);
        throw error;
      }
    },
    async frame(id: string, message: unknown) {
      const current = active.get(id);
      if (!current || current.closing) throw new Error("acp_not_attached");
      if (Buffer.byteLength(JSON.stringify(message)) > ACP_MAX_FRAME)
        throw new Error("acp_frame_too_large");
      await request({ type: "frame", id: randomUUID(), connection: id, message });
    },
    disconnected(id: string) {
      return disconnect(id);
    },
    disconnect: () => disconnect(),
    async stop() {
      stopping = true;
      cancelRetries();
      await disconnect();
    },
    retired() {
      // Called only after the actual utility exit: no owned run can still execute.
      cancelRetries();
      for (const wait of pending.values()) {
        clearTimeout(wait.timer);
        wait.resolve();
      }
      pending.clear();
      for (const current of active.values())
        void current
          .send({ kind: "acp-error", code: "app_quit" })
          .finally(current.close)
          .catch(failed);
      active.clear();
    },
  };
}

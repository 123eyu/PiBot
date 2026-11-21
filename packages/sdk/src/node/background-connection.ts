import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { BackgroundControlSchema, BackgroundWire } from "@pibot/protocol/background";
import { ACP_MAX_FRAME, RpcError, RpcErrorCodes } from "@pibot/protocol/background";
import type { z } from "zod";
import { createBackgroundHeartbeat } from "./background-heartbeat.ts";
import { framedSocket } from "./background-wire.ts";
import { type BackgroundDiscovery, readDescriptor } from "./descriptor.ts";

export async function connectBackground(
  dataDir: string,
  version: string,
  receive: (message: BackgroundWire) => unknown,
  closed: () => void,
  signal?: AbortSignal,
  clientKind?: "acp",
  discovery?: BackgroundDiscovery,
) {
  signal?.throwIfAborted();
  const descriptor = await readDescriptor(dataDir, discovery, signal);
  await discovery?.validateOwner(descriptor, signal);
  signal?.throwIfAborted();
  if (descriptor.version !== version)
    throw new Error("background_version_mismatch_stop_old_owner_first");
  const socket = discovery
    ? createConnection({ host: "127.0.0.1", port: Number(descriptor.endpoint.split(":")[2]) })
    : createConnection(descriptor.endpoint);
  const pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
      cleanup(): void;
    }
  >();
  let connected = false;
  let heartbeat: ReturnType<typeof createBackgroundHeartbeat> | undefined;
  let readyReceived = false;
  let releaseMessages: () => void = () => {};
  let denyMessages: (error: Error) => void = () => {};
  // Pause the framed reader at ready until the host has rechecked the owner. This also
  // bounds bytes received during the metadata check without exposing them to the client.
  const verified = discovery
    ? new Promise<void>((resolve, reject) => {
        releaseMessages = resolve;
        denyMessages = reject;
      })
    : undefined;
  let resolveReady: () => void = () => {},
    rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  socket.on("error", (error) => rejectReady(error));
  const timeout = setTimeout(() => {
    rejectReady(new Error("background_auth_timeout"));
    socket.destroy();
  }, 5000);
  const wire = framedSocket(socket, (message) => {
    if (!readyReceived) {
      if (message.kind === "acp-error") {
        rejectReady(new Error(message.code));
        socket.destroy();
        return;
      }
      if (message.kind !== "ready" || message.instance !== descriptor.instance) {
        socket.destroy();
        return;
      }
      readyReceived = true;
      connected = !discovery;
      if (clientKind === "acp") wire.limit(ACP_MAX_FRAME + 1024);
      clearTimeout(timeout);
      resolveReady();
      return verified;
    }
    if (heartbeat?.receive(message)) return;
    if (message.kind === "reply") {
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      request.cleanup();
      pending.delete(message.id);
      if (message.ok) request.resolve(message.result);
      else
        request.reject(
          new RpcError(message.code ?? RpcErrorCodes.internal, "background_control_failed"),
        );
    } else {
      const received = receive(message);
      if (received instanceof Promise) return received.then(() => {});
    }
  });
  socket.once("connect", () =>
    wire.send({
      kind: "auth",
      ...(clientKind ? { clientKind } : {}),
      protocol: descriptor.protocol,
      version: descriptor.version,
      instance: descriptor.instance,
      token: descriptor.token,
      pid: process.pid,
    }),
  );
  socket.once("close", () => {
    heartbeat?.dispose();
    clearTimeout(timeout);
    rejectReady(new Error("background_disconnected"));
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.cleanup();
      request.reject(new Error("background_disconnected"));
    }
    pending.clear();
    if (connected) closed();
  });
  const abort = () => {
    rejectReady(new Error("background_connect_aborted"));
    wire.close();
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    await ready;
    if (discovery) {
      const current = await readDescriptor(dataDir, discovery, signal);
      if (
        current.instance !== descriptor.instance ||
        current.pid !== descriptor.pid ||
        current.endpoint !== descriptor.endpoint ||
        current.token !== descriptor.token ||
        current.version !== descriptor.version
      )
        throw new Error("background_owner_changed");
      await discovery.validateOwner(current, signal);
      signal?.throwIfAborted();
      if (socket.destroyed) throw new Error("background_disconnected");
      connected = true;
      releaseMessages();
    }
    heartbeat = createBackgroundHeartbeat({ send: wire.send, failed: () => wire.close() });
  } catch (error) {
    if (readyReceived)
      denyMessages(error instanceof Error ? error : new Error("background_connect_failed"));
    wire.close();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  return {
    descriptor,
    send: wire.send,
    sendAsync: wire.sendAsync,
    control(control: z.infer<typeof BackgroundControlSchema>, signal?: AbortSignal) {
      if (signal?.aborted) return Promise.reject(new Error("background_control_aborted"));
      if (pending.size >= 16) return Promise.reject(new Error("background_busy"));
      return new Promise<unknown>((resolve, reject) => {
        const id = randomUUID();
        const cleanup = () => signal?.removeEventListener("abort", abort);
        const abort = () => {
          clearTimeout(timer);
          pending.delete(id);
          cleanup();
          reject(new Error("background_control_aborted"));
        };
        const timer = setTimeout(() => {
          pending.delete(id);
          cleanup();
          reject(new Error("background_control_timeout"));
        }, 95_000);
        pending.set(id, { resolve, reject, timer, cleanup });
        signal?.addEventListener("abort", abort, { once: true });
        try {
          wire.send({ kind: "control", id, control });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          cleanup();
          reject(error);
        }
      });
    },
    close: wire.close,
  };
}

import { createServer, type Socket } from "node:net";

/** A bound endpoint exists before descriptor publication; early clients have bounded admission. */
export async function reserveLoopback(signal?: AbortSignal) {
  const active = AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]);
  active.throwIfAborted();
  let accept: ((socket: Socket) => void) | undefined;
  const pending = new Map<Socket, ReturnType<typeof setTimeout>>();
  const server = createServer({ pauseOnConnect: true }, (socket) => {
    if (accept) {
      accept(socket);
      socket.resume();
    } else if (pending.size >= 8) socket.destroy();
    else {
      pending.set(
        socket,
        setTimeout(() => socket.destroy(), 5000),
      );
      socket.once("close", () => {
        clearTimeout(pending.get(socket));
        pending.delete(socket);
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      server.off("error", failed);
      active.removeEventListener("abort", aborted);
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const aborted = () => {
      server.close();
      failed(new Error("background_listen_aborted"));
    };
    server.once("error", failed);
    active.addEventListener("abort", aborted, { once: true });
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      cleanup();
      resolve();
    });
  });
  // Preserve a pre-activation failure for the owner rather than emit an unhandled error.
  let failed: Error | undefined;
  server.on("error", (error) => {
    failed = error;
  });
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
    server.close();
    throw new Error("background_endpoint_invalid");
  }
  return {
    server,
    endpoint: `tcp:127.0.0.1:${address.port}`,
    activate(handler: (socket: Socket) => void) {
      if (failed || !server.listening) throw new Error("background_listener_unavailable");
      if (accept) throw new Error("background_listener_already_owned");
      accept = handler;
      for (const [socket, timer] of pending) {
        clearTimeout(timer);
        handler(socket);
        socket.resume();
      }
      pending.clear();
    },
    async close() {
      for (const [socket, timer] of pending) {
        clearTimeout(timer);
        socket.destroy();
      }
      pending.clear();
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    },
  };
}
export type LoopbackReservation = Awaited<ReturnType<typeof reserveLoopback>>;

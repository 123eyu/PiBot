import { createRequire } from "node:module";
import type { ConnectProgress, SocketConstructor } from "@pibot/link";
import { type LinkNetwork, relayDispatcher } from "./socket.ts";

/**
 * How long a retired socket may wait for the relay's close receipt before its dispatcher is
 * destroyed. Waiting for the receipt alone held every runner reconnect behind a drain that a
 * dead TCP path only confirms minutes later (Linux acceptance F2, 2026-11-11: 184 s to > 5 min).
 */
const CLOSE_GRACE_MS = 2000;

/** Keep proxy dispatchers owned until their actual socket close has drained. */
export function runnerNetwork(network: LinkNetwork) {
  // Network implementation is unused during brain registration and first-screen reads.
  const { WebSocket: NetworkSocket } = createRequire(import.meta.url)(
    "undici",
  ) as typeof import("undici");
  const releases: Promise<void>[] = [];
  const checkClosed: (() => void)[] = [];
  const Socket: SocketConstructor =
    network.WebSocket ??
    (class extends NetworkSocket {
      readonly connectProgress: ConnectProgress;
      constructor(url: string) {
        const proxy = network.proxy?.();
        const progress: ConnectProgress = { step: "dns" };
        const raw: { destroy(): void }[] = [];
        const dispatcher = relayDispatcher(
          proxy,
          proxy ? undefined : { progress, socket: (socket) => raw.push(socket) },
        );
        try {
          super(url, { dispatcher });
        } catch (error) {
          const pending = dispatcher.destroy();
          void pending.catch(() => {});
          releases.push(pending);
          throw error;
        }
        this.connectProgress = progress;
        let released = false;
        let release!: () => void;
        const pending = new Promise<void>((resolve, reject) => {
          release = () => {
            if (released) return;
            released = true;
            void dispatcher.destroy().then(resolve, reject);
          };
        });
        void pending.catch(() => {});
        releases.push(pending);
        this.addEventListener("close", release, { once: true });
        // Failed opens can reach CLOSED through an error without delivering close to consumers.
        // A socket still open or closing gets a short grace for its receipt, then its TCP
        // connection is cut: the session it carried is already retired, and the cut also
        // delivers the close event the room owner waits for.
        checkClosed.push(() => {
          if (this.readyState === 3) {
            release();
            return;
          }
          const timer = setTimeout(() => {
            for (const socket of raw) socket.destroy();
            release();
          }, CLOSE_GRACE_MS);
          timer.unref?.();
        });
      }
    } as unknown as SocketConstructor);
  return {
    WebSocket: Socket,
    async drain() {
      for (const check of checkClosed.splice(0)) check();
      const results = await Promise.allSettled(releases);
      if (results.some((result) => result.status === "rejected"))
        throw new Error("remote_socket_drain_failed");
    },
  };
}

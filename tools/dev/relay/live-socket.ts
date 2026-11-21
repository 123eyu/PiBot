import {
  type BinaryTransport,
  connectRelay,
  type NoiseChannel,
  type RoomTicket,
} from "../../../packages/link/src/index.ts";
export function roomUrl(base: string, ticket: RoomTicket, role: "desktop" | "phone") {
  return `${base.replace(/^http/, "ws")}/room/${ticket.roomId}?credential=${ticket.credential}&period=${ticket.period}&role=${role}`;
}
export async function endpoint(base: string, ticket: RoomTicket, role: "desktop" | "phone") {
  const lifetime = new AbortController();
  let online = false;
  const history: boolean[] = [];
  const changes = new Set<() => void>();
  let client: ReturnType<typeof connectRelay>;
  let signal: AbortSignal | undefined;
  const transport = await new Promise<BinaryTransport>((resolve, reject) => {
    const timer = setTimeout(() => {
      lifetime.abort();
      reject(new Error("socket_open_timeout"));
    }, 5000);
    client = connectRelay({
      WebSocket,
      url: () => roomUrl(base, ticket, role),
      signal: lifetime.signal,
      onConnect(wire, connection) {
        signal = connection;
        clearTimeout(timer);
        resolve(wire);
      },
      onPresence(present) {
        online = present;
        history.push(present);
        for (const fn of changes) fn();
      },
      onError() {
        clearTimeout(timer);
        lifetime.abort();
        reject(new Error("socket_failed"));
      },
    });
  });
  return {
    transport,
    signal: signal as AbortSignal,
    presence: () => online,
    /** Every presence frame in arrival order, for checking offline -> online transitions. */
    presenceHistory: () => [...history],
    async waitPresence(expected: boolean) {
      if (online === expected) return;
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          if (online === expected) {
            clearTimeout(timer);
            changes.delete(done);
            resolve();
          }
        };
        const timer = setTimeout(() => {
          changes.delete(done);
          reject(new Error("presence_timeout"));
        }, 5000);
        changes.add(done);
      });
    },
    close() {
      lifetime.abort();
      client.stop();
      changes.clear();
    },
  };
}
export class Frames {
  private queue: Uint8Array[] = [];
  private pending?: {
    resolve: (frame: Uint8Array) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  private off: () => void;
  constructor(wire: BinaryTransport) {
    this.off = wire.subscribe((frame) => {
      if (this.pending) {
        clearTimeout(this.pending.timer);
        const current = this.pending;
        this.pending = undefined;
        current.resolve(frame);
      } else {
        if (this.queue.length >= 8) throw new Error("probe_frame_overflow");
        this.queue.push(frame);
      }
    });
  }
  async next(ms = 5000) {
    if (this.queue.length) return this.queue.shift() as Uint8Array;
    if (this.pending) throw new Error("probe_concurrent_read");
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(new Error("probe_frame_timeout"));
      }, ms);
      this.pending = { resolve, reject, timer };
    });
  }
  dispose() {
    this.off();
    this.queue = [];
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error("probe_closed"));
      this.pending = undefined;
    }
  }
}
export interface LivePair {
  desktop: Awaited<ReturnType<typeof endpoint>>;
  phone: Awaited<ReturnType<typeof endpoint>>;
  dc: NoiseChannel;
  pc: NoiseChannel;
  dr: Frames;
  pr: Frames;
  close(): void;
}

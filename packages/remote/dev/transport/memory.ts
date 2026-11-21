import { randomUUID } from "node:crypto";
import type { Port } from "@pibot/protocol-base";
import type { PairedPhone, RemoteLinkPort } from "@pibot/remote/brain";

export function memoryPorts() {
  const a = new Set<(message: unknown) => void>();
  const b = new Set<(message: unknown) => void>();
  const ac = new Set<(id: string) => void>();
  const bc = new Set<(id: string) => void>();
  const make = (
    own: typeof a,
    other: typeof a,
    ownCancel: typeof ac,
    otherCancel: typeof ac,
  ): Port => ({
    post(value) {
      const snapshot = structuredClone(value);
      queueMicrotask(() => {
        for (const listener of other) listener(snapshot);
      });
    },
    onMessage(listener) {
      own.add(listener);
      return () => {
        own.delete(listener);
      };
    },
    cancelRequest(id) {
      queueMicrotask(() => {
        for (const listener of otherCancel) listener(id);
      });
    },
    onRequestCancel(listener) {
      ownCancel.add(listener);
      return () => {
        ownCancel.delete(listener);
      };
    },
    dispose() {
      own.clear();
      ownCancel.clear();
    },
  });
  return { a: make(a, b, ac, bc), b: make(b, a, bc, ac) };
}
/** No encryption/authentication: a development fixture, never imported by the production entry. */
export function createMemoryRemoteLink() {
  const pairings = new Map<
    string,
    { resolve(phone: PairedPhone): void; reject(error: Error): void }
  >();
  const sessions = new Map<string, { phone: Port; online(value: boolean): void; close(): void }>();
  const pushes: { kind: string; route: Record<string, string> }[] = [];
  const revoked = new Set<string>();
  const link: RemoteLinkPort = {
    kind: "development",
    officialRelayUrl: "wss://development.invalid",
    async createIdentity(signal) {
      signal.throwIfAborted();
      return {
        publicKey: `development-public-${randomUUID()}`,
        privateKey: `development-private-${randomUUID()}`,
      };
    },
    async pair({ signal }) {
      signal.throwIfAborted();
      const id = randomUUID();
      const completed = new Promise<PairedPhone>((resolve, reject) =>
        pairings.set(id, { resolve, reject }),
      );
      const abort = () => pairings.get(id)?.reject(new Error("development_pair_cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      return {
        payload: `development-only:${id}`,
        completed,
        async close() {
          signal.removeEventListener("abort", abort);
          pairings.delete(id);
        },
      };
    },
    async connect({ publicKey, room, signal }) {
      signal.throwIfAborted();
      if (revoked.has(room)) throw new Error("development_room_revoked");
      const ports = memoryPorts();
      const listeners = new Set<(online: boolean) => void>();
      let online = false;
      const publish = (value: boolean) => {
        online = value;
        for (const listener of listeners) listener(value);
      };
      const close = () => {
        ports.a.dispose?.();
        ports.b.dispose?.();
        listeners.clear();
        sessions.delete(publicKey);
      };
      sessions.set(publicKey, { phone: ports.b, online: publish, close });
      return {
        port: ports.a,
        async close() {
          close();
        },
        onPresence(listener) {
          listeners.add(listener);
          listener(online);
          return () => {
            listeners.delete(listener);
          };
        },
      };
    },
    async push(input) {
      input.signal.throwIfAborted();
      if (revoked.has(input.room)) throw new Error("development_room_revoked");
      pushes.push({ kind: input.kind, route: input.route });
    },
    async revoke(input) {
      input.signal.throwIfAborted();
      revoked.add(input.room);
    },
  };
  return {
    link,
    pushes,
    pendingPairings: () => [...pairings.keys()],
    completePair(id: string, phone: PairedPhone) {
      const pairing = pairings.get(id);
      if (!pairing) throw new Error("development_pair_missing");
      pairing.resolve(phone);
    },
    phone(publicKey: string) {
      const session = sessions.get(publicKey);
      if (!session) throw new Error("development_session_missing");
      session.online(true);
      return session.phone;
    },
    disconnectPhone(publicKey: string) {
      sessions.get(publicKey)?.online(false);
    },
  };
}

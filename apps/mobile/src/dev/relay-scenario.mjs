import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  acceptIdentity,
  base64url,
  createEndpoint,
  createPairingPayload,
  deriveRoomKey,
  destroyEndpoint,
  encodePairing,
  encryptedPort,
  establishNoise,
  identityProof,
  pairingLease,
  pairingPrologue,
  pairingRoom,
  roomTicket,
  safetyCode,
  sharedSecret,
} from "@pibot/link";
import { createPeer, EventBuffer, Events, Methods } from "@pibot/protocol";
import { endpoint } from "../../../../tools/dev/relay/live-socket.ts";
import { startRuntime } from "../../../../tools/dev/relay/local-runtime.ts";
import { MobileRuntime } from "../runtime/runtime.ts";
import { memoryBlobFiles } from "../storage/file-cache.ts";
import { MobileStorage } from "../storage/state.ts";
import { createMobileLink } from "../transport/real-link.ts";
import { MobileRemoteMethods } from "../transport/remote-peer.ts";

const advertised = "wss://mobile-probe.invalid";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 25_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("mobile_relay_probe_timeout");
    await delay(25);
  }
}
function next(port, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      off();
      reject(new Error("probe_closed"));
    };
    const off = port.onMessage((value) => {
      off();
      signal.removeEventListener("abort", abort);
      resolve(value);
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Only this development socket rewrites the advertised wss QR to loopback Wrangler. */
export async function runRelayScenario() {
  const relay = await startRuntime();
  const desktop = createEndpoint(randomBytes);
  const lifetime = new AbortController();
  const values = new Map(),
    secrets = new Map();
  const storage = new MobileStorage(
    {
      async get(key) {
        return structuredClone(values.get(key));
      },
      async put(key, value) {
        values.set(key, structuredClone(value));
      },
      async removePrefix(prefix) {
        for (const key of values.keys()) if (key.startsWith(prefix)) values.delete(key);
      },
      async close() {},
    },
    {
      async get(key) {
        return secrets.get(key) ?? null;
      },
      async set(key, value) {
        secrets.set(key, value);
      },
      async remove(key) {
        secrets.delete(key);
      },
    },
    memoryBlobFiles(),
  );
  const link = createMobileLink({
    WebSocket: class extends WebSocket {
      constructor(url) {
        super(url.replace(advertised, relay.base.replace(/^http/, "ws")));
      }
    },
    random: randomBytes,
  });
  // This scenario exercises suspension/reconnect, rather than the production 30-second grace.
  const app = new MobileRuntime(storage, link, 0);
  const id = crypto.randomUUID(),
    deviceId = crypto.randomUUID();
  const botId = crypto.randomUUID(),
    topicId = crypto.randomUUID();
  const qr = createPairingPayload(advertised, desktop.signingPublic, "Relay desktop", randomBytes);
  const lease = pairingLease(qr.psk, qr.expiresAt);
  const pairRoom = await endpoint(relay.base, pairingRoom(qr), "desktop");
  const rotation = randomBytes(32);
  let session,
    peer,
    closed = false,
    count = 0,
    pushes = 0,
    resumes = 0,
    sessions = 0,
    securityCode;
  let roomKey, phonePublic;
  const receipts = new Map();
  const pairing = (async () => {
    const channel = await establishNoise(pairRoom.transport, {
      role: "responder",
      staticSecret: desktop.dhSecret,
      psk: lease.claim(),
      random: randomBytes,
      prologue: pairingPrologue(qr),
      signal: pairRoom.signal,
      timeoutMs: 25_000,
    });
    const port = encryptedPort(channel, pairRoom.transport, { signal: pairRoom.signal });
    try {
      const identity = acceptIdentity(await next(port, pairRoom.signal), channel);
      phonePublic = identity.publicKey;
      securityCode = safetyCode(desktop.signingPublic, phonePublic);
      const shared = sharedSecret(desktop, phonePublic);
      roomKey = deriveRoomKey(shared, rotation);
      shared.fill(0);
      const ack = next(port, pairRoom.signal);
      port.post({
        identity: identityProof(desktop, channel, "Relay desktop"),
        rotation: base64url(rotation),
      });
      assert.deepEqual(await ack, { paired: true });
      lease.commit();
    } finally {
      port.dispose();
      pairRoom.close();
    }
  })();
  const serving = (async () => {
    await pairing;
    while (!closed) {
      session = await endpoint(relay.base, roomTicket(roomKey), "desktop");
      try {
        await session.waitPresence(true);
        const channel = await establishNoise(session.transport, {
          role: "responder",
          staticSecret: desktop.dhSecret,
          remoteStatic: (await import("@pibot/link")).dhPublic(phonePublic),
          random: randomBytes,
          signal: session.signal,
          timeoutMs: 25_000,
        });
        const port = encryptedPort(channel, session.transport, { signal: session.signal });
        const buffer = new EventBuffer(Events);
        // Count resume without replacing its real Peer handler.
        const wire = {
          ...port,
          onMessage(fn) {
            return port.onMessage((value) => {
              if (value?.method === "events.resume") resumes++;
              fn(value);
            });
          },
        };
        peer = createPeer(wire, {
          methods: { ...Methods, ...MobileRemoteMethods },
          events: Events,
          eventBuffer: buffer,
        });
        peer.handle("devices.self", () => ({
          desktopId: id,
          desktopName: "Relay desktop",
          deviceId,
          deviceName: "Relay phone",
        }));
        peer.handle("remote.session.update", () => {
          pushes++;
          return { ok: true };
        });
        peer.handle("chat.send", (params) => {
          if (receipts.has(params.clientMessageId)) return receipts.get(params.clientMessageId);
          count++;
          const result = {
            runId: crypto.randomUUID(),
            userMessageId: crypto.randomUUID(),
            assistantMessageId: crypto.randomUUID(),
            conversationId: params.topicId,
          };
          receipts.set(params.clientMessageId, result);
          return result;
        });
        sessions++;
        await new Promise((resolve) => {
          const timer = setInterval(() => {
            if (closed || !session.presence()) {
              clearInterval(timer);
              resolve();
            }
          }, 25);
        });
      } catch {
        if (!closed) await delay(50);
      } finally {
        peer?.dispose();
        session?.close();
      }
      if (!closed) await delay(50);
    }
  })();
  // Attach immediately: startup failures must not become unhandled rejections.
  void serving.catch(() => {});
  try {
    await assert.rejects(link.pair("pibot-pair:invalid", "Relay phone", lifetime.signal));
    const candidate = await app.preparePair(encodePairing(qr), "Relay phone");
    assert.equal(candidate.id, id);
    assert.equal(candidate.safetyCode, securityCode);
    assert.equal(secrets.size, 0);
    console.log("mobile relay: authenticated pairing and matching safety code PASS");
    await app.savePair();
    await until(() => app.getSnapshot().status === "online");
    assert.equal(secrets.size, 1);
    assert.ok(!JSON.stringify(app.getSnapshot()).includes("roomKey"));
    console.log("mobile relay: reconnect and events.resume PASS");
    await app.send({ botId, topicId }, "probe payload");
    await until(() => app.getSnapshot().pending === 0);
    assert.equal(count, 1);
    await app.registerPush("ExpoPushToken[local_probe]", "zh", id);
    assert.equal(pushes, 1);
    const beforeDeadline = sessions;
    await delay(21_000);
    assert.equal(app.getSnapshot().status, "online");
    assert.equal(sessions, beforeDeadline);
    const before = resumes;
    await app.setForeground(false);
    await app.send({ botId, topicId }, "queued payload");
    assert.equal(app.getSnapshot().pending, 1);
    await app.setForeground(true);
    await until(() => app.getSnapshot().status === "online" && app.getSnapshot().pending === 0);
    assert.ok(resumes > before);
    assert.equal(count, 2);
    await app.forget(id);
    assert.equal(secrets.size, 0);
    assert.equal((await storage.computers()).length, 0);
    assert.equal(app.getSnapshot().status, "offline");
    return {
      scenarios: 8,
      handshakeDeadlineIsolation: true,
      relay: "local workerd",
      realNoise: true,
      sends: count,
      resumes,
      secretsAfterForget: secrets.size,
    };
  } finally {
    closed = true;
    lifetime.abort();
    pairRoom.close();
    peer?.dispose();
    session?.close();
    await app.dispose();
    await serving;
    lease.dispose();
    destroyEndpoint(desktop);
    rotation.fill(0);
    roomKey?.fill(0);
    await relay.close();
  }
}

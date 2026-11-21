// Production RN JS socket/session + real Noise/brain/relay; native close receipts are withheld.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { startBrain } from "../../../packages/brain-app/src/index.ts";
import { createPeer, Events, Methods } from "../../../packages/protocol/src/index.ts";
import { startRelay } from "../../../packages/remote/dev/relay.ts";
import { memoryPorts } from "../../../packages/remote/dev/transport/memory.ts";
import { createRemoteLink } from "../../../packages/remote/src/brain/link/adapter.ts";
import { captureLinkLog } from "./link-log.mjs";
import { bundlePhone } from "./real-link-bundle.mjs";
import { persistedPhoneStorage } from "./real-link-io.mjs";
import {
  assertRetiredSockets,
  attachRecoverySockets,
  recoveryDiscovery,
} from "./socket-recovery-io.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const root = await realpath(await mkdtemp(join(tmpdir(), "pibot-socket-recovery-")));
const disk = persistedPhoneStorage(root);
const { a, b } = memoryPorts();
const desktop = createPeer(b, { methods: Methods, events: Events });
const modules = [];
const sockets = [];
const owners = [];
let relay, brain, mobile;
let stage = "bundle";
const stats = { connects: 0, lan: 0, scans: 0, active: 0 };
let mutations = 0;
let failOwnerClose = false;
const log = captureLinkLog();
const ref = process.argv.find((arg) => arg.startsWith("--mobile-ref="))?.slice(13);
// An older phone (--mobile-ref, for before/after measurements) is measured, not held to resumes.
const legacy = !!ref;
const measured = [];
/**
 * Waits for the session that `trigger` (re)starts. `expect`: "resumed" keeps the Peer the
 * screens hold (no reload), "full" must hand them a new one.
 */
async function online(label, previous, expect, trigger = async () => {}) {
  const mark = log.mark();
  const startedAt = Date.now();
  await trigger();
  const end = Date.now() + 20_000;
  while (
    mobile.getSnapshot().status !== "online" ||
    !log.since(mark).some((entry) => entry.event === "session_opened") ||
    (!legacy && expect === "full" && previous && mobile.getSnapshot().peer === previous)
  ) {
    if (Date.now() > end) throw new Error(`${stage}_timeout`);
    await delay(20);
  }
  const usableMs = Date.now() - startedAt;
  assert.ok((await mobile.call("bots.list", {})).length);
  const current = mobile.getSnapshot().peer;
  const { resume } = log.summary(`${label} usable=${usableMs}`, mark);
  measured.push({ label, usableMs, mode: resume?.mode ?? "legacy" });
  if (!legacy && expect) assert.equal(resume?.mode, expect, `${label} refresh`);
  if (!legacy && expect === "resumed") assert.equal(current, previous, `${label} keeps the Peer`);
  if (previous && (legacy || expect === "full"))
    await assert.rejects(previous.call("bots.list", {}, { timeoutMs: 1000 }));
  return current;
}

async function open(phone, Socket, cold = false) {
  phone.configureStorage(disk);
  const storage = new phone.MobileStorage(
    await phone.openLocalData(),
    phone.secretData,
    phone.memoryBlobFiles(),
  );
  const link = phone.createMobileLink({
    WebSocket: attachRecoverySockets(phone, Socket, owners, stats),
    random: (size) => new Uint8Array(randomBytes(size)),
    discoverLan: recoveryDiscovery(stats),
  });
  return new phone.MobileRuntime(
    storage,
    {
      ...link,
      ...(cold
        ? {
            pair() {
              throw new Error("restart_must_not_repair");
            },
          }
        : {}),
      async connect(...args) {
        const connection = await link.connect(...args);
        const post = connection.port.post;
        connection.port.post = (message) => {
          if (message?.method === "routines.pauseAll") mutations++;
          return post(message);
        };
        return {
          ...connection,
          async close() {
            await connection.close();
            if (failOwnerClose) {
              failOwnerClose = false;
              throw new Error("drain_unconfirmed");
            }
          },
        };
      },
    },
    0,
  );
}

function detached(phone) {
  assertRetiredSockets(phone, owners, stats);
}

try {
  const phone = await bundlePhone(repo, root, ref, "phone");
  modules.push(phone);
  stage = "relay";
  relay = await startRelay(root);
  const Socket = class extends WebSocket {
    constructor(url) {
      super(url.replace("wss://relay.invalid", relay.base.replace(/^http/, "ws")));
      sockets.push(this);
    }
  };
  stage = "brain";
  brain = await startBrain({
    port: a,
    dataDir: join(root, "brain"),
    version: "socket-recovery-probe",
    platform: process.platform,
    dev: true,
    remote: { link: createRemoteLink({ WebSocket: Socket }) },
    host: {
      secrets: {
        isAvailable: async () => true,
        encrypt: async (value) => Buffer.from(value),
        decrypt: async (value) => Buffer.from(value).toString(),
      },
      env: {
        detect: async () => [],
        read: async () => {
          throw new Error("no_credentials");
        },
      },
      pickFolder: async () => root,
    },
  });
  await desktop.call("remote.settings.set", {
    expectedVersion: 0,
    disclosureAccepted: true,
    patch: { enabled: true, relay: "custom", relayUrl: "wss://relay.invalid" },
  });
  mobile = await open(phone, Socket);
  await mobile.initialize();
  stage = "close_never_confirmed_pair";
  const pairing = await desktop.call("devices.pairStart", undefined);
  await mobile.preparePair(pairing.payload, "Socket recovery");
  let peer = await online("pair", undefined, "full", () => mobile.savePair());
  detached(phone);
  console.log("PASS close never confirmed during pairing still permits fresh Noise/Peer");

  // A real mutating RPC is sent once; none of the following restarts may replay it.
  await mobile.call("routines.pauseAll", { until: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(mutations, 1);
  stage = "close_never_confirmed_reconnect";
  peer = await online("background_return", peer, "resumed", async () => {
    await mobile.setForeground(false);
    detached(phone);
    await mobile.setForeground(true);
  });
  console.log("PASS close never confirmed permits foreground reconnect that resumes its Peer");

  stage = "network_change_close_timeout";
  const before = stats.connects;
  peer = await online("network_change", peer, "resumed", () => mobile.networkChanged());
  assert.ok(stats.connects > before);
  detached(phone);
  console.log(
    "PASS network change + missing native close receipt reconnects and ignores stale events",
  );

  stage = "transient_owner_cleanup";
  failOwnerClose = true;
  peer = await online("owner_cleanup_failed", peer, "resumed", () => mobile.networkChanged());
  assert.equal(failOwnerClose, false);
  console.log("PASS transient transport owner cleanup failure does not latch future sessions");
  detached(phone);
  assert.ok(owners.filter((socket) => socket.probeLan).length >= 3);
  assert.ok(stats.scans >= 3);
  console.log(
    "PASS repeated losing LAN generations leave zero transport/native/scanner listeners and preserve relay",
  );

  const raw = await disk.raw();
  stage = "app_restart";
  await mobile.dispose();
  mobile = undefined;
  detached(phone);
  phone.disposeProbeGlobals();
  owners.length = 0;
  const cold = await bundlePhone(repo, root, ref, "cold-phone");
  modules.push(cold);
  mobile = await open(cold, Socket, true);
  await online("cold_start", peer, "full", () => mobile.initialize());
  assert.ok(
    JSON.stringify(await disk.raw()) === JSON.stringify(raw),
    "restart must preserve saved identity and registry",
  );
  assert.equal(mutations, 1, "transport recovery must not replay a mutation");
  console.log(
    "PASS separate app bundle restarts with saved pairing, new handshake/Peer, no mutation replay",
  );
  stage = "forget";
  await mobile.forget(mobile.getSnapshot().selectedId);
  const forgotten = await disk.raw();
  assert.deepEqual(forgotten.secure, {});
  assert.deepEqual(JSON.parse(forgotten.registry), []);
  detached(cold);
  console.log("PASS missing close confirmation does not block local forget");
  const counts = { resumed: 0, full: 0, legacy: 0 };
  for (const row of measured) counts[row.mode]++;
  console.log(
    `MEASURE refreshes: resumed=${counts.resumed} full=${counts.full} legacy=${counts.legacy}`,
  );
} catch (error) {
  console.error(`FAIL ${stage}: ${error instanceof Error ? error.message : "unknown"}`);
  process.exitCode = 1;
} finally {
  let cleanupFailed = false;
  try {
    await mobile?.dispose();
  } catch {
    cleanupFailed = true;
  }
  for (const socket of sockets) socket.close();
  desktop.dispose();
  const cleanup = await Promise.allSettled([brain?.stop(), relay?.close()]);
  for (const phone of modules) phone.disposeProbeGlobals();
  disk.close();
  await rm(root, { recursive: true, force: true });
  if (cleanupFailed || cleanup.some((result) => result.status === "rejected")) {
    console.error("FAIL cleanup");
    process.exitCode = 1;
  }
}

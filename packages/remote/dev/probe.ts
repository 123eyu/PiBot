// Manual development probe; no model, network, keychain or cryptographic claims.
// node --import ./tools/dev/ts-hooks.mjs packages/remote/dev/probe.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createPeer, Events, Methods, RpcError, RpcErrorCodes } from "@pibot/protocol";
import { KernelEvents, KernelMethods } from "@pibot/protocol-base";
import { RelayUrlSchema } from "@pibot/remote-contract";
import { registerBusinessRpc } from "../../brain/src/runtime/startup/business-rpc.ts";
import { PhoneBrowser } from "../src/brain/browser/phone-browser.ts";
import { PhoneEventBuffer } from "../src/brain/rpc/event-buffer.ts";
import { phoneGateway } from "../src/brain/rpc/gateway.ts";
import { remoteKernelBridge } from "../src/brain/rpc/kernel-bridge.ts";
import { phoneSettingsGuard } from "../src/brain/rpc/settings-gate.ts";
import { RemoteDevicesRepo, RemoteReceiptsRepo, RemoteSettingsRepo } from "../src/store/index.ts";
import { memoryPorts } from "./transport/memory.ts";

async function main() {
  const db = new DatabaseSync(":memory:");
  const migration = readFileSync(
    new URL("../../storage/migrations/0070_remote_devices.sql", import.meta.url),
    "utf8",
  );
  // Applying the append-only migration twice also verifies its empty-database idempotency.
  db.exec(migration);
  db.exec(migration);
  const settings = new RemoteSettingsRepo(db);
  assert.equal(settings.get().enabled, false);
  assert.equal(RelayUrlSchema.safeParse("wss://user:secret@relay.invalid").success, false);
  const devices = new RemoteDevicesRepo(db);
  const receipts = new RemoteReceiptsRepo(db);
  const id = randomUUID();
  devices.add({
    id,
    name: "Development phone",
    publicKey: "development-public-key",
    room: "development-room",
  });
  assert.equal(devices.page({ limit: 1 }).items.length, 1);
  assert.equal(devices.page({ limit: 1 }).items[0]?.publicKey, "development-public-key");
  let settingsReadSignal: AbortSignal | undefined;
  const settingsRequest = new AbortController();
  const settingsGuard = phoneSettingsGuard({
    kernel: {
      dispatch(_method, _params, context) {
        settingsReadSignal = context.signal;
        return new Promise((_resolve, reject) => {
          const abort = () => reject(context.signal.reason);
          if (context.signal.aborted) abort();
          else context.signal.addEventListener("abort", abort, { once: true });
        });
      },
      subscribe: () => () => {},
    },
    deviceId: id,
    signal: new AbortController().signal,
    audit: () => undefined,
  });
  const guardedSettings = settingsGuard(
    "connectors.update",
    {
      id: randomUUID(),
      expectedRevision: 1,
      access: { mode: "selected", bots: [], groups: [] },
    },
    settingsRequest.signal,
  );
  settingsRequest.abort();
  await assert.rejects(guardedSettings);
  assert.equal(settingsReadSignal?.aborted, true);
  const wrapperWire = memoryPorts();
  const wrapperPeer = createPeer(wrapperWire.a, { methods: KernelMethods, events: KernelEvents });
  const wrapperClient = createPeer(wrapperWire.b, { methods: KernelMethods, events: KernelEvents });
  let wrapperEntered!: () => void;
  let wrapperSignalAborted = false;
  const enteredWrapper = new Promise<void>((resolve) => {
    wrapperEntered = resolve;
  });
  registerBusinessRpc(
    {
      stopping: false,
      // This transport-only fixture has no credential capability or content preparation owner.
      waitForContent: async (signal) => signal.throwIfAborted(),
      sleep: undefined,
      interactiveAttached: true,
      offlineAllowed: new Set(),
      db,
      requests: new Set(),
      backgroundPrefixes: [],
      interactiveRequests: new Set(),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      peer: wrapperPeer,
    },
    "bots.list",
    async (_params, { signal }) => {
      wrapperEntered();
      await new Promise<void>((resolve) => {
        const abort = () => {
          wrapperSignalAborted = true;
          resolve();
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
      return [];
    },
  );
  const wrapperAbort = new AbortController();
  const wrapped = wrapperClient.call("bots.list", {}, { signal: wrapperAbort.signal });
  await enteredWrapper;
  wrapperAbort.abort();
  await assert.rejects(wrapped);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(wrapperSignalAborted, true);
  wrapperClient.dispose();
  wrapperPeer.dispose();
  const bridge = remoteKernelBridge(memoryPorts().a);
  // This schema Peer simulates the kernel wrapper. Real brain acceptance remains a separate gate.
  const server = createPeer(bridge.port, { methods: Methods, events: Events });
  let sends = 0;
  let stops = 0;
  let approvals = 0;
  let listDispatches = 0;
  let cancelProbe = false;
  let cancelEntered!: () => void;
  let handlerAborted = false;
  const entered = new Promise<void>((resolve) => {
    cancelEntered = resolve;
  });
  server.handle("bots.list", async (_params, { signal: requestSignal }) => {
    listDispatches++;
    if (!cancelProbe) return [];
    cancelEntered();
    await new Promise<void>((resolve) => {
      const abort = () => {
        handlerAborted = true;
        resolve();
      };
      if (requestSignal.aborted) abort();
      else requestSignal.addEventListener("abort", abort, { once: true });
    });
    return [];
  });
  server.handle("chat.send", async () => {
    sends++;
    return {
      userMessageId: randomUUID(),
      assistantMessageId: randomUUID(),
      runId: randomUUID(),
      conversationId: randomUUID(),
    };
  });
  server.handle("chat.abort", async () => {
    stops++;
    return { ok: true };
  });
  server.handle("approvals.resolve", async () => {
    approvals++;
    return { ok: true };
  });
  const wire = memoryPorts();
  const audits: { method: string; outcome: string }[] = [];
  const buffer = new PhoneEventBuffer();
  const signal = new AbortController();
  let guardCancelProbe = false;
  let guardEntered!: () => void;
  let releaseGuard!: () => void;
  let guardSignalAborted = false;
  const enteredGuard = new Promise<void>((resolve) => {
    guardEntered = resolve;
  });
  const releaseGuardWork = new Promise<void>((resolve) => {
    releaseGuard = resolve;
  });
  const gateway = phoneGateway({
    deviceId: id,
    port: wire.a,
    kernel: bridge.kernel,
    buffer,
    receipts,
    signal: signal.signal,
    active: () => {
      signal.signal.throwIfAborted();
      devices.active(id);
    },
    self: () => ({
      desktopId: settings.desktopId(),
      desktopName: "Pi Bot",
      deviceId: id,
      deviceName: "Development phone",
    }),
    update: async () => ({ ok: true }),
    browser: new PhoneBrowser({
      deviceId: id,
      ports: { get: () => undefined },
      audit: (method, outcome) => audits.push({ method, outcome }),
      warn: () => undefined,
    }),
    guard: async (_method, params, requestSignal) => {
      if (!guardCancelProbe) return params;
      guardEntered();
      await releaseGuardWork;
      guardSignalAborted = requestSignal.aborted;
      return params;
    },
    audit: (method, outcome) => audits.push({ method, outcome }),
  });
  const client = createPeer(wire.b, { methods: Methods, events: Events, timeoutMs: 1000 });
  const offEvents = bridge.kernel.subscribe((event) =>
    gateway.emit(event.method, event.payload, true),
  );
  try {
    assert.deepEqual(await client.call("bots.list", {}), []);
    assert.equal((await client.call("devices.self", undefined)).deviceId, id);
    const request = {
      botId: randomUUID(),
      text: "Development probe",
      clientMessageId: randomUUID(),
    };
    const first = await client.call("chat.send", request);
    assert.deepEqual(await client.call("chat.send", request), first);
    assert.equal(sends, 1);
    await assert.rejects(
      client.call("chat.send", { ...request, text: "Different input" }),
      (error: unknown) => error instanceof RpcError && error.code === RpcErrorCodes.invalidParams,
    );
    await client.call("approvals.resolve", {
      id: randomUUID(),
      decision: "allow",
      remember: false,
    });
    await client.call("chat.abort", { runId: first.runId });
    assert.equal(approvals, 1);
    assert.equal(stops, 1);
    await assert.rejects(
      client.call("settings.get", undefined),
      (error: unknown) => error instanceof RpcError && error.code === RpcErrorCodes.methodNotFound,
    );
    await assert.rejects(
      client.call("chat.send", {
        ...request,
        clientMessageId: randomUUID(),
        initialMode: "execute",
        newTopic: true,
      }),
      (error: unknown) => error instanceof RpcError && error.code === RpcErrorCodes.invalidParams,
    );
    server.emit("providers.changed", {});
    server.emit("chat.delta", {
      runId: first.runId,
      messageId: first.assistantMessageId,
      text: "Delta",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const replay = await client.call("events.resume", { afterSeq: 0 });
    assert.equal(replay.length, 1);
    assert.equal(replay[0]?.method, "chat.delta");
    assert.equal(
      audits.some((a) => a.method === "unavailable_method" && a.outcome === "refused"),
      true,
    );
    assert.equal(
      audits.some((a) => a.method === "approvals.resolve" && a.outcome === "allowed"),
      true,
    );
    const bounded = new PhoneEventBuffer();
    for (let i = 0; i < 60; i++)
      bounded.append("chat.delta", {
        runId: first.runId,
        messageId: first.assistantMessageId,
        text: "x".repeat(50_000),
      });
    assert.throws(() => bounded.resume(0), /remote_history_unavailable/);
    assert.equal(bounded.resume(59).length, 1);
    cancelProbe = true;
    const cancel = new AbortController();
    const pending = client.call("bots.list", {}, { signal: cancel.signal });
    await entered;
    cancel.abort();
    await assert.rejects(pending);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(handlerAborted, true);
    wire.b.cancelRequest?.(randomUUID());
    cancelProbe = false;
    assert.deepEqual(await client.call("bots.list", {}), []);
    const beforeGuardCancel = listDispatches;
    guardCancelProbe = true;
    const guardCancel = new AbortController();
    const guarded = client.call("bots.list", {}, { signal: guardCancel.signal });
    await enteredGuard;
    guardCancel.abort();
    releaseGuard();
    await assert.rejects(guarded);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(guardSignalAborted, true);
    assert.equal(listDispatches, beforeGuardCancel);
    guardCancelProbe = false;
    const uncertainId = randomUUID();
    receipts.begin(id, uncertainId, "fingerprint");
    assert.throws(() => receipts.begin(id, uncertainId, "fingerprint"), /remote_message_uncertain/);
    devices.revoke(id);
    await assert.rejects(
      client.call("bots.list", {}),
      (error: unknown) => error instanceof RpcError && error.code === RpcErrorCodes.closed,
    );
    console.log(
      "Development probe: the production RPC wrapper, settings guard reads and gateway dispatch honor request cancellation, cancellation reached the desktop handler, unknown cancellation was ignored, and the existing repositories, receipts, replay, audit and revocation checks passed. No real link/relay/model exercised.",
    );
  } finally {
    client.dispose();
    offEvents();
    await gateway.close();
    server.dispose();
    db.close();
  }
}
await main();

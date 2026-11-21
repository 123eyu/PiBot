// Manual synthetic exercise; never installs a user service or reads a real profile/keychain.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "@pibot/observability";
import {
  BackgroundControlSchema,
  BackgroundPreferencesSchema,
  type BackgroundWire,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import { createRoutineHost } from "@pibot/routines/host";
import { BackgroundPreferencesRepo, openDatabase, runMigrations } from "@pibot/storage";
import { connectBackground } from "../../src/main/background/background-connection.ts";
import {
  readDescriptor,
  reserveDescriptor,
} from "../../src/main/background/background-directory.ts";
import { waitBackgroundExit } from "../../src/main/background/background-exit.ts";
import { createBackgroundManagement } from "../../src/main/background/background-management.ts";
import { applyBackgroundPreferences } from "../../src/main/background/background-preferences.ts";
import { createBackgroundServer } from "../../src/main/background/background-server.ts";
import { framedSocket, MAX_FRAME } from "../../src/main/background/background-wire.ts";

const directory = await mkdtemp("/private/tmp/pibot-bg-probe-");
const logger = { info() {}, warn() {}, error() {} } as Logger;
const outputs: string[] = [];
const passed = (name: string) => outputs.push(name);
let server: Awaited<ReturnType<typeof createBackgroundServer>> | undefined;
let reservation: Awaited<ReturnType<typeof reserveDescriptor>> | undefined;
const connections: Awaited<ReturnType<typeof connectBackground>>[] = [];
let db: ReturnType<typeof openDatabase> | undefined;
try {
  reservation = await reserveDescriptor(directory, "synthetic-v1");
  await assert.rejects(reserveDescriptor(directory, "synthetic-v1"));
  passed("exclusive owner claim; no stale-PID takeover");
  const recoveryDirectory = join(directory, "recovery");
  await mkdir(recoveryDirectory, { mode: 0o700 });
  const old = await reserveDescriptor(recoveryDirectory, "synthetic-v1");
  const oldHost = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20)"], { stdio: "ignore" });
  const oldUtility = spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"], {
    stdio: "ignore",
  });
  const hostPid = oldHost.pid,
    utilityPid = oldUtility.pid;
  assert.ok(hostPid);
  assert.ok(utilityPid);
  const utilityExit = new Promise<void>((resolve) => oldUtility.once("exit", () => resolve()));
  try {
    await old.utility(utilityPid);
    assert.equal((await readDescriptor(recoveryDirectory)).utilityPid, utilityPid);
    await new Promise<void>((resolve) => oldHost.once("exit", () => resolve()));
    const descriptor = await readDescriptor(recoveryDirectory);
    await writeFile(
      join(recoveryDirectory, "background-runtime", "owner.json"),
      JSON.stringify({ ...descriptor, pid: hostPid }),
    );
    await writeFile(
      join(recoveryDirectory, "background-runtime", "owner.lock"),
      JSON.stringify({ ...descriptor, pid: hostPid, utilityPid: null }),
    );
    await assert.rejects(reserveDescriptor(recoveryDirectory, "synthetic-v1", true));
    oldUtility.kill();
    await utilityExit;
    await assert.rejects(reserveDescriptor(recoveryDirectory, "synthetic-v1"));
    await writeFile(join(recoveryDirectory, "background-runtime", "owner.lock"), "unknown claim");
    await assert.rejects(reserveDescriptor(recoveryDirectory, "synthetic-v1", true));
    await writeFile(
      join(recoveryDirectory, "background-runtime", "owner.lock"),
      JSON.stringify({ ...descriptor, pid: hostPid, utilityPid: null }),
    );
    const recovered = await reserveDescriptor(recoveryDirectory, "synthetic-v1", true);
    assert.notEqual(recovered.descriptor.instance, descriptor.instance);
    await recovered.release();
    await assert.rejects(
      waitBackgroundExit(recoveryDirectory, process.pid, AbortSignal.timeout(30)),
    );
    await waitBackgroundExit(recoveryDirectory, hostPid, AbortSignal.timeout(1000));
    passed("exit receipt requires descriptor release AND real PID disappearance");
    passed(
      "persisted utility identity; live writer denies recovery; matching complete claim, two confirmed deaths plus canonical lock allow recovery; unknown claim denied",
    );
  } finally {
    if (oldUtility.exitCode === null && oldUtility.signalCode === null) {
      oldUtility.kill();
      await utilityExit;
    }
  }
  const descriptorFile = join(directory, "background-runtime", "owner.json");
  await chmod(descriptorFile, 0o644);
  await assert.rejects(readDescriptor(directory));
  await chmod(descriptorFile, 0o600);
  passed("private descriptor permission gate");
  let controls = 0,
    business = 0;
  server = await createBackgroundServer({
    descriptor: reservation.descriptor,
    control: async (_client, value) => {
      controls++;
      if (value.type === "preferences")
        throw new RpcError(RpcErrorCodes.unsupported, "synthetic private failure detail");
      return null;
    },
    disconnected: async () => {},
    failed: () => {
      throw new Error("unexpected drain failure");
    },
  });
  await reservation.socketPrivate();
  const rejected = async (send: (socket: Socket) => void) => {
    const socket = createConnection(reservation?.descriptor.endpoint as string);
    socket.on("error", () => {});
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.once("connect", () => send(socket));
    await Promise.race([
      closed,
      delay(2000).then(() => {
        socket.destroy();
        throw new Error("rejection timeout");
      }),
    ]);
  };
  await rejected((socket) =>
    framedSocket(socket, () => {}).send({
      kind: "auth",
      pid: process.pid,
      protocol: 1,
      version: "synthetic-v1",
      instance: reservation?.descriptor.instance as string,
      token: "0".repeat(64),
    }),
  );
  await rejected((socket) =>
    framedSocket(socket, () => {}).send({
      kind: "business",
      message: { jsonrpc: "2.0", id: 1, method: "settings.get" },
    }),
  );
  await rejected((socket) => {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(MAX_FRAME + 1);
    socket.write(prefix);
  });
  assert.equal(controls, 0);
  assert.equal(business, 0);
  passed("failed auth, pre-auth business and oversized frames never dispatch");
  const received: BackgroundWire[][] = [[], []];
  for (let index = 0; index < 2; index++) {
    const connection = await connectBackground(
      directory,
      "synthetic-v1",
      (message) => received[index]?.push(message),
      () => {},
    );
    connections.push(connection);
    await connection.control({ type: "attach" });
  }
  await assert.rejects(
    connections[0]?.control({ type: "preferences", patch: {} }) as Promise<unknown>,
    (error: Error) =>
      error instanceof RpcError &&
      error.code === RpcErrorCodes.unsupported &&
      error.message === "background_control_failed",
  );
  passed("typed private control errors preserve codes without exposing raw failure detail");
  const requests: { jsonrpc: string; id: string }[] = [];
  const off = server.port.onMessage((message) => {
    business++;
    requests.push(message as (typeof requests)[number]);
  });
  for (const connection of connections)
    connection.send({
      kind: "business",
      message: { jsonrpc: "2.0", id: "same-id", method: "settings.get" },
    });
  for (let turn = 0; requests.length < 2 && turn < 100; turn++) await delay(5);
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0]?.id, requests[1]?.id);
  for (const [index, request] of requests.entries())
    server.port.post({ jsonrpc: "2.0", id: request.id, result: { index } });
  for (
    let turn = 0;
    received.some((messages) => !messages.some((m) => m.kind === "business")) && turn < 100;
    turn++
  )
    await delay(5);
  for (const [index, messages] of received.entries()) {
    const message = messages.find((m) => m.kind === "business");
    assert.equal(message?.kind, "business");
    if (message?.kind === "business")
      assert.deepEqual(message.message, { jsonrpc: "2.0", id: "same-id", result: { index } });
  }
  await connections[0]?.control({ type: "detach" });
  await connections[0]?.control({ type: "attach" });
  assert.equal(business, 2);
  off();
  passed("per-client RPC isolation and reusable detach/attach");
  await assert.rejects(
    connectBackground(
      directory,
      "synthetic-v2",
      () => {},
      () => {},
    ),
  );
  passed("installed-build version mismatch rejects reconnect");
  const fake = {
    writableLength: MAX_FRAME + 4,
    on() {},
    once() {},
    destroy() {
      this.destroyed = true;
    },
    destroyed: false,
  };
  const framed = framedSocket(fake as unknown as Socket, () => {});
  assert.throws(() => framed.send({ kind: "open" }));
  assert.equal(fake.destroyed, true);
  passed("outbound backpressure disconnects instead of accumulating");
  let overloadClosed: () => void = () => {};
  let overloadDisconnected = false;
  const overloadMessages: BackgroundWire[] = [];
  const closedForOverload = new Promise<void>((resolve) => {
    overloadClosed = () => {
      overloadDisconnected = true;
      resolve();
    };
  });
  const overload = await connectBackground(
    directory,
    "synthetic-v1",
    (message) => overloadMessages.push(message),
    overloadClosed,
  );
  connections.push(overload);
  await overload.control({ type: "attach" });
  let dispatched = 0;
  const budgetRequests: { id: string }[] = [];
  const offBudget = server.port.onMessage((message) => {
    dispatched++;
    budgetRequests.push(message as { id: string });
  });
  for (let index = 0; index < 17; index++)
    overload.send({
      kind: "business",
      message: { jsonrpc: "2.0", id: index, method: "settings.get" },
    });
  for (let turn = 0; !overloadMessages.length && turn < 100; turn++) await delay(5);
  assert.equal(dispatched, 16);
  assert.equal(overloadDisconnected, false);
  assert.deepEqual(overloadMessages[0], {
    kind: "business",
    message: {
      jsonrpc: "2.0",
      id: 16,
      error: { code: RpcErrorCodes.busy, message: "background_busy" },
    },
  });
  for (const request of budgetRequests)
    server.port.post({ jsonrpc: "2.0", id: request.id, result: {} });
  for (let turn = 0; overloadMessages.length < 17 && turn < 100; turn++) await delay(5);
  assert.equal(overloadMessages.length, 17);
  assert.equal(overloadDisconnected, false);
  overload.send({
    kind: "business",
    message: { jsonrpc: "2.0", id: "next", method: "settings.get" },
  });
  for (let turn = 0; dispatched < 17 && turn < 100; turn++) await delay(5);
  assert.equal(dispatched, 17);
  const next = budgetRequests.at(-1);
  assert.ok(next);
  server.port.post({ jsonrpc: "2.0", id: next.id, result: {} });
  for (let turn = 0; overloadMessages.length < 18 && turn < 100; turn++) await delay(5);
  assert.equal(overloadMessages.length, 18);
  // Invalid parameters remain fatal even when all admission slots are occupied.
  for (let index = 0; index < 16; index++)
    overload.send({
      kind: "business",
      message: { jsonrpc: "2.0", id: `held:${index}`, method: "settings.get" },
    });
  overload.send({
    kind: "business",
    message: { jsonrpc: "2.0", id: "malformed", method: "settings.get", params: { invalid: true } },
  });
  const rejectionTimeout = new AbortController();
  try {
    await Promise.race([
      closedForOverload,
      delay(2000, undefined, { signal: rejectionTimeout.signal }).then(() => {
        throw new Error("invalid parameter rejection timeout");
      }),
    ]);
  } finally {
    rejectionTimeout.abort();
  }
  assert.equal(dispatched, 33);
  offBudget();
  passed(
    "16 business requests retained; overflow busy without dispatch, next read succeeds; invalid params at capacity disconnect",
  );
  db = openDatabase(join(directory, "synthetic.db"));
  runMigrations(db, process.argv[2]);
  const repo = new BackgroundPreferencesRepo(db);
  assert.deepEqual(repo.get(), { exitBehavior: "stop", startAtLogin: false });
  repo.set({ exitBehavior: "continue", startAtLogin: false });
  const previous = repo.get();
  const manager = createBackgroundManagement({
    platform: "darwin",
    packaged: true,
    loginItemsEnabled: true,
    home: join(directory, "fake-home"),
    dataDir: directory,
    executable: "/synthetic/Pi Bot.app/Contents/MacOS/Pi Bot",
    command: async (_file, args) => ({
      code:
        args[0] === "bootstrap"
          ? 1
          : args.length === 2 && args[0] === "print" && args[1]?.includes("/")
            ? 113
            : 0,
      stdout: "",
    }),
  });
  // Inject a manager failure without touching launchctl or the user's HOME.
  await assert.rejects(
    applyBackgroundPreferences({
      platform: "darwin",
      previous,
      patch: { startAtLogin: true },
      management: {
        ...manager,
        query: async () => ({
          kind: "launchd",
          available: true,
          registered: false,
          enabled: false,
          reason: "available",
        }),
        register: async () => {
          throw new Error("synthetic registration failure");
        },
      },
      write: async (value) => repo.set(value),
    }),
  );
  assert.deepEqual(repo.get(), previous);
  passed("service registration failure leaves authoritative preferences unchanged");
  let registered = false,
    disabled = false,
    label = "";
  const realAdapter = createBackgroundManagement({
    platform: "darwin",
    packaged: true,
    loginItemsEnabled: true,
    home: join(directory, "adapter-home"),
    dataDir: directory,
    executable: "/synthetic/Pi Bot.app/Contents/MacOS/Pi Bot",
    command: async (file, args) => {
      assert.equal(file, "/bin/launchctl");
      if (args[0] === "print") {
        const job = (args[1]?.split("/").length ?? 0) === 3;
        if (job) label = args[1]?.split("/").at(-1) ?? "";
        return { code: job && !registered ? 113 : 0, stdout: "" };
      }
      if (args[0] === "print-disabled")
        return { code: 0, stdout: disabled ? `"${label}" => true` : "" };
      if (args[0] === "bootstrap") {
        const plist = await readFile(args[2] as string, "utf8");
        assert.ok(plist.includes("--pibot-background"));
        assert.ok(plist.includes("<key>KeepAlive</key><false/>"));
        assert.ok(plist.includes("<key>RunAtLoad</key><true/>"));
        assert.ok(plist.includes(directory));
        registered = true;
      }
      if (args[0] === "enable") disabled = false;
      if (args[0] === "disable") disabled = true;
      if (args[0] === "bootout") registered = false;
      return { code: 0, stdout: "" };
    },
  });
  await realAdapter.register(AbortSignal.timeout(1000));
  assert.equal((await realAdapter.query()).enabled, true);
  await realAdapter.disableLogin(AbortSignal.timeout(1000));
  assert.equal((await realAdapter.query()).enabled, false);
  await realAdapter.unregister(AbortSignal.timeout(1000));
  assert.equal((await realAdapter.query()).registered, false);
  passed(
    "macOS adapter argv/plist/query/disable/unregister with synthetic HOME and command runner",
  );
  for (const platform of ["win32", "linux"] as const) {
    const gated = createBackgroundManagement({
      platform,
      packaged: true,
      loginItemsEnabled: true,
      home: directory,
      dataDir: directory,
      executable: "/synthetic",
      command: async () => {
        throw new Error("must not execute");
      },
    });
    assert.equal((await gated.query()).reason, "platform_unverified");
    await assert.rejects(gated.register(AbortSignal.timeout(1000)));
  }
  passed("Windows/Linux runtime gates do not execute unverified management");
  const power = createRoutineHost({
    platform: "darwin",
    test: true,
    monitor: { on() {}, off() {}, isOnBatteryPower: () => false },
    blocker: { start: () => 1, stop() {} },
    logger,
    send() {},
    tray() {},
  });
  power.begin(1);
  power.ready();
  assert.equal(power.activity(), undefined);
  await connections[1]?.control({ type: "state" });
  assert.equal(power.activity(), undefined);
  power.focused();
  const activity = power.activity();
  power.ready();
  assert.deepEqual(power.activity(), activity);
  await power.stop();
  passed("readiness/heartbeat never fabricate last UI focus");
  assert.equal(BackgroundPreferencesSchema.parse({}).exitBehavior, "stop");
  assert.deepEqual(
    BackgroundControlSchema.parse({ type: "preferences", patch: { startAtLogin: true } }),
    { type: "preferences", patch: { startAtLogin: true } },
  );
  passed("partial preference intent never injects unrelated defaults");
  assert.ok(randomUUID());
} finally {
  for (const connection of connections) connection.close();
  await server?.close();
  await reservation?.release();
  db?.close();
  await rm(directory, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: outputs.length, checks: outputs }, null, 2));

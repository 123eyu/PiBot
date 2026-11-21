// Private call-chain exercise: real IPC sockets, MessagePorts and self-created GUI PIDs;
// native Electron is explicitly synthetic. No user profile/service/key is accessed.
import assert from "node:assert/strict";
import { type ChildProcess, fork, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type BackgroundPreferences,
  createPeer,
  Methods,
  type Port,
  RpcErrorCodes,
  SettingsSchema,
} from "@pibot/protocol";
import { registerBackgroundBridge } from "../../src/main/background/background-bridge.ts";
import { createBackgroundClientLifetime } from "../../src/main/background/background-client-lifetime.ts";
import { connectBackground } from "../../src/main/background/background-connection.ts";
import {
  readDescriptor,
  reserveDescriptor,
} from "../../src/main/background/background-directory.ts";
import { createBackgroundServer } from "../../src/main/background/background-server.ts";
import { rollbackBackgroundStartup } from "../../src/main/background/background-startup.ts";
import { handlers, ipcMain } from "./probe-background-electron.ts";

const root = await mkdtemp("/private/tmp/pibot-bg-fix-");
const outputs: string[] = [];
const children = new Set<ChildProcess>();
const wait = async (predicate: () => boolean, milliseconds = 4000) => {
  const end = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error("private_probe_deadline");
    await delay(10);
  }
};
try {
  // Actual existing bridge handler, not a schema-only assertion.
  const webContents = { mainFrame: {} };
  const disposeBridge = registerBackgroundBridge(
    ipcMain as never,
    { webContents } as never,
    {
      backgroundState: () => ({
        state: "ready",
        startedAt: null,
        uptimeMs: 0,
        restartCount: 0,
        at: new Date().toISOString(),
      }),
      requestRestart: () => () => {},
    },
    true,
  );
  const bridge = (method: string, params?: unknown) =>
    handlers.get("pibot:background")?.(
      { sender: webContents, senderFrame: webContents.mainFrame },
      { method, params },
    ) as Promise<{
      ok: boolean;
      result: { lifecycle: string; instance: null; effectiveExitBehavior: string };
      code?: number;
    }>;
  const unsupported = await bridge("background.serviceState");
  assert.equal(unsupported.result.lifecycle, "unsupported");
  assert.equal(unsupported.result.instance, null);
  assert.equal(unsupported.result.effectiveExitBehavior, "stop");
  assert.equal((await bridge("background.state")).ok, true);
  assert.equal((await bridge("background.restart")).ok, true);
  assert.equal((await bridge("background.preferences", { exitBehavior: "continue" })).ok, false);
  assert.equal((await bridge("background.stopService")).ok, false);
  disposeBridge();
  outputs.push(
    "Windows embedded bridge retains utility state/restart; new controls unsupported without invented owner",
  );

  const failedDir = join(root, "failed");
  await mkdir(failedDir);
  const reserved = await reserveDescriptor(failedDir, "synthetic-v1");
  await writeFile(reserved.descriptor.endpoint, "owned synthetic bind obstruction", {
    mode: 0o600,
  });
  await assert.rejects(
    createBackgroundServer({
      descriptor: reserved.descriptor,
      control: async () => null,
      disconnected: async () => {},
      failed() {},
    }),
  );
  await rollbackBackgroundStartup({
    reservation: reserved,
    stopWriter: async () => {},
    cleanup: [],
  });
  await assert.rejects(lstat(join(failedDir, "background-runtime", "owner.lock")), {
    code: "ENOENT",
  });
  outputs.push("failed server bind rolls back own unstarted writer claim");
  const publishDir = join(root, "publish");
  await mkdir(join(publishDir, "background-runtime", "owner.json"), {
    recursive: true,
    mode: 0o700,
  });
  await assert.rejects(reserveDescriptor(publishDir, "synthetic-v1"));
  await assert.rejects(lstat(join(publishDir, "background-runtime", "owner.lock")), {
    code: "ENOENT",
  });
  assert.ok((await lstat(join(publishDir, "background-runtime", "owner.json"))).isDirectory());
  outputs.push(
    "descriptor publication failure removes only newly claimed inode and preserves pre-existing obstruction",
  );

  const liveDir = join(root, "live");
  await mkdir(liveDir);
  const liveClaim = await reserveDescriptor(liveDir, "synthetic-v1");
  const utility = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  children.add(utility);
  assert.ok(utility.pid);
  await liveClaim.utility(utility.pid);
  await assert.rejects(
    rollbackBackgroundStartup({
      reservation: liveClaim,
      stopWriter: async () => {
        throw new Error("exit unconfirmed");
      },
      cleanup: [],
    }),
  );
  assert.equal((await readDescriptor(liveDir)).utilityPid, utility.pid);
  const exited = new Promise<void>((done) => utility.once("exit", () => done()));
  await rollbackBackgroundStartup({
    reservation: liveClaim,
    stopWriter: async () => {
      utility.kill();
      await exited;
    },
    cleanup: [],
  });
  await assert.rejects(lstat(join(liveDir, "background-runtime", "owner.json")), {
    code: "ENOENT",
  });
  outputs.push(
    "rollback retains live utility claim on unknown exit; releases only after actual exit event",
  );

  const guiDir = join(root, "gui");
  await mkdir(guiDir);
  const claim = await reserveDescriptor(guiDir, "synthetic-v1");
  let behavior: "stop" | "continue" = "continue",
    stopCount = 0,
    drainCount = 0;
  let dispatch = true;
  let server: Awaited<ReturnType<typeof createBackgroundServer>>;
  const lifetime = createBackgroundClientLifetime({
    effectiveStop: () => behavior === "stop",
    drain: async () => {
      drainCount++;
    },
    stop: async () => {
      stopCount++;
      await server.close();
    },
    failed: () => {
      throw new Error("unexpected lifetime failure");
    },
  });
  const state = () => ({
    lifecycle: "ready",
    instance: claim.descriptor.instance,
    version: "synthetic-v1",
    startedAt: new Date().toISOString(),
    preferences: { exitBehavior: behavior, startAtLogin: false },
    effectiveExitBehavior: behavior,
    clients: lifetime.size,
    management: {
      kind: "launchd",
      available: false,
      registered: null,
      enabled: null,
      reason: "unpackaged",
    },
  });
  let lastPatch: unknown;
  let attachCount = 0;
  const makeServer = () =>
    createBackgroundServer({
      descriptor: claim.descriptor,
      failed() {
        throw new Error("unexpected server failure");
      },
      disconnected: lifetime.disconnected,
      control: async (id, control) => {
        if (!dispatch) return new Promise(() => {});
        switch (control.type) {
          case "attach":
            attachCount++;
            lifetime.attach(id);
            return state();
          case "detach":
            await lifetime.detach(id, control.stop === true);
            return state();
          case "state":
            return state();
          case "preferences":
            lastPatch = control.patch;
            return state();
          // Intentionally omit the follow-up stop call: owner must honor the detach receipt.
          case "stop-service":
            return new Promise(() => {});
          default:
            return null;
        }
      },
    });
  server = await makeServer();
  await claim.socketPrivate();
  const subscriptions = new Set<(message: unknown) => void>();
  const stablePort: Port = {
    post: (message) => server.port.post(message),
    onMessage: (listener) => {
      subscriptions.add(listener);
      return () => subscriptions.delete(listener);
    },
  };
  let off = server.port.onMessage((message) => {
    for (const listener of subscriptions) listener(message);
  });
  const brain = createPeer(stablePort, { methods: Methods, events: {} });
  let rpcCount = 0;
  let holdReads: Promise<void> | undefined;
  brain.handle("settings.get", async () => {
    rpcCount++;
    if (holdReads) await holdReads;
    return SettingsSchema.parse({
      language: "system",
      theme: "system",
      onboardingCompleted: true,
      openAtLogin: false,
      showTrayIcon: true,
      closeToTrayHintShown: false,
    });
  });
  const wire = await connectBackground(
    guiDir,
    "synthetic-v1",
    () => {},
    () => {},
  );
  await wire.control({ type: "attach" });
  await wire.control({ type: "preferences", patch: { startAtLogin: true } });
  assert.deepEqual(lastPatch, { startAtLogin: true });
  const merged: BackgroundPreferences = {
    exitBehavior: "continue",
    startAtLogin: false,
    ...(lastPatch as object),
  };
  assert.equal(merged.exitBehavior, "continue");
  wire.close();
  await wait(() => lifetime.size === 0);
  outputs.push(
    "actual authenticated wire parse preserves single-field login patch without resetting continue",
  );
  const guiEntry = resolve(process.argv[2] ?? ".cache/m3-bg/probe-background-gui.mjs");
  const startGui = async () => {
    const child = fork(guiEntry, [guiDir], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    children.add(child);
    const messages: Record<string, unknown>[] = [];
    let errors = "";
    child.stderr?.on("data", (data) => {
      errors += String(data);
    });
    child.on("message", (message) => messages.push(message as Record<string, unknown>));
    await wait(() => messages.some((message) => message.ready) || child.exitCode !== null);
    assert.equal(child.exitCode, null, errors);
    return { child, messages };
  };
  const gui = await startGui();
  gui.child.send({ command: "rpc" });
  await wait(() => gui.messages.some((message) => message.result));
  assert.equal(rpcCount, 1);
  gui.child.send({ command: "reload" });
  await wait(() => gui.messages.some((message) => message.reloaded));
  gui.child.send({ command: "rpc" });
  await wait(() => rpcCount === 2);
  const epoch = claim.descriptor.instance;
  off();
  await server.close();
  server = await makeServer();
  off = server.port.onMessage((message) => {
    for (const listener of subscriptions) listener(message);
  });
  // Await the authenticated replacement attach, then reload the document with a fresh
  // real MessagePort. A stale size=1 alone could refer to the socket still closing.
  await wait(() => attachCount >= 3).catch(() => {
    throw new Error(
      JSON.stringify({ attachCount, messages: gui.messages, rpcCount, clients: lifetime.size }),
    );
  });
  const priorReloads = gui.messages.filter((message) => message.reloaded).length;
  gui.child.send({ command: "reload" });
  await wait(() => gui.messages.filter((message) => message.reloaded).length > priorReloads);
  gui.child.send({ command: "rpc" });
  await wait(() => rpcCount === 3);
  assert.equal((await readDescriptor(guiDir)).instance, epoch);
  assert.ok(gui.messages.some((message) => Number(message.portCount) >= 3));
  let releaseReads = () => {};
  holdReads = new Promise<void>((resolve) => {
    releaseReads = resolve;
  });
  const beforeBurst = rpcCount;
  const beforeBurstAttach = attachCount;
  const beforeBurstResults = gui.messages.filter((message) => message.result).length;
  gui.child.send({ command: "burst" });
  await wait(() => gui.messages.some((message) => message.overflow));
  assert.deepEqual(gui.messages.find((message) => message.overflow)?.overflow, {
    ok: false,
    code: RpcErrorCodes.busy,
  });
  assert.equal(rpcCount - beforeBurst, 16);
  releaseReads();
  holdReads = undefined;
  await wait(() => gui.messages.some((message) => message.burst));
  const burst = gui.messages.find((message) => message.burst)?.burst as {
    ok: boolean;
    code?: number;
  }[];
  assert.equal(burst.filter((value) => value.ok).length, 16);
  assert.equal(burst.filter((value) => value.code === RpcErrorCodes.busy).length, 1);
  gui.child.send({ command: "rpc" });
  await wait(() => gui.messages.filter((message) => message.result).length > beforeBurstResults);
  assert.equal(rpcCount - beforeBurst, 17);
  assert.equal(attachCount, beforeBurstAttach);
  assert.equal((await readDescriptor(guiDir)).instance, epoch);
  outputs.push(
    "actual GUI MessagePort RPC reload/repair retains owner; held 16 reads finish, 17th busy never dispatches, same connection accepts next read",
  );
  const guiExit = new Promise<void>((done) => gui.child.once("exit", () => done()));
  gui.child.kill("SIGTERM");
  await guiExit;
  assert.equal(stopCount, 0);
  // The lifetime confirms the GUI pid is gone (polled) before draining a lost transport.
  await wait(() => drainCount > 0);
  outputs.push(
    "orderly termination of self-created continue GUI drains interaction, GUI PID disappears and owner remains",
  );

  behavior = "stop";
  const stoppedGui = await startGui();
  const stopExit = new Promise<void>((done) => stoppedGui.child.once("exit", () => done()));
  stoppedGui.child.kill("SIGTERM");
  await wait(() => stopCount === 1);
  await stopExit;
  assert.ok(stoppedGui.messages.some((message) => message.warning));
  outputs.push(
    "default detach receipt converges without follow-up stop-service; owner-first socket close allows actual GUI PID exit",
  );
  server = await makeServer();
  const detachedGui = fork(guiEntry, [guiDir, "detach-only"], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  children.add(detachedGui);
  let receipt = false;
  detachedGui.on("message", (message: { detached?: boolean }) => {
    receipt ||= message.detached === true;
  });
  const detachedExit = new Promise<void>((done) => detachedGui.once("exit", () => done()));
  await wait(() => receipt);
  detachedGui.kill("SIGTERM");
  await detachedExit;
  await wait(() => stopCount === 2);
  outputs.push(
    "GUI terminates after actual detach receipt before any stop-service; default owner intent still converges",
  );
  lifetime.dispose();
  // Unknown live owner keeps its descriptor, but an unresponsive authenticated connection
  // cannot trap the GUI. No second owner is launched and no false stopped result is emitted.
  dispatch = true;
  server = await makeServer();
  const trappedGui = await startGui();
  dispatch = false;
  const trappedExit = new Promise<void>((done) => trappedGui.child.once("exit", () => done()));
  const before = Date.now();
  trappedGui.child.kill("SIGTERM");
  let exitDeadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      trappedExit,
      new Promise<never>((_resolve, reject) => {
        exitDeadline = setTimeout(() => reject(new Error("GUI trapped beyond bound")), 13_000);
      }),
    ]);
  } finally {
    clearTimeout(exitDeadline);
  }
  assert.ok(Date.now() - before < 12_000);
  assert.equal((await readDescriptor(guiDir)).instance, epoch);
  assert.ok(trappedGui.messages.some((message) => message.warning));
  outputs.push(
    "unresponsive live owner: actual GUI PID exits within bound; owner claim retained and stop remains unconfirmed",
  );
  brain.dispose();
  off();
  await server.close();
  await claim.release();
  console.log(JSON.stringify({ checks: outputs.length, passed: outputs }, null, 2));
} finally {
  await Promise.all(
    [...children].map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((done) => child.once("exit", () => done()));
      child.kill("SIGKILL");
      await exited;
    }),
  );
  await rm(root, { recursive: true, force: true });
}

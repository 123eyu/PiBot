import type { Logger } from "@pibot/observability";
import { createRedactor } from "@pibot/secrets";
import { app, type BrowserWindow, utilityProcess } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startBrainHost } from "./brain-host.ts";

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class FakePort extends EventEmitter {
    start = vi.fn();
    close = vi.fn();
    postMessage = vi.fn();
  }
  class FakeChild extends EventEmitter {
    postMessage = vi.fn();
    kill = vi.fn(() => {
      this.emit("exit", 0);
      return true;
    });
  }
  return {
    app: {
      getVersion: () => "0.0.0",
      getAppPath: () => "test-app",
      getLocale: () => "en",
      // No CPU metrics: the startup watchdog keeps its plain idle deadline in these tests.
      getAppMetrics: () => [],
      setLoginItemSettings: vi.fn(),
    },
    powerSaveBlocker: { start: vi.fn(() => 1), stop: vi.fn() },
    dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn() },
    MessageChannelMain: class {
      port1 = new FakePort();
      port2 = new FakePort();
    },
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
    nativeTheme: new EventEmitter(),
    safeStorage: { isEncryptionAvailable: () => false },
    shell: { openExternal: vi.fn(async () => {}) },
    utilityProcess: { fork: vi.fn(() => new FakeChild()) },
  };
});

const hosts: ReturnType<typeof startBrainHost>[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.clearAllMocks();
});
afterEach(async () => {
  for (const host of hosts.splice(0)) {
    const stopping = host.stop();
    await vi.advanceTimersByTimeAsync(90_000);
    await stopping;
  }
  vi.useRealTimers();
});

function fixture() {
  const window = {
    isDestroyed: () => false,
    on: vi.fn(),
    off: vi.fn(),
    webContents: { send: vi.fn(), postMessage: vi.fn() },
  };
  const originalEnv = { OPENAI_API_KEY: "fake-original", PATH: "fake-path" };
  const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const host = startBrainHost({
    window: window as unknown as BrowserWindow,
    originalEnv,
    dataDir: "test-data",
    outputDir: "output",
    resourcesDir: "resources",
    dev: true,
    logger,
    redactor: createRedactor(),
    onLoginItem: vi.fn(),
    onSettings: vi.fn(),
    focusBot: vi.fn(),
  });
  hosts.push(host);
  const child = () =>
    vi.mocked(utilityProcess.fork).mock.results.at(-1)?.value as Electron.UtilityProcess;
  return { window, originalEnv, host, child };
}

describe("desktop brain lifecycle", () => {
  it("reports fork failure to a renderer that subscribes later", () => {
    vi.mocked(utilityProcess.fork).mockImplementationOnce(() => {
      throw new Error("unavailable");
    });
    const { host, window } = fixture();
    host.rendererReady();
    expect(window.webContents.send.mock.calls.at(-1)?.[1]).toMatchObject({
      method: "brain.status",
      params: { payload: { state: "failed" } },
    });
  });
  it("forks with clean env, transfers renderer, host, restricted main and RTC channels, and waits for both endpoints", () => {
    const { host, window, originalEnv, child } = fixture();
    const forkOptions = vi.mocked(utilityProcess.fork).mock.calls[0]?.[2];
    expect(forkOptions?.env).toMatchObject({
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      PATH: "fake-path",
    });
    expect(forkOptions?.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(originalEnv.OPENAI_API_KEY).toBe("fake-original");
    expect(vi.mocked(child().postMessage).mock.calls[0]?.[1]).toHaveLength(5);
    host.rendererReady();
    expect(window.webContents.postMessage).not.toHaveBeenCalled();
    child().emit("message", { type: "ready" });
    expect(window.webContents.postMessage).toHaveBeenCalledTimes(1);
  });
  it("replaces the business channel after crashes, then emits failed on exit three", async () => {
    const { host, window, child } = fixture();
    host.rendererReady();
    for (let crash = 0; crash < 3; crash++) {
      child().emit("message", { type: "ready" });
      child().emit("exit", 1);
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(utilityProcess.fork).toHaveBeenCalledTimes(3);
    expect(window.webContents.postMessage).toHaveBeenCalledTimes(3);
    expect(window.webContents.send.mock.calls.at(-1)).toEqual([
      "pibot:status",
      expect.objectContaining({
        method: "brain.status",
        params: expect.objectContaining({ payload: { state: "failed" } }),
      }),
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(utilityProcess.fork).toHaveBeenCalledTimes(3);
  });
  it("keeps renderer reloads outside the crash budget and shuts down without restart", async () => {
    const { host, child } = fixture();
    host.rendererReady();
    child().emit("message", { type: "ready" });
    host.rendererReloading();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(utilityProcess.fork).toHaveBeenCalledTimes(2);
    const stopping = host.stop();
    await vi.advanceTimersByTimeAsync(90_000);
    await stopping;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(utilityProcess.fork).toHaveBeenCalledTimes(2);
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import { memoryPorts } from "../test-port.ts";
import { startDesktopBrain } from "./runtime.ts";

const module = vi.hoisted(() => ({
  startBrain: vi.fn(async () => ({ stop: async () => {} })),
}));
vi.mock("@pibot/brain-app", () => module);

describe("desktop brain adapter", () => {
  it("passes the exact planned options to the real brain", async () => {
    const [port] = memoryPorts();
    const host = {
      secrets: {
        isAvailable: async () => false,
        encrypt: async () => new Uint8Array(),
        decrypt: async () => "",
      },
      env: { detect: async () => [], read: async () => undefined },
    };
    const options = {
      port,
      host,
      dataDir: "test-data",
      resourcesDir: "test-resources",
      version: "0.0.0",
      platform: "linux" as const,
    };
    await startDesktopBrain(options);
    expect(module.startBrain).toHaveBeenCalledWith({
      ...options,
      pluginDir: "test-resources/plugins",
    });
  });
});

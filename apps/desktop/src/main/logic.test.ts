import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createEnvReader } from "./brain/env-detect.ts";
import { RestartPolicy } from "./brain/restart-policy.ts";
import { restoreBounds } from "./gui/desktop-state.ts";
import { externalUrl } from "./window/external-url.ts";
import { autostartFile, setLoginItem } from "./window/login-item.ts";

describe("brain restart budget", () => {
  it("recovers from a crash and stops at the third exit within 30 seconds", () => {
    const policy = new RestartPolicy();
    expect(policy.recordExit(0)).toBe("restart");
    expect(policy.recordExit(10_000)).toBe("restart");
    expect(policy.recordExit(30_000)).toBe("failed");
    expect(policy.recordExit(100_000)).toBe("failed");
  });
  it("ages earlier crashes out of the rolling window", () => {
    const policy = new RestartPolicy();
    expect(policy.recordExit(0)).toBe("restart");
    expect(policy.recordExit(20_000)).toBe("restart");
    expect(policy.recordExit(30_001)).toBe("restart");
  });
});

describe("original environment reader", () => {
  it("returns only allowed nonempty names and preserves the original snapshot", () => {
    const env = { OPENAI_API_KEY: "fake-original", PATH: "fake-path", EMPTY: "" };
    const reader = createEnvReader(env, ["OPENAI_API_KEY", "EMPTY", "MISSING"], "darwin");
    env.OPENAI_API_KEY = "fake-changed";
    expect(reader.detect()).toEqual(["OPENAI_API_KEY"]);
    expect(JSON.stringify(reader.detect())).not.toContain("fake-original");
    expect(reader.read("OPENAI_API_KEY")).toBe("fake-original");
    expect(reader.read("PATH")).toBeUndefined();
    expect(reader.read("__proto__")).toBeUndefined();
  });
  it("uses Windows case-insensitive names, but returns canonical names", () => {
    const reader = createEnvReader({ openai_api_key: "fake" }, ["OPENAI_API_KEY"], "win32");
    expect(reader.detect()).toEqual(["OPENAI_API_KEY"]);
    expect(reader.read("OPENAI_API_KEY")).toBe("fake");
  });
});

describe("external link allowlist", () => {
  it.each(["https://example.com/docs", "http://localhost:11434/"])("accepts %s", (url) => {
    expect(externalUrl(url)).toBe(url);
  });
  it.each([
    "file:///secret",
    "javascript:alert(1)",
    "data:text/html,x",
    "mailto:test@example.com",
    "pibot://x",
    "invalid",
    "https://user:secret@example.com/",
  ])("rejects %s", (url) => {
    expect(() => externalUrl(url)).toThrow();
  });
});

describe("login items", () => {
  it("generates a desktop entry with quoted paths and literal field-code characters", () => {
    const file = autostartFile("/opt/Pi Bot/pi%bot", ["/project/Pi Bot"]);
    expect(file).toContain('Exec="/opt/Pi Bot/pi%%bot" "/project/Pi Bot"\n');
    expect(file).toContain("Type=Application\nName=Pi Bot\n");
    expect(file).toContain("Terminal=false\n");
    expect(() => autostartFile("bad\nExec=evil")).toThrow();
  });
  it("writes and removes Linux autostart in XDG_CONFIG_HOME", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pibot-t10-"));
    try {
      const options = {
        platform: "linux" as const,
        openAtLogin: true,
        homedir: "unused",
        env: { XDG_CONFIG_HOME: directory },
        executable: "/opt/Pi Bot/pi-bot",
        args: [],
        setNative: vi.fn(),
      };
      await setLoginItem(options);
      const file = join(directory, "autostart", "pi-bot.desktop");
      expect(await readFile(file, "utf8")).toBe(autostartFile(options.executable));
      await setLoginItem({ ...options, openAtLogin: false });
      await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
      expect(options.setNative).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each(["darwin", "win32"] as const)("uses the native API on %s", async (platform) => {
    const setNative = vi.fn();
    await setLoginItem({
      platform,
      openAtLogin: true,
      homedir: "unused",
      env: {},
      executable: "electron",
      args: ["app"],
      setNative,
    });
    expect(setNative).toHaveBeenCalledWith({ openAtLogin: true, path: "electron", args: ["app"] });
  });
  it("explicitly rejects unsupported platforms", async () => {
    await expect(
      setLoginItem({
        platform: "freebsd",
        openAtLogin: true,
        homedir: "unused",
        env: {},
        executable: "pibot",
        args: [],
        setNative: vi.fn(),
      }),
    ).rejects.toThrow("unsupported");
  });
});

describe("window bounds", () => {
  const displays = [{ x: 0, y: 0, width: 1920, height: 1080 }];
  it("restores a valid position and recenters windows from disconnected monitors", () => {
    expect(restoreBounds({ x: 100, y: 100, width: 1280, height: 800 }, displays)).toEqual({
      x: 100,
      y: 100,
      width: 1280,
      height: 800,
    });
    expect(restoreBounds({ x: 4000, y: 100, width: 1280, height: 800 }, displays)).toEqual({
      width: 1280,
      height: 800,
    });
  });
  it("rejects invalid and undersized saved state", () => {
    for (const value of [
      null,
      {},
      { width: 100, height: 100 },
      { width: Number.NaN, height: 800 },
    ]) {
      expect(restoreBounds(value, displays)).toEqual({ width: 1280, height: 800 });
    }
  });
});

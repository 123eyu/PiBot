import { afterEach, describe, expect, it, vi } from "vitest";
import {
  colorSchemeQuery,
  getSystemTheme,
  resolveTheme,
  subscribeSystemTheme,
} from "../src/theme/theme.ts";

afterEach(() => vi.unstubAllGlobals());

describe("theme", () => {
  it.each([
    ["system", true, "dark"],
    ["system", false, "light"],
    ["light", true, "light"],
    ["dark", false, "dark"],
  ] as const)("resolves %s with systemDark=%s", (setting, systemDark, expected) => {
    expect(resolveTheme(setting, systemDark)).toBe(expected);
  });

  it("reads live system preferences and removes its listener on cleanup", () => {
    const listeners = new Set<() => void>();
    const media = {
      matches: false,
      addEventListener: vi.fn((_type: string, fn: () => void) => listeners.add(fn)),
      removeEventListener: vi.fn((_type: string, fn: () => void) => listeners.delete(fn)),
    };
    const matchMedia = vi.fn(() => media);
    vi.stubGlobal("window", { matchMedia });
    const listener = vi.fn();
    const unsubscribe = subscribeSystemTheme(listener);
    expect(getSystemTheme()).toBe("light");
    expect(matchMedia).toHaveBeenCalledWith(colorSchemeQuery);
    media.matches = true;
    for (const fn of listeners) fn();
    expect(listener).toHaveBeenCalledOnce();
    expect(getSystemTheme()).toBe("dark");
    unsubscribe();
    expect(listeners.size).toBe(0);
    expect(media.removeEventListener).toHaveBeenCalledWith("change", listener);
  });
});

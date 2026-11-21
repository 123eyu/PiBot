import { describe, expect, it } from "vitest";
import { createTranslator, en, resolveLanguage, t, zh } from "./index.ts";

describe("translations", () => {
  it("has exactly the same keys, nonempty text, and interpolation names", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
    for (const key of Object.keys(zh) as (keyof typeof zh)[]) {
      expect(zh[key].trim()).not.toBe("");
      expect(en[key].trim()).not.toBe("");
      expect(en[key].match(/\{\w+\}/g)?.sort()).toEqual(zh[key].match(/\{\w+\}/g)?.sort());
    }
  });

  it.each([
    ["system", "zh-CN", "zh"],
    ["system", "zh-Hant-TW", "zh"],
    ["system", "ZH_hk", "zh"],
    ["system", "en-US", "en"],
    ["system", "ja-JP", "en"],
    ["system", "", "en"],
    ["zh", "en-US", "zh"],
    ["en", "zh-CN", "en"],
  ] as const)("resolves %s with %s to %s", (setting, locale, expected) => {
    expect(resolveLanguage(setting, locale)).toBe(expected);
  });

  it("binds a language without changing another caller", () => {
    const chinese = createTranslator("zh");
    const english = createTranslator("en");
    expect(chinese("tray.quit")).toBe("退出");
    expect(english("tray.quit")).toBe("Quit");
    expect(chinese("welcome.progress", { step: 0, total: 5 })).toBe("第 0 步，共 5 步");
    expect(t("welcome.progress", { step: 2, total: 5 })).toBe("Step 2 of 5");
  });

  it("preserves missing placeholders and inserts values as plain text", () => {
    expect(t("models.testFailed")).toBe("Connection failed: {reason}");
    expect(t("models.testFailed", { reason: "$& {count} <script>" })).toBe(
      "Connection failed: $& {count} <script>",
    );
  });
});

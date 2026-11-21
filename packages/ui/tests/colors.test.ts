import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const generatedTokens = fileURLToPath(new URL("../src/theme/tokens.ts", import.meta.url));

function colorLiterals(text: string): string[] {
  return text.match(/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/gi) ?? [];
}

function scan(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return scan(path);
    // Generated palette data is checked against the CSS source by pnpm lint.
    if (entry.name === "tokens.css" || path === generatedTokens) return [];
    return colorLiterals(readFileSync(path, "utf8")).map((literal) => `${entry.name}: ${literal}`);
  });
}

describe("theme token discipline", () => {
  it("scans every source file except theme token sources for color literals", () => {
    expect(scan(fileURLToPath(new URL("../src", import.meta.url)))).toEqual([]);
  });

  it("detects short, long, alpha hex, and functional color syntax", () => {
    expect(
      colorLiterals(
        "#fff #1234 #1084FE #F0F0F0A6 rgb(0 0 0) rgba(0,0,0,.5) hsl(0 0% 0%) oklch(.5 0 0)",
      ),
    ).toHaveLength(8);
    expect(colorLiterals("var(--accent) currentColor none transparent")).toEqual([]);
  });

  it("provides matching theme tokens and all palette variables used by SVGs", () => {
    const tokens = readFileSync(new URL("../src/theme/tokens.css", import.meta.url), "utf8");
    const themeTokens = (selector: string) => {
      const block = tokens.slice(tokens.indexOf(selector)).split("}")[0] ?? "";
      return [...block.matchAll(/--([\w-]+):/g)].map((match) => match[1]).sort();
    };
    expect(themeTokens(':root[data-theme="light"]')).toEqual(themeTokens('[data-theme="dark"]'));
    for (const color of [
      "orange",
      "amber",
      "blue",
      "violet",
      "pink",
      "teal",
      "green",
      "brown",
      "ink",
      "gray",
    ]) {
      expect(tokens).toContain(`--avatar-${color}:`);
    }
    for (const tone of ["violet", "ink", "paper", "night"]) {
      expect(tokens).toContain(`--logo-${tone}:`);
      expect(tokens).toContain(`--logo-${tone}-ink:`);
    }
    expect(tokens).toContain("--prim: #070707;");
    expect(tokens.toLowerCase()).toContain("--prim: #f0f0f0;");
  });

  it("disables avatar animations when reduced motion is requested", () => {
    const css = readFileSync(
      new URL("../src/components/Avatar.module.css", import.meta.url),
      "utf8",
    );
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain(".avatar[data-state]");
    expect(css).toContain("animation: none;");
  });
});

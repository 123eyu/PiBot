import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("keeps renderer colors in UI tokens", () => {
  const directory = fileURLToPath(new URL(".", import.meta.url));
  // Recursive so every feature folder (app/, features/*) is covered too.
  const offenders = readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !/\.test\.tsx?$/.test(entry.name))
    .flatMap(
      (entry) =>
        readFileSync(join(entry.parentPath, entry.name), "utf8").match(
          /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/gi,
        ) ?? [],
    );
  expect(offenders).toEqual([]);
});

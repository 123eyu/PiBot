import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const path = "README.md";
const start = "<!-- CONTRIBUTORS:START -->\n";
const end = "\n<!-- CONTRIBUTORS:END -->";
const readme = readFileSync(path, "utf8");
const from = readme.indexOf(start);
const to = readme.indexOf(end);
if (
  from === -1 ||
  from + start.length > to ||
  from !== readme.lastIndexOf(start) ||
  to !== readme.lastIndexOf(end)
) {
  throw new Error("Expected one contributor section in the English README");
}

// The mailmap canonicalizes aliases. Only names, never commit email addresses, go into the README.
const authors = execFileSync(
  "git",
  ["log", "--no-merges", "--encoding=UTF-8", "--format=%aN", "HEAD"],
  {
    encoding: "utf8",
  },
);
const names = [
  ...new Set(
    authors
      .split("\n")
      .map((name) => name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim())
      .filter((name) => name && !name.toLowerCase().endsWith("[bot]")),
  ),
].sort((left, right) => left.localeCompare(right, "en"));
if (names.length === 0) throw new Error("No human commit authors found");

// Encode Markdown and HTML syntax from the commit author field as text.
const list = names
  .map((name) => {
    const label = name.replace(/[^\p{L}\p{M}\p{N} .-]/gu, (char) => `&#${char.codePointAt(0)};`);
    return `- ${label}`;
  })
  .join("\n");
const updated = readme.slice(0, from + start.length) + list + readme.slice(to);
if (updated !== readme) writeFileSync(path, updated);

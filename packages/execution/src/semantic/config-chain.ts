import { dirname, isAbsolute, join, resolve } from "node:path";
import { skippableError } from "../files/search-walk.ts";
import { readSource } from "./loader.ts";
import type { SourceAccess } from "./types.ts";

/**
 * The walk bound is `MAX_CONFIGS` configs per edit. An `extends` chain and the
 * referenced projects of one tsconfig are far below it, and a snapshot that stops early still
 * reports itself as partial instead of pretending the compiler options are complete.
 */
const MAX_CONFIGS = 8;
/** `captureProject` never reads dependency trees, so a config found there can never be captured. */
const DEPENDENCY_TREE = /(^|\/)node_modules(\/|$)/;

/**
 * tsconfig files are JSONC: comments and trailing commas are legal, so `JSON.parse` alone would
 * reject every hand-edited config. The compiler's own reader lives in the worker, and loading it on
 * the brain's main thread is exactly what the regex import scan in `loader.ts` avoids.
 */
function stripJsonc(text: string) {
  const out: string[] = [];
  let index = 0;
  const skipTrivia = (from: number) => {
    let cursor = from;
    for (;;) {
      while (cursor < text.length && /\s/.test(text[cursor] as string)) cursor++;
      if (text.startsWith("//", cursor)) {
        while (cursor < text.length && text[cursor] !== "\n") cursor++;
      } else if (text.startsWith("/*", cursor)) {
        const end = text.indexOf("*/", cursor + 2);
        cursor = end < 0 ? text.length : end + 2;
      } else return cursor;
    }
  };
  while (index < text.length) {
    const char = text[index];
    if (char === undefined) break;
    if (char === '"') {
      // Strings are copied verbatim, so `//` or `,` inside one is never treated as syntax.
      const start = index++;
      while (index < text.length && text[index] !== '"') index += text[index] === "\\" ? 2 : 1;
      index++;
      out.push(text.slice(start, index));
    } else if (char === "/" && (text[index + 1] === "/" || text[index + 1] === "*")) {
      index = skipTrivia(index);
    } else if (char === ",") {
      // A trailing comma is dropped only when the next significant character closes the container.
      const next = skipTrivia(index + 1);
      if (text[next] !== "}" && text[next] !== "]") out.push(char);
      index++;
    } else {
      out.push(char);
      index++;
    }
  }
  return out.join("");
}

function configReferences(text: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch {
    // A config we cannot read is not one we can point diagnostics at; the compiler reports the
    // unreadable base itself.
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const record = parsed as Record<string, unknown>;
  const inherited =
    typeof record.extends === "string"
      ? [record.extends]
      : Array.isArray(record.extends)
        ? record.extends.filter((entry): entry is string => typeof entry === "string")
        : [];
  const referenced = Array.isArray(record.references)
    ? record.references.flatMap((entry) => {
        const path =
          entry && typeof entry === "object" ? (entry as { path?: unknown }).path : undefined;
        return typeof path === "string" ? [path] : [];
      })
    : [];
  return [...inherited, ...referenced];
}

/**
 * A tsconfig's `extends` chain and project references decide the compiler options a
 * file is actually checked with, but the diagnostics snapshot only walks the tsconfig's own
 * directory. This repo's `tsconfig.base.json` carries `allowImportingTsExtensions`, so leaving it
 * out flagged every `.ts` import specifier with a false TS5097. Returns config names relative to
 * the snapshot root, ready to be passed as preferred paths.
 */
export async function configDependencies(access: SourceAccess, configPath: string) {
  const found: string[] = [];
  const queued = new Set([configPath]);
  let pending = [configPath];
  while (pending.length && found.length < MAX_CONFIGS) {
    access.signal.throwIfAborted();
    const current = pending.shift() as string;
    const config = await readSource(access, join(access.root, current)).catch((error: unknown) => {
      // A missing base config is the compiler's reason to report, not this helper's failure.
      access.signal.throwIfAborted();
      if (!skippableError(error)) throw error;
      return undefined;
    });
    if (!config) continue;
    const base = dirname(join(access.root, config.path));
    for (const specifier of configReferences(config.text) ?? []) {
      // Package-style targets resolve into node_modules, which the snapshot excludes anyway.
      if (!specifier.startsWith(".") && !isAbsolute(specifier)) continue;
      const target = resolve(base, specifier);
      // Same probe order TypeScript uses: the literal path, a `.json`, or a project directory.
      for (const candidate of [target, `${target}.json`, join(target, "tsconfig.json")]) {
        access.signal.throwIfAborted();
        const dependency = await readSource(access, candidate).catch((error: unknown) => {
          access.signal.throwIfAborted();
          if (!skippableError(error)) throw error;
          return undefined;
        });
        if (!dependency) continue;
        if (DEPENDENCY_TREE.test(dependency.path) || queued.has(dependency.path)) break;
        queued.add(dependency.path);
        found.push(dependency.path);
        pending = [...pending, dependency.path];
        break;
      }
    }
  }
  return found;
}

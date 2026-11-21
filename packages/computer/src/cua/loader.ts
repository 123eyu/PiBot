import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as CuaModule from "@trycua/cua-driver";

export type Cua = typeof CuaModule;

/**
 * Cua's N-API runtime dlopen()s its dylib/so/dll from a path computed from its own module
 * location, and nothing can be dlopen()ed from inside app.asar. Packaging
 * unpacks @trycua/** and @ubjs/** (electron-builder asarUnpack), so the entry is imported from
 * the unpacked twin; its relative imports then resolve to real files as well.
 */
export function unpackedEntry(entryUrl: string): string {
  return entryUrl.replace(/\/app\.asar\//, "/app.asar.unpacked/");
}

const ENTRY = join("node_modules", "@trycua", "cua-driver", "dist", "index.js");

/**
 * Finds the SDK next to the running bundle by walking up to the nearest node_modules that has
 * it (packaged: app.asar/node_modules, which Electron's fs can see; development: the desktop
 * package's node_modules). Walking with fs avoids depending on ESM resolution inside asar.
 */
export function resolveCuaEntry(from: string = import.meta.url): string {
  for (let dir = dirname(fileURLToPath(from)); ; dir = dirname(dir)) {
    const candidate = join(dir, ENTRY);
    if (existsSync(candidate)) return unpackedEntry(pathToFileURL(candidate).href);
    if (dirname(dir) === dir) break;
  }
  return unpackedEntry(import.meta.resolve("@trycua/cua-driver"));
}

/**
 * Loads the SDK once per process. The caller (the background process entry) must have
 * switched off Cua's telemetry and update checks in the environment before this runs; the
 * SDK build has no sender but later builds might.
 */
export function createCuaLoader(entry: () => string = resolveCuaEntry) {
  let loading: Promise<Cua> | undefined;
  return {
    // A failed dlopen is kept, not retried: callers see "unavailable" without re-attempting
    // the native load on every call.
    load(): Promise<Cua> {
      loading ??= import(/* @vite-ignore */ toUrl(entry())) as Promise<Cua>;
      return loading;
    },
  };
}

function toUrl(entry: string): string {
  return entry.startsWith("file:") ? entry : pathToFileURL(entry).href;
}

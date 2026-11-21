// Every child Node workload (sandbox hosts, the
// violation-log supervisor, checkpoint scripts, built-in stdio plugin servers, external-agent
// adapters) runs on a separately signed Node shipped next to the app, never on Pi Bot's own
// executable. The packaged app turns Electron's RunAsNode fuse off, so nothing inside any sandbox
// can start Pi Bot as Node and act with Pi Bot's identity (keychain items, code signature).
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, sep } from "node:path";
import { ExecError } from "../core/types.ts";

/** Pinned with the packaging step (apps/desktop/scripts/package/node-helper.ts). */
export const CHILD_NODE_VERSION = "26.11.1";

export interface ChildNodeRuntime {
  executable: string;
  /** `self`: plain Node (CLI, runner, tests); `bundled`: the app's helper; `development`: PATH. */
  source: "self" | "bundled" | "development";
}

const executable = (path: string) => {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    // Missing or not executable: the caller decides whether that is fatal.
    return false;
  }
};

/** Where the packaged helper lives inside the app's resources folder. */
export function bundledNodePath(resourcesPath: string, platform: NodeJS.Platform) {
  return join(resourcesPath, "bin", platform === "win32" ? "node.exe" : "node");
}

/**
 * The Node every child workload runs on. Under plain Node that is the current executable. Inside
 * Electron it is the packaged helper; a packaged app without it fails closed. `pnpm dev` (the
 * unpackaged Electron from node_modules, whose resources folder holds no helper) uses the
 * developer's `node` on PATH instead, the toolchain pinned by .nvmrc.
 */
export function childNodeRuntime(): ChildNodeRuntime {
  if (!process.versions.electron) return { executable: process.execPath, source: "self" };
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  if (resources) {
    const bundled = bundledNodePath(resources, process.platform);
    if (executable(bundled)) return { executable: bundled, source: "bundled" };
    const unpackaged = resources.includes(`${sep}node_modules${sep}electron${sep}dist${sep}`);
    if (unpackaged) {
      const name = process.platform === "win32" ? "node.exe" : "node";
      // Development only: the unpackaged Electron has no helper; the PATH toolchain stands in.
      for (const dir of (process.env.PATH ?? "").split(delimiter))
        if (dir && isAbsolute(dir) && executable(join(dir, name)))
          return { executable: join(dir, name), source: "development" };
    }
  }
  throw new ExecError("isolation_unavailable");
}

/**
 * A script shipped inside app.asar, as the path plain Node can open: the packaging step unpacks
 * every child entry (and what it imports) to app.asar.unpacked.
 */
export function unpackedPath(path: string) {
  return path.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);
}

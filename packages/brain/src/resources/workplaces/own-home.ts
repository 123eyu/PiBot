import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { RpcError } from "@pibot/protocol-base";
import { abortable } from "../../core/abort.ts";

/** App-owned roots must not follow a replaced parent into another group's or user's files. */
export async function ensureOwnHome(dataDir: string, parts: string[], signal: AbortSignal) {
  let path = await abortable(realpath(dataDir), signal);
  for (const part of parts) {
    signal.throwIfAborted();
    path = join(path, part);
    const existing = await abortable(
      lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      }),
      signal,
    );
    if (!existing) {
      await abortable(
        mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        }),
        signal,
      );
    }
    const info = existing ?? (await abortable(lstat(path), signal));
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path)
      throw new RpcError(-32602, "workspace_boundary_changed");
  }
  signal.throwIfAborted();
  return path;
}

import { lstat, opendir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  type ConnectorImportFileChanges,
  RpcError,
  RpcErrorCodes,
} from "@pibot/plugins-contract/full";

/** Names only: the comparison never reads installed resource contents or plugin-data. */
export async function importFileChanges(
  root: string,
  next: Iterable<string>,
  signal: AbortSignal,
): Promise<ConnectorImportFileChanges> {
  const before = new Set<string>();
  let entries = 0;
  const invalid = (): never => {
    throw new RpcError(RpcErrorCodes.pluginImportInvalid, "connector_import_layout_unsupported");
  };
  const walk = async (path: string): Promise<void> => {
    signal.throwIfAborted();
    if (++entries > 100_001) invalid();
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) invalid();
    if (stat.isDirectory()) {
      for await (const entry of await opendir(path)) await walk(join(path, entry.name));
    } else if (stat.isFile()) before.add(relative(root, path));
    else invalid();
  };
  try {
    if ((await realpath(root)) !== root) invalid();
    await walk(root);
  } catch (error) {
    // A new import has no installed directory to compare. Missing descendants are a changed source.
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT" &&
        entries === 0
      )
    )
      throw error;
  }
  signal.throwIfAborted();
  const after = new Set(next);
  const added = [...after].filter((name) => !before.has(name)).sort();
  const removed = [...before].filter((name) => !after.has(name)).sort();
  return {
    added: added.slice(0, 300),
    removed: removed.slice(0, 300),
    truncated: added.length > 300 || removed.length > 300,
  };
}

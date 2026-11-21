import { lstat, realpath } from "node:fs/promises";
import { fileIdentity } from "../core/file-identity.ts";
import { ExecError } from "../core/types.ts";
import type { ManagedPathIdentity } from "./managed-boundary.ts";

export function managedIdentityStrategy(platform: NodeJS.Platform) {
  const windows = platform === "win32";
  async function identity(path: string): Promise<ManagedPathIdentity> {
    const info = await lstat(path, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path)
      throw new ExecError(windows ? "managed_identity_changed" : "outside_workplace");
    return { path, ...fileIdentity(info) };
  }
  async function hold(
    identities: ManagedPathIdentity[],
    signal: AbortSignal,
    authorize: () => void,
  ) {
    if (!windows) return undefined;
    const check = async (skip: ReadonlySet<string> = new Set()) => {
      signal.throwIfAborted();
      authorize();
      for (const expected of identities) {
        if (skip.has(expected.path)) continue;
        const actual = await identity(expected.path);
        if (actual.device !== expected.device || actual.inode !== expected.inode)
          throw new ExecError("managed_identity_changed");
      }
      authorize();
    };
    await check();
    return { check, close: async () => {} };
  }
  return { identity, hold };
}

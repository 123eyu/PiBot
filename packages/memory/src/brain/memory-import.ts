import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { BrainHost, RegisterRpc } from "@pibot/brain/kit";
import { RpcError, RpcErrorCodes } from "@pibot/protocol-base";

/** Only the host's current selection is readable; no caller-supplied path crosses this port. */
export function registerMemoryImport(handle: RegisterRpc, host: Pick<BrainHost, "pickFile">) {
  handle("memory.pickImport", async (_params, { signal }) => {
    if (!host.pickFile) throw new RpcError(RpcErrorCodes.unsupported, "memory_import_unavailable");
    const path = await host.pickFile(signal);
    signal.throwIfAborted();
    if (!path) return null;
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    try {
      // Bigint stats keep NTFS-sized inodes exact (see execution core/file-identity.ts).
      const selected = await lstat(path, { bigint: true });
      if (!selected.isFile() || selected.isSymbolicLink()) throw new Error("memory_import_invalid");
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        bounded.throwIfAborted();
        const before = await file.stat({ bigint: true });
        if (
          !before.isFile() ||
          before.dev !== selected.dev ||
          before.ino !== selected.ino ||
          before.nlink !== 1n ||
          before.size > 1048576n
        )
          throw new Error("memory_import_invalid");
        const buffer = Buffer.alloc(1048577);
        let length = 0;
        while (length < buffer.length) {
          bounded.throwIfAborted();
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        const content = buffer.subarray(0, length);
        bounded.throwIfAborted();
        const after = await file.stat({ bigint: true });
        if (
          content.length > 1048576 ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        )
          throw new Error("memory_import_changed");
        return new TextDecoder("utf-8", { fatal: true }).decode(content);
      } finally {
        await file.close();
      }
    } catch {
      signal.throwIfAborted();
      throw new RpcError(-32602, "memory_import_invalid");
    }
  });
}

import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { RpcError, RpcErrorCodes } from "@pibot/protocol";

export type MacOfficeAppQuery = (
  id: string,
  signal: AbortSignal,
) => Promise<{ id: string; name: string } | undefined>;

/** Office discovery needs the system's bundle index, not screen capture or native input. */
export const queryMacOfficeApp: MacOfficeAppQuery = async (id, signal) => {
  signal.throwIfAborted();
  // Only the host's fixed bundle IDs may enter the metadata query language.
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+){2,}$/.test(id))
    throw new RpcError(RpcErrorCodes.invalidParams, "office_application_id_invalid");
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      "/usr/bin/mdfind",
      // The allowlist normalizes IDs; installed bundles keep mixed case (com.apple.iWork.Pages).
      // Spotlight's query language marks case-insensitive with a trailing c ('…'c); the
      // NSPredicate form ==[c] matches nothing here.
      ["-0", `kMDItemCFBundleIdentifier == '${id}'c`],
      { signal, timeout: 3_000, maxBuffer: 64 * 1024, encoding: "utf8" },
      (error, stdout) => {
        // OS errors can echo paths; keep them out of RPC errors and logs.
        if (signal.aborted) reject(signal.reason);
        else if (error)
          reject(new RpcError(RpcErrorCodes.internal, "office_application_query_failed"));
        else resolve(stdout);
      },
    );
  });
  for (const path of output.split("\0").slice(0, 32)) {
    signal.throwIfAborted();
    if (!isAbsolute(path) || !path.endsWith(".app")) continue;
    try {
      // Spotlight can retain a deleted installation; don't offer a stale result.
      if ((await stat(path)).isDirectory())
        return { id, name: basename(path, ".app").slice(0, 200) || id };
    } catch (error) {
      signal.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new RpcError(RpcErrorCodes.internal, "office_application_query_failed");
    }
  }
  signal.throwIfAborted();
  return undefined;
};

export async function macOfficeApps(
  ids: string[],
  signal: AbortSignal,
  query: MacOfficeAppQuery = queryMacOfficeApp,
) {
  // Settle every bounded query before returning. One slow or failing app query must not hide
  // the apps that were found (e.g. WPS); only when every query failed is the list unavailable.
  const results = await Promise.allSettled(ids.map((id) => query(id, signal)));
  signal.throwIfAborted();
  const failed = results.filter((result) => result.status === "rejected");
  if (failed.length === results.length && failed[0]) throw failed[0].reason;
  return results.flatMap((result) =>
    result.status === "fulfilled" && result.value
      ? [
          {
            ...result.value,
            name:
              result.value.id.toLowerCase() === "com.kingsoft.wpsoffice.mac"
                ? "WPS Office"
                : result.value.name,
          },
        ]
      : [],
  );
}

import { stat } from "node:fs/promises";
import { dirname, extname, sep } from "node:path";
import { runLaunch } from "@pibot/computer";
import { RpcError, RpcErrorCodes } from "@pibot/protocol";
import { shell } from "electron";

/**
 * A folder is opened as itself; anything else (a file, or a macOS package such as an .app, which
 * is a directory that Finder would launch if asked to open it) is only selected in its parent.
 * A named macOS directory with an extension is treated as a package: selecting a plain folder
 * that happens to have a dot in its name is harmless, launching an app is not.
 */
async function opensAsFolder(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isDirectory()) return false;
  } catch {
    // The caller already checked the path; one that vanished since is shown like a file, and the
    // reveal below then fails with path_reveal_failed instead of opening anything else.
    return false;
  }
  return process.platform !== "darwin" || extname(path) === "";
}

/** The caller has already checked the file identity and its allowed roots. */
export async function revealFile(
  path: string,
  check: () => void,
  signal: AbortSignal,
): Promise<void> {
  const active = () => {
    check();
    if (signal.aborted)
      throw new RpcError(
        signal.reason instanceof Error && signal.reason.name === "TimeoutError"
          ? RpcErrorCodes.timeout
          : RpcErrorCodes.closed,
        "path_reveal_cancelled",
      );
  };
  active();
  if (typeof shell.showItemInFolder !== "function")
    throw new RpcError(RpcErrorCodes.unsupported, "path_reveal_unsupported");
  const folder = await opensAsFolder(path);
  active();
  // Electron can activate Finder without displaying the requested folder on macOS.
  // Select Finder explicitly; runLaunch uses fixed argv without a shell.
  // A trailing separator only resolves to a directory: if the folder were swapped for a file after
  // the check above, opening fails instead of launching that file (shell.openPath runs files).
  const target = folder ? (path.endsWith(sep) ? path : `${path}${sep}`) : dirname(path);
  try {
    if (process.platform === "darwin")
      await runLaunch({ argv: ["/usr/bin/open", "-b", "com.apple.finder", target] }, signal);
    else if (await shell.openPath(target))
      throw new RpcError(RpcErrorCodes.internal, "path_reveal_failed");
  } catch {
    active();
    throw new RpcError(RpcErrorCodes.internal, "path_reveal_failed");
  }
  active();
  if (folder) return;
  try {
    shell.showItemInFolder(path);
  } catch {
    throw new RpcError(RpcErrorCodes.internal, "path_reveal_failed");
  }
}

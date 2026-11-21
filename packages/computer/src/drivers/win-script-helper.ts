import { type ChildProcessByStdio, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

/*
 * A resident PowerShell helper keeps its script in a file rather than on the command line.
 * Windows caps a command line at 32,767 characters, and the base64 of a UTF-16 script grows
 * faster than the script does: the password probe's script once passed the cap, so every
 * spawn failed with ENAMETOOLONG and every write was reported as driver_error ("may have been
 * sent") while nothing had been sent. A file has no such limit, and PowerShell
 * still reads it once at startup, so the file is short-lived.
 *
 * The caller gets the same stdio shape as before (`pipe`, `pipe`, `ignore`): one line in, one
 * line out.
 */

export type HelperProcess = ChildProcessByStdio<Writable, Readable, null>;

/** Deletes without throwing: cleanup must never turn a working helper into a failed query. */
function remove(target: string) {
  try {
    rmSync(target, { recursive: true, force: true });
  } catch {
    // On Windows a just-killed process can still hold the file for a moment; the OS temp
    // directory is the place to leave it then.
  }
}

/**
 * Starts `powershell.exe -File <temp script>`. Throws when the script cannot be written or the
 * process cannot be spawned at all; callers treat that as "no query was answered", never as a
 * negative answer.
 */
export function spawnScriptHelper(script: string): HelperProcess {
  const dir = mkdtempSync(join(tmpdir(), "pibot-ps-"));
  const file = join(dir, "helper.ps1");
  let child: HelperProcess;
  try {
    // PowerShell 5.1 reads a .ps1 without a BOM as the ANSI code page, so a UTF-8 BOM keeps the
    // script's bytes meaning what they say if it ever gains non-ASCII text. 0600 is the closest
    // POSIX-style hint available; on Windows the file inherits the account's temp directory ACL.
    writeFileSync(file, `\uFEFF${script}`, { encoding: "utf8", mode: 0o600 });
    child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        // A .ps1 from a temp directory is not signed; without this the default policy refuses it.
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        file,
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
    );
  } catch (error) {
    remove(dir);
    throw error;
  }
  // PowerShell parses the whole -File script before it runs any of it, so the first output means
  // the file has been read. Deleting it then keeps a copy of the helper out of the temp directory
  // for the life of the app (and after a crash).
  child.stdout.once("data", () => remove(dir));
  child.once("exit", () => remove(dir));
  child.once("error", () => remove(dir));
  return child;
}

import { execFile, spawn } from "node:child_process";
import { win32 } from "node:path";
import type { ComputerOpenTarget } from "@pibot/protocol-base";
import { ComputerError } from "../core/errors.ts";
import type { Platform } from "../core/types.ts";
import { windowsPackagedAppId } from "../core/windows-app-id.ts";

// App names become argv entries, never shell text; still keep them to plain names so a
// launcher cannot read them as options or paths.
const APP_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._+&()-]{0,99}$/u;

function appName(name: string): string {
  if (!APP_NAME.test(name)) throw new ComputerError("unsupported", "app_name_not_plain");
  return name;
}

// Grants and the gate work in app IDs (bundle IDs on macOS), and `open -a` only takes a
// display name or path, so a reverse-DNS ID has to go through `open -b`.
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+){2,}$/;
function macApp(app: string): string[] {
  return BUNDLE_ID.test(app) ? ["-b", app] : ["-a", appName(app)];
}

export interface LaunchCommand {
  argv: string[];
  /**
   * Start the program itself and return once it has spawned, without tying its lifetime to
   * this process (Windows: an app opened with a file has no launcher that hands it off).
   */
  detached?: boolean;
  /** explorer.exe reports 1 even when it opened the target, so its exit code means nothing. */
  ignoreExitCode?: boolean;
}
// Launchers return once the request is handed to the system; a slow app start does not hold it.
const LAUNCH_TIMEOUT_MS = 15_000;

/** Windows exe IDs are resolved to the current OS-listed path immediately before launch. */
function windowsExe(path: string | undefined): string {
  if (!path || !win32.isAbsolute(path) || !/\.exe$/i.test(path))
    throw new ComputerError("unsupported", "windows_app_path_unknown");
  return path;
}

/**
 * Opening runs here, not in packages/execution, because the command sandbox blocks the
 * LaunchServices / session-bus helpers every launcher needs (macOS: kLSUnknownErr -10810). The
 * argv is fixed per platform and only carries a granted app ID / name, the exe path the driver
 * reported for that ID (Windows) and an absolute file path, so the model never supplies command
 * text. macOS uses `open -g` so the app opens without taking the foreground.
 */
export function launchCommand(
  platform: Platform,
  target: ComputerOpenTarget,
  windowsAppPath?: string,
): LaunchCommand {
  switch (platform) {
    case "darwin":
      return target.kind === "app"
        ? { argv: ["/usr/bin/open", "-g", ...macApp(target.name)] }
        : {
            argv: [
              "/usr/bin/open",
              "-g",
              ...(target.app ? macApp(target.app) : []),
              // Absolute (schema-checked), so it can never be read as an option.
              target.path,
            ],
          };
    case "linux":
      // App IDs are .desktop ids (drivers/linux.ts), which is what gtk-launch takes.
      return target.kind === "app"
        ? { argv: ["gtk-launch", appName(target.name)] }
        : target.app
          ? { argv: ["gtk-launch", appName(target.app), target.path] }
          : { argv: ["xdg-open", target.path] };
    case "win32":
      // explorer.exe hands the target to the shell (default handler / the exe) without any
      // command-line parsing of ours; opening a file in a chosen app starts that exe directly.
      if (target.kind === "file" && !target.app)
        return { argv: ["explorer.exe", target.path], ignoreExitCode: true };
      if (target.kind === "app") {
        const packaged = windowsAppPath && windowsPackagedAppId(windowsAppPath);
        // The OS list was refreshed after authorization; bind this namespace to that grant.
        if (packaged && packaged === target.name.toLowerCase())
          return {
            argv: ["explorer.exe", `shell:AppsFolder\\${packaged}`],
            ignoreExitCode: true,
          };
        return { argv: ["explorer.exe", windowsExe(windowsAppPath)], ignoreExitCode: true };
      }
      return { argv: [windowsExe(windowsAppPath), target.path], detached: true };
  }
}

function launchError(
  error: { code?: string | number | null; killed?: boolean },
  signal: AbortSignal,
) {
  if (signal.aborted) return new ComputerError("cancelled", "launch");
  if (error.code === "ENOENT") return new ComputerError("unsupported", "launcher_missing");
  // stderr can echo the file path, so only the kind of failure goes back to the model.
  return error.killed
    ? new ComputerError("timeout", "launch")
    : new ComputerError("driver_error", "launch_failed");
}

export function runLaunch(command: LaunchCommand, signal: AbortSignal): Promise<void> {
  const [file, ...args] = command.argv;
  if (!file) return Promise.reject(new ComputerError("unsupported", "launch_empty"));
  // windowsHide would pass SW_HIDE on to the app being opened and hide its main window.
  const windowsHide = false;
  if (command.detached)
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new ComputerError("cancelled", "launch"));
      // No signal here: the opened app must outlive the grant that opened it.
      const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide });
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
      child.once("error", (error: NodeJS.ErrnoException) => reject(launchError(error, signal)));
    });
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: LAUNCH_TIMEOUT_MS, windowsHide, signal }, (error) => {
      if (!error || (command.ignoreExitCode && typeof error.code === "number")) return resolve();
      reject(launchError(error, signal));
    });
  });
}

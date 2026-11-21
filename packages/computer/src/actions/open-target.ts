import { lstat, realpath } from "node:fs/promises";
import { extname } from "node:path";
import type { ComputerOpenTarget } from "@pibot/protocol-base";
import { resolveAppName } from "../core/app-names.ts";
import { type Call, isBlocked, type ServiceContext } from "../core/context.ts";
import { bounded, ComputerError } from "../core/errors.ts";

const EXECUTABLE = new Set([
  ".app",
  ".exe",
  ".com",
  ".scr",
  ".msi",
  ".msp",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".command",
  ".bat",
  ".cmd",
  ".ps1",
  ".psm1",
  ".vbs",
  ".vbe",
  ".wsf",
  ".wsh",
  ".js",
  ".jse",
  ".hta",
  ".desktop",
  ".lnk",
  ".url",
  ".workflow",
  ".scpt",
  ".applescript",
  ".py",
  ".pyw",
  ".rb",
  ".pl",
  ".jar",
  ".run",
  ".bin",
  ".appimage",
]);
const executable = (path: string) =>
  path.split(/[\\/]/).some((part) => EXECUTABLE.has(extname(part).toLowerCase()));

/** Resolve aliases to IDs before checking the granted list; names never grant access. */
export async function checkedOpenTarget(
  ctx: ServiceContext,
  call: Call,
  target: ComputerOpenTarget,
): Promise<ComputerOpenTarget> {
  const requested = target.kind === "app" ? target.name : target.app;
  if (!requested) throw new ComputerError("app_not_granted", "file_app_required");
  const named =
    target.kind === "app"
      ? call.scope.apps.filter((held) => held.name.toLowerCase() === requested.toLowerCase())
      : [];
  let app =
    call.scope.apps.find((held) => held.id.toLowerCase() === requested.toLowerCase()) ??
    (named.length === 1 ? named[0] : undefined);
  if (!app) {
    const id = await resolveAppName(ctx, requested, call.signal);
    app = id
      ? call.scope.apps.find((held) => held.id.toLowerCase() === id.toLowerCase())
      : undefined;
  }
  call.signal.throwIfAborted();
  if (!app) throw new ComputerError("app_not_granted");
  if (isBlocked(ctx, app)) throw new ComputerError("app_blocked");
  if (target.kind === "app") return { kind: "app", name: app.id };
  if (executable(target.path))
    throw new ComputerError("unsupported", "executable_file_not_allowed");
  const file = await bounded("open_file.inspect", 5000, call.signal, () =>
    realpath(target.path)
      .then(async (path) => ({ path, info: await lstat(path) }))
      .catch(() => {
        throw new ComputerError("window_not_found", "file_unavailable");
      }),
  );
  const { path, info } = file;
  call.signal.throwIfAborted();
  // A folder is not a program; its execute bits made it look like one. Point the model at
  // the reveal tool in one step instead of letting it drive the file manager.
  if (info.isDirectory() && !executable(path))
    throw new ComputerError("unsupported", "folder_use_reveal_in_folder");
  if (
    !info.isFile() ||
    executable(path) ||
    (ctx.driver.platform !== "win32" && (info.mode & 0o111) !== 0)
  )
    throw new ComputerError("unsupported", "executable_file_not_allowed");
  return { kind: "file", app: app.id, path };
}

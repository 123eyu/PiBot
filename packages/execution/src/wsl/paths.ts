import { posix, win32 } from "node:path";

/** Maps drive syntax only; callers must still verify the mount and both filesystem identities. */
export function wslPath(path: string): string {
  if (
    !/^[a-z]:\\/i.test(path) ||
    /[\p{Cc}\p{Cf}]/u.test(path) ||
    path.slice(2).includes(":") ||
    path.includes("/") ||
    path.split("\\").some((part) => part === "." || part === "..")
  )
    throw new Error("wsl_path_unsupported");
  const normalized = win32.normalize(path);
  return posix.join("/mnt", normalized[0]?.toLowerCase() ?? "", ...normalized.slice(3).split("\\"));
}

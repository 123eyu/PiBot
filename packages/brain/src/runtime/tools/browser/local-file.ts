import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { containsPath, type PolicyResult } from "@pibot/policy";
import { LocalBrowserDocumentExtensionSchema, type WorkspaceSnapshot } from "@pibot/protocol-base";

/** Ordinary read consent cannot expand the browser host's workplace-only file boundary. */
export function localBrowserFileUnavailable(
  url: string | undefined,
  result: PolicyResult,
  boundary: WorkspaceSnapshot,
  platform: "darwin" | "linux" | "win32",
): boolean {
  if (!url || !/^file:/i.test(url)) return false;
  if (boundary.location && boundary.location.target !== "local") return true;
  let path: string;
  try {
    const parsed = new URL(url);
    if (parsed.hostname) return true;
    path = fileURLToPath(parsed);
  } catch {
    return true;
  }
  const resolved = result.path;
  return (
    !LocalBrowserDocumentExtensionSchema.safeParse(extname(path).toLowerCase()).success ||
    !resolved?.exists ||
    !boundary.readRoots.some((root) => containsPath(root, resolved.path, platform))
  );
}

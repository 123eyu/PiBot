import type { PathContext } from "../core/types.ts";
import { containsPath, pathApi } from "./paths.ts";

/** Only brain supplies these roots; glob interpretation is deliberately limited to .aider*. */
export function isAiConfigPath(
  path: string,
  boundary: { roots: readonly string[]; globs: readonly string[] },
  context: PathContext,
): boolean {
  if (boundary.roots.some((root) => containsPath(root, path, context.platform))) return true;
  const api = pathApi(context.platform);
  return boundary.globs.some((glob) => {
    if (api.basename(glob) !== ".aider*") return false;
    const parent = api.dirname(glob);
    if (!containsPath(parent, path, context.platform)) return false;
    const first =
      api.relative(parent, path).split(context.platform === "win32" ? /[/\\]/ : /\//)[0] ?? "";
    return (context.platform === "win32" ? first.toLowerCase() : first).startsWith(".aider");
  });
}

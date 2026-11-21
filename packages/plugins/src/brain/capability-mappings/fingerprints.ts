import type { CapabilityMatchInput } from "./types.ts";

const hasAll = (names: ReadonlySet<string>, required: readonly string[]) =>
  required.every((name) => names.has(name));

export const builtinApp =
  (pluginId: string) =>
  ({ plugin }: CapabilityMatchInput) =>
    plugin.sourceKind === "builtin" && plugin.pluginId === pluginId;

/**
 * The official filesystem server has used read_file and read_text_file across published
 * generations. The other four anchors are stable and keep a generic one-tool server from
 * accidentally claiming this capability.
 */
export function filesystemFingerprint({ plugin, toolNames }: CapabilityMatchInput): boolean {
  if (plugin.sourceKind === "builtin") return false;
  return (
    (toolNames.has("read_file") || toolNames.has("read_text_file")) &&
    hasAll(toolNames, ["list_directory", "search_files", "write_file", "edit_file"])
  );
}

export function fetchFingerprint({ plugin, toolNames }: CapabilityMatchInput): boolean {
  return plugin.sourceKind !== "builtin" && toolNames.size === 1 && toolNames.has("fetch");
}

export function playwrightFingerprint({ plugin, toolNames }: CapabilityMatchInput): boolean {
  return (
    plugin.sourceKind !== "builtin" &&
    hasAll(toolNames, ["browser_navigate", "browser_click", "browser_snapshot", "browser_type"])
  );
}

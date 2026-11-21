import { createHash } from "node:crypto";
import type { LocalToolDefinition } from "../core/types.ts";

export function toolVersion(value: unknown): string {
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : item && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, entry]) => [key, canonical(entry)]),
          )
        : item;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export function localToolIdentity(tool: LocalToolDefinition) {
  return {
    id: tool.id ?? `pibot:${tool.name}`,
    name: tool.name,
    schemaVersion: toolVersion(tool.parameters),
    implementationVersion: tool.implementationVersion ?? "1",
  };
}
export function toolBinding(tool: LocalToolDefinition): string {
  return toolVersion({
    identity: localToolIdentity(tool),
    declaredSchemaVersion: tool.schemaVersion,
    // The discovery directory is scoped metadata; changing its available groups is not a new executor.
    description: tool.name === "tool_discover" ? tool.description.split("\n")[0] : tool.description,
    loadGroup: tool.loadGroup,
  });
}

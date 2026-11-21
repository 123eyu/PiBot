import { createHash } from "node:crypto";
import type { ConnectionCheckId, ConnectorTool } from "@pibot/protocol";
import type { JSONType } from "zod";

/**
 * Preset checks. Each names the read-only tools it can use (best first) and the fixed
 * question it asks; the person only sees the preset's name. Tool names follow the common GitHub
 * MCP servers (github/github-mcp-server and the older @modelcontextprotocol/server-github), and
 * arguments are filled only from what the tool's own schema declares.
 */
interface Preset {
  tools: readonly string[];
  query: string;
  /**
   * When set, "new" means this counter went up (PR comments), not that the item appeared: a
   * newly opened PR without comments, a deleted comment, a push or a label change is not new.
   */
  count?(item: Record<string, unknown>): number | undefined;
}
const itemId = (item: Record<string, unknown>) =>
  item.id ?? item.node_id ?? item.html_url ?? item.url ?? item.number;
const counter = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const PRESETS: Record<ConnectionCheckId, Preset> = {
  "github.assigned_issues": {
    tools: ["search_issues"],
    query: "is:issue is:open assignee:@me",
  },
  "github.pr_comments": {
    // github-mcp-server adds `is:issue` to search_issues queries, so its PR search goes first.
    tools: ["search_pull_requests", "search_issues"],
    query: "is:pr is:open author:@me",
    count: (item) => counter(item.comments),
  },
};
export const CONNECTION_CHECK_IDS = Object.keys(PRESETS) as ConnectionCheckId[];
const MAX_SEEN = 500;
export type SeenItem = { key: string; count?: number; at: string };

const named = (tool: string, wanted: string) =>
  tool === wanted || [`_${wanted}`, `-${wanted}`, `.${wanted}`].some((end) => tool.endsWith(end));

/** The tool call a preset makes on this catalog, or undefined when the catalog cannot answer it. */
export function presetCall(
  check: ConnectionCheckId,
  tools: readonly Pick<ConnectorTool, "tool" | "schema" | "readOnly" | "enabled">[],
): { tool: string; args: Record<string, JSONType> } | undefined {
  const preset = PRESETS[check];
  for (const wanted of preset.tools)
    for (const tool of tools) {
      if (!tool.enabled || !tool.readOnly || !named(tool.tool, wanted)) continue;
      const args = presetArgs(preset, tool.schema);
      if (args) return { tool: tool.tool, args };
    }
  return undefined;
}
function presetArgs(preset: Preset, schema: Record<string, JSONType>) {
  const properties =
    schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : {};
  const args: Record<string, JSONType> = {};
  const query = ["query", "q"].find((name) => name in properties);
  if (!query) return undefined;
  args[query] = preset.query;
  const perPage = ["perPage", "per_page"].find((name) => name in properties);
  if (perPage) args[perPage] = 50;
  if ("sort" in properties && allows(properties.sort, "updated")) args.sort = "updated";
  if ("order" in properties && allows(properties.order, "desc")) args.order = "desc";
  // A required argument the preset cannot know (an owner, a repository) means the tool does not fit.
  const required = Array.isArray(schema.required) ? schema.required : [];
  return required.every((name) => typeof name === "string" && name in args) ? args : undefined;
}
function allows(property: unknown, value: string) {
  const values = (property as { enum?: unknown } | undefined)?.enum;
  return !Array.isArray(values) || values.includes(value);
}

/**
 * The items of a check's result as keys (truncated SHA-256 of each item's identity) plus the
 * preset's counter, never the items. A result that is not a recognisable list is one item, so
 * any change to it is new.
 */
export function resultItems(check: ConnectionCheckId, value: unknown) {
  const preset = PRESETS[check];
  const items = listOf(value);
  const found = new Map<string, number | undefined>();
  for (const item of items ?? [value]) {
    const object =
      items && item && typeof item === "object" && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : undefined;
    const key = itemKey(stableJson(object ? (itemId(object) ?? object) : item));
    if (!found.has(key)) found.set(key, object && preset.count ? preset.count(object) : undefined);
    if (found.size >= MAX_SEEN) break;
  }
  return [...found].map(([key, count]) => ({ key, count }));
}
function listOf(value: unknown) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  for (const key of ["items", "issues", "pull_requests", "pullRequests", "results", "nodes"])
    if (Array.isArray(object[key])) return object[key] as unknown[];
  return undefined;
}
export function itemKey(text: string) {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}
/** JSON with sorted object keys, so the same data always has the same fingerprint. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/**
 * Compares this check with everything seen before; the first check only records what is there.
 * Without a counter an unseen item is new. With one (PR comments) an item is new when its count
 * rose, or when it was never seen and already has comments.
 */
export function connectionChange(
  check: ConnectionCheckId,
  previous: readonly SeenItem[] | undefined,
  items: readonly { key: string; count?: number }[],
  now: number,
): { fresh: number; seen: SeenItem[] } {
  const at = new Date(now).toISOString();
  const known = new Map((previous ?? []).map((item) => [item.key, item]));
  const counted = !!PRESETS[check].count;
  let fresh = 0;
  for (const item of items) {
    const before = known.get(item.key);
    if (
      previous &&
      (counted
        ? item.count !== undefined &&
          (before ? before.count !== undefined && item.count > before.count : item.count > 0)
        : !before)
    )
      fresh++;
    known.delete(item.key);
    known.set(item.key, {
      key: item.key,
      ...(item.count === undefined ? {} : { count: item.count }),
      at,
    });
  }
  // Insertion order is last-seen order: the items seen longest ago are dropped first.
  return { fresh, seen: [...known.values()].slice(-MAX_SEEN) };
}

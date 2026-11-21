import { createPolicyTrace } from "../core/explain.ts";
import type { PolicyResult } from "../core/types.ts";

/**
 * Tools whose arguments only address local state (paths, IDs, queries over the user's own files)
 * and are neither stored as content nor sent anywhere. Every other tool is checked, including tools
 * added later and capability tools: the check fails closed. The previous opt-in list
 * missed web_fetch and web_search, so a secret could leave in a URL or a search query.
 */
const LOCAL_READ_ONLY = new Set([
  "read_file",
  "reveal_in_folder",
  "list_dir",
  "find_files",
  "search_text",
  "code_navigate",
  "code_outline",
  "code_symbols",
  "code_map",
  "review_read",
  "tool_discover",
  "connector_discover",
  "read_messages",
  "task_status",
  "task_cancel",
  "todo_list",
  "memory_remove",
  "image_result",
  "screenshot",
  "ui_tree",
  "browser_screenshot",
  "browser_network",
  "browser_secret",
  "browser_diagnostics",
  "browser_inspect",
  "browser_download_list",
  "office_inspect",
  "office_read",
  "office_preview",
  "office_validate",
  "office_render",
  "office_capabilities",
]);

/** A known secret in a tool's arguments denies the call, unless the tool only reads local state. */
export function secretWriteOutDenied(
  tool: string,
  names: readonly string[],
): PolicyResult | undefined {
  if (!names.length || LOCAL_READ_ONLY.has(tool)) return undefined;
  return createPolicyTrace().result(
    {
      decision: "deny",
      reason: "secret_write_out",
      risk: "danger",
      canRemember: false,
      facts: [
        {
          kind: "warning",
          value: `内容里有密钥 / Content contains secret: ${names.join(", ")}`,
          risk: "danger",
        },
      ],
    },
    "secret",
  );
}

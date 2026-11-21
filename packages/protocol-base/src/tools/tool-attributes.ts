import type { Category } from "../permissions/settings.ts";

/**
 * What calling a tool does, declared once where the tool is registered. The lists that
 * need it (which tools leave a file, which permission category judges a call, which tools an audit
 * row may name) each had their own copy of the names; a review found `WRITE_FILE_TOOLS` missing
 * `office_template_fill` and `office_convert`, and a template tool only surfaced at verify.
 */
export interface ToolAttributes {
  /** The category `packages/policy` judges the call as; absent = no category of its own. */
  permission?: Category;
  /** A successful call leaves a file on disk: a delivery (office_convert) or an edit. */
  writesFile?: boolean;
  /** A call only reads. Defaults to "changes nothing on disk, the machine or elsewhere". */
  readOnly?: boolean;
  /** What the person receives from a successful call; a text answer when omitted. */
  output?: ToolOutput;
}

export type ToolOutput = "text" | "file" | "image" | "message";

/**
 * The traits callers derive from {@link ToolAttributes}. Reads, network and command use follow the
 * permission category rather than a second flag: one category already decides how a call is judged,
 * and two declarations of the same fact drift apart.
 */
export interface ToolTraits {
  readsFiles: boolean;
  writesFiles: boolean;
  network: boolean;
  executesCommand: boolean;
  readOnly: boolean;
  output: ToolOutput;
}

/**
 * The kernel catalog's attributes (`packages/brain/src/runtime/tools/tools.ts`). It lives in
 * protocol-base, not in brain, because `@pibot/agent` reads the same names (checkpoint evidence) and
 * must not depend on brain; protocol-base is the leaf both already depend on. The lint check
 * `tools/dev/tool-attributes.ts` fails when a registered tool has no entry here.
 */
export const KERNEL_TOOL_ATTRIBUTES = {
  apply_patch: { permission: "write_file", writesFile: true, output: "file" },
  ask_bot: { output: "message" },
  ask_user: {},
  assign_task: { output: "message" },
  // No category here: the old table never had one for it (only run_command/write_stdin), and the
  // matrix must not change.
  background_command: {},
  browser_back: { permission: "web" },
  // Ref and host-bound screenshot clicks share the web gate, never computer privileges.
  browser_click: { permission: "web" },
  browser_close: { permission: "web" },
  browser_network: { permission: "web" },
  browser_request: { permission: "web" },
  browser_secret: { permission: "web" },
  browser_diagnostics: { permission: "web" },
  browser_download_list: { permission: "web" },
  browser_inspect: { permission: "web" },
  browser_login: { permission: "web" },
  browser_open: { permission: "web" },
  browser_screenshot: { permission: "web", output: "image" },
  browser_scroll: { permission: "web" },
  browser_select: { permission: "web" },
  browser_snapshot: { permission: "web" },
  // Kept although no schema defines it today: a submission entry point would be judged as visiting.
  browser_submit: { permission: "web" },
  browser_tabs: { permission: "web" },
  browser_type: { permission: "web" },
  browser_wait: { permission: "web" },
  check_command_propose: {},
  code_map: { permission: "read_file" },
  code_navigate: { permission: "read_file" },
  code_outline: { permission: "read_file" },
  code_symbols: { permission: "read_file" },
  connection_needed: {},
  connector_call: { permission: "connector" },
  connector_discover: { permission: "connector" },
  delivery_evidence: {},
  edit_file: { permission: "write_file", writesFile: true, output: "file" },
  find_files: { permission: "list_dir" },
  finish_task: { output: "message" },
  group_pause: { output: "message" },
  group_plan: { output: "message" },
  image_generation: { permission: "web", output: "image" },
  image_result: { permission: "read_file", output: "image" },
  keys: { permission: "computer" },
  list_dir: { permission: "list_dir" },
  memory_add: {},
  memory_read: {},
  memory_remove: {},
  memory_search: {},
  memory_update: {},
  office_capabilities: {},
  office_convert: { permission: "write_file", writesFile: true, output: "file" },
  office_create: { permission: "write_file", writesFile: true, output: "file" },
  office_edit: { permission: "write_file", writesFile: true, output: "file" },
  office_inspect: { permission: "read_file" },
  office_preview: { permission: "read_file" },
  office_read: { permission: "read_file" },
  office_render: { permission: "read_file" },
  office_template_fields: {},
  // Judged by no category (it was missing from the old hand-written table too), but it delivers a
  // file, which is the fact that review needed; the attribute is what makes that impossible to forget.
  office_template_fill: { writesFile: true, output: "file" },
  office_validate: { permission: "read_file" },
  open_app: { permission: "computer" },
  open_file: { permission: "computer" },
  personal_todo: {},
  pointer: { permission: "computer" },
  // Retired from the catalog; kept so a call from an older client keeps its old category. It
  // declares no writesFile: the hand-written delivery list never had it, and a notes edit is not a
  // delivered document.
  project_notes: { permission: "write_file" },
  read_file: { permission: "read_file" },
  read_messages: { permission: "read_messages" },
  reveal_in_folder: { permission: "read_file" },
  review_finding: {},
  review_read: {},
  review_start: { permission: "read_file" },
  run_command: { permission: "run_command" },
  screenshot: { permission: "computer", output: "image" },
  search_text: { permission: "read_file" },
  send_file: { permission: "read_file", output: "message" },
  skill_propose: {},
  task_cancel: {},
  task_message: { output: "message" },
  task_spawn: { output: "message" },
  task_status: {},
  todo_list: {},
  todo_pause: {},
  todo_update: {},
  tool_discover: {},
  // Network state is read-only; a ping is judged by its own local-network card.
  local_network: { readOnly: true },
  ui_action: { permission: "computer" },
  ui_tree: { permission: "computer" },
  web_fetch: { permission: "web" },
  web_search: { permission: "web" },
  write_file: { permission: "write_file", writesFile: true, output: "file" },
  write_stdin: { permission: "run_command" },
} as const satisfies Record<string, ToolAttributes>;

export function toolTraits(
  attributes: ToolAttributes | undefined,
  permission: Category | undefined = attributes?.permission,
): ToolTraits {
  const writesFiles = attributes?.writesFile === true;
  return {
    readsFiles: permission === "read_file" || permission === "list_dir",
    writesFiles,
    network: permission === "web" || permission === "connector",
    executesCommand: permission === "run_command",
    readOnly:
      attributes?.readOnly ??
      (!writesFiles &&
        permission !== "run_command" &&
        permission !== "connector" &&
        permission !== "write_file" &&
        permission !== "send_out" &&
        permission !== "computer"),
    output: attributes?.output ?? "text",
  };
}

/** Tools whose success leaves a file on disk; derived from the declared attributes. */
export function writeFileTools(
  attributes: Readonly<Record<string, ToolAttributes>> = KERNEL_TOOL_ATTRIBUTES,
): ReadonlySet<string> {
  return new Set(
    Object.entries(attributes)
      .filter(([, value]) => value.writesFile === true)
      .map(([name]) => name),
  );
}

/** The permission category a registered tool declares, or none. */
export function declaredPermission(
  tool: string,
  attributes: Readonly<Record<string, ToolAttributes>> = KERNEL_TOOL_ATTRIBUTES,
): Category | undefined {
  return attributes[tool]?.permission;
}

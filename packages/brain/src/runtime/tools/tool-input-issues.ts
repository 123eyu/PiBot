import type { z } from "zod";
import { patchIssueMessage } from "./patch-format-message.ts";

const MAX_ISSUES = 5;
const MAX_SEGMENT = 40;

/**
 * Describes why tool arguments failed validation so the model can correct the exact field
 * (sweep 2026-10-28 B2: a bare "invalid arguments" made a researcher give up on a handoff).
 * Only schema facts are rendered — path, code, expected type, bounds, allowed literals and
 * unknown key names. Received values and zod messages are never included: messages can quote
 * the input, and arguments may hold file contents or secrets.
 */
export function describeInputIssues(error: z.ZodError, input?: unknown): string {
  const issues = flattenInputIssues(error.issues).slice(0, MAX_ISSUES);
  if (issues.length === 0) return "";
  const lines = issues.map((issue) => {
    let item = input;
    const index = issue.path.indexOf("acceptance");
    if (index >= 0)
      for (const part of issue.path.slice(0, index + 2)) {
        item =
          item && typeof item === "object"
            ? (item as Record<PropertyKey, unknown>)[part]
            : undefined;
      }
    const check =
      index >= 0 && item && typeof item === "object" && "check" in item ? item.check : undefined;
    const kind =
      typeof check === "string" &&
      [
        "manual",
        "exists",
        "sections",
        "citations",
        "minCitations",
        "sectionsSourced",
        "tableColumns",
        "hasChart",
      ].includes(check)
        ? ` (kind: ${check})`
        : "";
    return `- ${pathText(issue.path)}${kind}: ${issueText(issue)}`;
  });
  const more = error.issues.length > MAX_ISSUES ? `\n- (+${error.issues.length - MAX_ISSUES})` : "";
  return `\n字段问题 / Field issues:\n${lines.join("\n")}${more}`;
}

/** Other validators share the tool boundary's value-free paths and expectations. */
export function inputIssueFacts(issue: z.core.$ZodIssue) {
  return {
    path: issue.path.map((part) => (typeof part === "number" ? part : keyText(String(part)))),
    expected: issue.code === "invalid_type" ? issue.expected : issueText(issue),
  };
}

/** A union failure is most useful as the issues of its closest branch. */
export function flattenInputIssues(issues: readonly z.core.$ZodIssue[]): z.core.$ZodIssue[] {
  return issues.flatMap((issue) => {
    if (issue.code !== "invalid_union" || issue.errors.length === 0) return [issue];
    const closest = issue.errors.reduce((best, branch) =>
      branch.length < best.length ? branch : best,
    );
    return flattenInputIssues(
      closest.map((nested) => ({ ...nested, path: [...issue.path, ...nested.path] })),
    );
  });
}

/** Keys the model invented (record keys, unknown keys) can be user data, so only identifier-like
 * keys are named; anything else shows as `*`. */
const keyText = (key: string) =>
  /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) ? key.slice(0, MAX_SEGMENT) : "*";

function pathText(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "(root)";
  return path
    .map((segment) => (typeof segment === "number" ? `[${segment}]` : keyText(String(segment))))
    .join(".")
    .replace(/\.\[/g, "[");
}

// Fixed corrections for the misplacements real models repeated (`sections` inside an
// acceptance item 5 times; invented `resultMessageId`). Keyed on schema paths only, never values.
const SECTIONS_IN_ACCEPTANCE =
  'sections 属于 deliverables[] 的交付物，不属于 acceptance[]；验收项用 check: "sections" 加 deliverable 指向它 / sections belongs on the deliverables[] item, not acceptance[]; the acceptance item uses check: "sections" plus deliverable. 例 / e.g. deliverables:[{"id":"report","path":"report.md","kind":"md","sections":["Background","Findings"]}], acceptance:[{"id":"has-sections","check":"sections","deliverable":"report"}]';
const RESULT_MESSAGE_ID =
  "resultMessageId 只能是任务负责人已在本群发出的完整回复的 ID；交付本轮回复请省略它 / resultMessageId must be the ID of a completed reply the task owner already posted in this group; omit it to deliver this turn's reply";

function fieldHint(issue: z.core.$ZodIssue): string | undefined {
  const { path } = issue;
  if (
    issue.code === "unrecognized_keys" &&
    issue.keys.includes("sections") &&
    typeof path.at(-1) === "number" &&
    path.at(-2) === "acceptance"
  )
    return SECTIONS_IN_ACCEPTANCE;
  if (path.length === 1 && path[0] === "resultMessageId") return RESULT_MESSAGE_ID;
  return undefined;
}

function issueText(issue: z.core.$ZodIssue): string {
  const base = baseIssueText(issue);
  const hint = fieldHint(issue);
  return hint ? `${base}; ${hint}` : base;
}

function baseIssueText(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return `invalid_type, expected ${issue.expected}`;
    case "too_small":
      return `too_small, minimum ${String(issue.minimum)}${issue.origin ? ` (${issue.origin})` : ""}`;
    case "too_big":
      return `too_big, maximum ${String(issue.maximum)}${issue.origin ? ` (${issue.origin})` : ""}`;
    case "invalid_format":
      return `invalid_format, expected ${issue.format}`;
    case "invalid_value":
      return `invalid_value, expected one of ${issue.values
        .slice(0, 8)
        .map((value) => (typeof value === "string" ? JSON.stringify(value) : String(value)))
        .join("|")}`;
    case "unrecognized_keys":
      return `unrecognized_keys ${issue.keys.slice(0, 5).map(keyText).join(", ")}; remove them`;
    case "custom": {
      // Only these schema-authored codes have public wording; other custom messages may contain data.
      const expected: Record<string, string> = {
        todo_pause_question_reason:
          'question 只用于 reason: "needs_user"。到达检查点、受阻、交审或等待子任务时删除 question，保留实际 reason 和 summary；确有新的用户决定时调用 ask_user，不要为了通过校验捏造问题 / question is only valid with reason: "needs_user". For checkpoint, blocked, review or waiting_tasks, omit question and keep the real reason and summary. Use ask_user only for a genuine new user decision; do not invent one to pass validation',
        "Relative path inside the artifact folder required":
          "路径须相对于产物目录，不能越界；删除绝对路径、.. 和反斜线 / Use a relative path inside the artifact folder; omit absolute paths, .. and backslashes",
        acceptance_manual_text_required:
          "人工项必须提供 text（说明人工核对什么） / A manual check requires text describing what the person must verify",
        acceptance_min_required:
          "minCitations 必须提供 min（整数 1–200） / minCitations requires min (integer 1–200)",
        acceptance_min_forbidden:
          '此检查不接受 min，请删除；若要检查引用数下限，请改为 check: "minCitations", min: 2（按实际下限填写） / Omit min; only minCitations accepts it; for a citation minimum use check: "minCitations", min: 2 (set the intended minimum)',
        acceptance_columns_required:
          "tableColumns 必须提供 columns（1–20 个不重复列名） / tableColumns requires columns (1–20 unique names)",
        "Choose ref or screenshotId/x/y":
          "只用一种方式：要么 ref（来自最新的 browser_snapshot），要么 screenshotId 加 x、y（来自最新的 browser_screenshot），不要同时给 / Use one target: either ref from the latest browser_snapshot, or screenshotId with x and y from the latest browser_screenshot, not both",
        keys_text_and_combo:
          "text 和 combo 只能给一个：text 输入文字，combo 按快捷键；先输入再按键就分两次调用 keys / Give text or combo, not both: text types characters, combo presses a shortcut; to type and then press keys, make two keys calls",
        keys_text_or_combo_required:
          '需要 text（要输入的文字）或 combo（快捷键，如 ["cmd","s"]）其中一个 / Provide exactly one of text (characters to type) or combo (a shortcut, e.g. ["cmd","s"])',
        ui_action_batch_actions_required:
          'action "batch" 需要 actions:[{elementId,action,value?}]（1–10 个） / action "batch" requires actions:[{elementId,action,value?}] (1–10)',
        ui_action_batch_forbids_field:
          'action "batch" 只接受 actions:[{elementId,action,value?}]，删除顶层的这个字段 / action "batch" takes only actions:[{elementId,action,value?}]; remove this top-level field',
        ui_action_single_forbids_actions:
          'actions 只用于 action "batch"；单个操作给 elementId（菜单给 path），删除 actions / actions is only for action "batch"; a single action gives elementId (path for menu), so remove actions',
        ui_action_menu_path_required:
          'action "menu" 需要 path（菜单标题），如 ["Edit","Delete"] / action "menu" requires path (menu titles), e.g. ["Edit","Delete"]',
        ui_action_menu_forbids_field:
          'action "menu" 只用 path，删除这个字段（elementId / value） / action "menu" uses only path; remove this field (elementId / value)',
        ui_action_element_id_required:
          '元素操作需要 ui_tree 里的 elementId；菜单项改用 action "menu" 加 path / Element actions require elementId from ui_tree; for a menu item use action "menu" with path',
        ui_action_element_forbids_path:
          'path 只用于 action "menu"；元素操作只给 elementId，删除 path / path is only for action "menu"; element actions take elementId, so remove path',
        acceptance_columns_forbidden:
          "此检查不接受 columns，请删除；只有 tableColumns 使用 columns / Omit columns; only tableColumns accepts it",
      };
      return Object.hasOwn(expected, issue.message)
        ? (expected[issue.message] as string)
        : (patchIssueMessage(issue.message) ?? "custom");
    }
    default:
      return issue.code;
  }
}

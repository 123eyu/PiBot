import { win32 } from "node:path";
import type { PolicyResult } from "@pibot/policy";
import type { KernelHostParams } from "@pibot/protocol-base";
import type { Redactor } from "@pibot/secrets";

const operations: Record<string, [string, string]> = {
  run_command: ["运行命令", "run a command"],
  web_fetch: ["访问网站", "visit a website"],
  write_file: ["写入文件", "write a file"],
  edit_file: ["修改文件", "edit a file"],
  apply_patch: ["应用文件补丁", "apply a file patch"],
  read_file: ["读取文件", "read a file"],
  reveal_in_folder: ["在文件夹中显示文件", "show a file in its folder"],
  image_result: ["复用已生成图片附件", "reuse generated image attachments"],
  list_dir: ["列出目录", "list a directory"],
  find_files: ["在文件夹里找文件", "find files in a folder"],
  search_text: ["在文件或文件夹里搜索内容", "search a file or folder's contents"],
  // Every operating-the-computer tool asks through the same grant card.
  ...Object.fromEntries(
    ["screenshot", "ui_tree", "ui_action", "pointer", "keys", "open_app", "open_file"].map(
      (tool) => [tool, ["操作你的电脑", "operate your computer"] as [string, string]],
    ),
  ),
};

function shorten(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/u, "")}…`;
}

export function approvalNotification(options: {
  botName?: string;
  tool: string;
  result: PolicyResult;
  language: "zh" | "en";
  redactor: Pick<Redactor, "redact">;
}): Pick<KernelHostParams["host.notify"], "title" | "body"> {
  const { tool, result, language, redactor } = options;
  const zh = language === "zh";
  // Redact before deriving a basename or truncating, then again after removing invisible characters.
  const clean = (text: string) =>
    redactor.redact(
      redactor
        .redact(text)
        .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
        .replace(/\s+/gu, " ")
        .trim(),
    );
  const leaf = (path: string) => win32.basename(clean(path));
  let target = "";
  if (
    [
      "read_file",
      "reveal_in_folder",
      "list_dir",
      "find_files",
      "search_text",
      "write_file",
      "edit_file",
    ].includes(tool)
  ) {
    const kind = tool === "write_file" || tool === "edit_file" ? "write" : "read";
    const path = result.path?.path ?? result.facts.find((fact) => fact.kind === kind)?.value;
    if (path) target = leaf(path);
  } else if (tool === "image_result") {
    target = result.facts
      .filter((fact) => fact.kind === "read")
      .map((fact) => clean(fact.value))
      .join(", ");
  } else if (tool === "web_fetch") {
    const site = result.domain ?? result.url;
    if (site) {
      try {
        const safe = clean(site);
        const url = new URL(result.domain ? `https://${safe}` : safe);
        if (url.protocol === "http:" || url.protocol === "https:") target = url.hostname;
      } catch {
        // A masked or unrecognizable URL has no safe notification target; do not fall back to raw text.
      }
    }
  } else if (tool === "run_command") {
    const programs =
      result.analysis?.programs ??
      result.facts.filter((fact) => fact.kind === "program").map((fact) => fact.value);
    target = [...new Set(programs.slice(0, 3).map(leaf))]
      .filter((program) => /^[\p{L}\p{N}_.+-]+$/u.test(program))
      .map((program) => shorten(clean(program), 32))
      .join(", ");
  }
  const name = shorten(clean(options.botName ?? ""), 64) || "Bot";
  const operation = operations[tool]?.[zh ? 0 : 1] ?? (zh ? "执行操作" : "proceed");
  const title = zh ? `${name} 等待批准：${operation}` : `${name}: approval needed to ${operation}`;
  const summary = shorten(clean(target), 96);
  const body = [
    summary ? (zh ? `目标：${summary}。` : `Target: ${summary}.`) : "",
    result.risk === "danger"
      ? zh
        ? "危险操作，请谨慎确认。"
        : "Dangerous operation; review carefully."
      : "",
    zh ? "点击回到聊天，允许或拒绝。" : "Click to return to chat and allow or deny.",
  ]
    .filter(Boolean)
    .join(" ");
  return { title: shorten(clean(title), 200), body: shorten(clean(body), 2000) };
}

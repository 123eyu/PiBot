import type { PatchFormatProblem } from "@pibot/execution";

/** Says which patch line broke which rule, so the model can fix that line instead of guessing. */
export function patchFormatMessage(problem: PatchFormatProblem, line?: number): string {
  const at = line ? `第 ${line} 行 / line ${line}: ` : "";
  const rules: Record<PatchFormatProblem, string> = {
    envelope:
      "补丁必须以 *** Begin Patch 开头、*** End Patch 结尾 / The patch must start with *** Begin Patch and end with *** End Patch",
    file_header:
      "这里应是 *** Add File: <路径> / *** Update File: <路径> / *** Delete File: <路径> / Expected *** Add File: / *** Update File: / *** Delete File: followed by the path",
    hunk_header:
      "Update File 的每段改动前要有一行 @@（可带说明）/ Each hunk of an Update File section must start with an @@ line",
    line_prefix:
      "改动段里每行必须以空格（不变）、+（新增）或 -（删除）开头 / Each hunk line must start with a space (context), + (added) or - (removed)",
    add_line_prefix:
      "Add File 的每行内容都要以 + 开头 / Every content line of an Add File section must start with +",
    hunk_without_change:
      "这段改动没有 + / - 行，或只有新增却没有任何上下文行；请带上至少一行原文作定位 / This hunk changes nothing, or only adds lines without any context line to anchor it",
    empty_update: "Update File 下没有任何改动段 / The Update File section has no hunks",
    limits:
      "补丁超过大小 / 文件数 / 段数上限或含不允许的字符 / The patch exceeds size, file or hunk limits or contains disallowed characters",
  };
  return `补丁格式错误，没有修改任何文件 / Patch format error; no file was changed. ${at}${rules[problem]}`;
}

/**
 * Input validation rejects a bad patch before execution, where the zod issue renderer only prints
 * wording it knows is free of user data. The schema reports `patch_<problem>@<line>`; this turns
 * that fixed code back into the same message execution gives (a run once saw only "(root):
 * custom").
 */
export function patchIssueMessage(code: string): string | undefined {
  const match = /^patch_([a-z_]+)(?:@(\d{1,7}))?$/.exec(code);
  const problem = match?.[1] as PatchFormatProblem | undefined;
  if (!problem || !PROBLEMS.has(problem)) return undefined;
  return patchFormatMessage(problem, match?.[2] ? Number(match[2]) : undefined);
}
const PROBLEMS = new Set<PatchFormatProblem>([
  "envelope",
  "file_header",
  "hunk_header",
  "line_prefix",
  "add_line_prefix",
  "hunk_without_change",
  "empty_update",
  "limits",
]);

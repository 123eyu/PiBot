import { join } from "node:path";
import { citationFailureHint, deliveryCorrectionText } from "@pibot/brain/orchestration-kit";
import type { DeliveryItem, HandoffSpec } from "@pibot/protocol-base";
import type { HandoffRecord } from "@pibot/storage";

type Language = "zh" | "en";
const LISTED = 15;

/** One acceptance item as the member reads it (the contract's wording when it has one). */
function acceptanceLine(item: HandoffSpec["acceptance"][number], spec: HandoffSpec, zh: boolean) {
  const file = spec.deliverables.find((d) => d.id === item.deliverable);
  const path = file?.path ?? "";
  const what =
    item.check === "exists"
      ? zh
        ? `${path} 存在且非空`
        : `${path} exists and is not empty`
      : item.check === "sections"
        ? zh
          ? `${path} 含小节：${(file?.sections ?? []).join("、")}`
          : `${path} has sections: ${(file?.sections ?? []).join(", ")}`
        : item.check === "citations"
          ? zh
            ? `${path} 的引用编号 [n] 都列在「来源」里`
            : `every [n] in ${path} is listed under Sources`
          : item.check === "minCitations"
            ? zh
              ? `${path} 至少 ${item.min} 条可回溯引用`
              : `${path}: at least ${item.min} resolved citations`
            : item.check === "sectionsSourced"
              ? zh
                ? `${path} 每节有可回溯来源`
                : `${path}: each section has resolved sources`
              : item.check === "tableColumns"
                ? zh
                  ? `${path} 表头含：${item.columns?.join("、")}`
                  : `${path}: table columns ${item.columns?.join(", ")}`
                : item.check === "hasChart"
                  ? zh
                    ? `${path} 含本地图片或内嵌图表`
                    : `${path}: local image or embedded chart`
                  : (item.text ?? (zh ? "人工确认" : "checked by a person"));
  return `${item.id}: ${item.text && item.check !== "manual" ? `${item.text}（${what}）` : what}`;
}

/**
 * Appended to the member's task prompt: what to hand back and how it is judged. Short on
 * purpose: the program checks it, the member does not need to self-review.
 */
export function handoffBrief(spec: HandoffSpec, base: string | null, language: Language) {
  const zh = language === "zh";
  const lines = [zh ? "【交接要求】" : "[Hand-off]"];
  const files = spec.files.map((path) => (base ? join(base, path) : path));
  if (spec.files.length)
    lines.push(
      zh
        ? `- 交付文件（写入以下路径）：${files.join("、")}`
        : `- Files to deliver (write to these paths): ${files.join(", ")}`,
    );
  if (spec.form) lines.push(zh ? `- 形式：${spec.form}` : `- Form: ${spec.form}`);
  if (spec.acceptance.length)
    lines.push(
      zh ? "- 完成条件（程序检查）：" : "- Done when (checked by the program):",
      ...spec.acceptance.map((item) => `  - ${acceptanceLine(item, spec, zh)}`),
    );
  if (
    spec.acceptance.some((item) =>
      ["citations", "minCitations", "sectionsSourced"].includes(item.check),
    )
  )
    lines.push(citationFailureHint("too_few_citations", language).replace(/^[；;]\s*/, ""));
  if (spec.condition)
    lines.push(
      zh ? `- 统筹签收时判断：${spec.condition}` : `- The coordinator judges: ${spec.condition}`,
    );
  if (lines.length === 1) return "";
  lines.push(
    zh
      ? "完成后程序检查文件和完成条件，不需要自己逐项核对；未满足会退回一次。"
      : "When you finish, the program checks the files and conditions; no need to self-review. An unmet result is sent back once.",
  );
  return lines.join("\n");
}

function itemLine(item: DeliveryItem, zh: boolean) {
  const subject = item.id.startsWith("#") ? "" : `${item.id} `;
  const file = item.deliverable ?? "";
  const sep = zh ? "：" : ": ";
  if (item.reason === "wrong_location" && item.location)
    return `- ${subject}${file}${sep}${zh ? "文件位置不对；期望" : "File is in the wrong location; expected"}: ${item.location.expected}; ${zh ? "实际" : "actual"}: ${item.location.actual}`;
  if (item.status === "pass") return `- ${subject}${file}${sep}${zh ? "通过" : "passed"}`;
  if (item.status === "manual")
    return `- ${subject}${file || (item.text ?? "")}${sep}${zh ? "待人工确认" : "needs a person"}`;
  return deliveryCorrectionText([item], undefined, zh ? "zh" : "en");
}

/** The missing items only, for the one send-back (the member already has the full brief). */
export function returnText(record: HandoffRecord, title: string, language: Language) {
  const zh = language === "zh";
  const failed = (record.result?.items ?? []).filter((item) => item.status === "fail");
  return [
    zh
      ? `退回补充「${title}」：程序检查未通过，只退回这一次。`
      : `Sent back “${title}”: the program's check failed; this is the only send-back.`,
    deliveryCorrectionText(failed, undefined, language),
    record.baseFolder
      ? zh
        ? `请在 ${record.baseFolder} 补齐后结束；仍不满足会停下来问用户。`
        : `Fix them in ${record.baseFolder}, then finish; if still unmet the group stops and asks the user.`
      : zh
        ? "请补齐后结束；仍不满足会停下来问用户。"
        : "Fix them, then finish; if still unmet the group stops and asks the user.",
  ].join("\n");
}

export function returnTitle(title: string, language: Language) {
  return (language === "zh" ? `退回补充：${title}` : `Fix: ${title}`).slice(0, 200);
}

/**
 * Added to the coordinator's completion wake: the program's facts about the result (paths,
 * statuses, missing items), never file contents. The member's reply is already in the group.
 */
export function signOffText(record: HandoffRecord, language: Language) {
  const zh = language === "zh";
  const result = record.result;
  if (!result) return "";
  const status = result.userResolved
    ? zh
      ? "用户已手动完成"
      : "completed by the user"
    : result.unavailable
      ? zh
        ? "未能检查，请自己确认"
        : "could not be checked; confirm it yourself"
      : result.items.some((item) => item.status === "manual")
        ? zh
          ? "程序可判的都满足，其余待人工确认"
          : "everything the program can judge is met; the rest needs a person"
        : zh
          ? "满足"
          : "met";
  const lines = [
    zh ? `交接检查（程序判定）：${status}` : `Hand-off check (by the program): ${status}`,
    ...result.items.slice(0, LISTED).map((item) => itemLine(item, zh)),
  ];
  if (result.artifacts.length)
    lines.push(
      zh ? `产物：${result.artifacts.join("、")}` : `Artifacts: ${result.artifacts.join(", ")}`,
    );
  if (record.baseFolder)
    lines.push(zh ? `目录：${record.baseFolder}` : `Folder: ${record.baseFolder}`);
  if (record.returnOf) lines.push(zh ? "（这是退回后的补交）" : "(This is the resubmission.)");
  if (record.spec.condition)
    lines.push(
      zh ? `需由你判断：${record.spec.condition}` : `For you to judge: ${record.spec.condition}`,
    );
  lines.push(
    zh
      ? "满足就签收并安排下一步，不需要重读文件核对已检查的项。"
      : "If met, sign off and arrange the next step; no need to re-read files for items already checked.",
  );
  return lines.join("\n");
}

/** Group notice when the resubmission is still unmet: the run stops and waits for the user. */
export function unmetNotice(record: HandoffRecord, title: string) {
  const failed = (record.result?.items ?? []).filter((item) => item.status === "fail");
  const zh = failed
    .slice(0, LISTED)
    .map((item) => itemLine(item, true).slice(2))
    .join("；");
  const en = failed
    .slice(0, LISTED)
    .map((item) => itemLine(item, false).slice(2))
    .join("; ");
  return `「${title}」退回后仍未满足完成条件：${zh}。已停下，等你决定 / “${title}” is still unmet after being sent back: ${en}. Stopped; waiting for you`;
}

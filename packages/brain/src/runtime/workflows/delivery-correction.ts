import pathApi from "node:path";
import type { DeliveryItem } from "@pibot/protocol-base";

type Language = "zh" | "en";
/** Feedback is a bounded reminder, never a second copy of the contract or source documents. */
export function boundedFeedback<T>(
  items: readonly T[],
  describe: (item: T) => string,
  language: Language,
  limits = { items: 6, chars: 2400, line: 1400 },
): string {
  const lines: string[] = [];
  let length = 0;
  for (const item of items.slice(0, limits.items)) {
    const text = describe(item);
    const line =
      text.length > limits.line
        ? `${text.slice(0, limits.line - 30)}… (${language === "zh" ? "本条已截短" : "item shortened"})`
        : text;
    // Leave room for the omitted count even when the character cap is reached first.
    if (length + line.length + 1 > limits.chars - 80) break;
    lines.push(line);
    length += line.length + 1;
  }
  const omitted = items.length - lines.length;
  if (omitted)
    lines.push(language === "zh" ? `还有 ${omitted} 条未列出` : `${omitted} more items not listed`);
  return lines.join("\n");
}

/** Fixed examples only; a failed citation check must never echo source text or URLs. */
export function citationFailureHint(reason: DeliveryItem["reason"], language: Language): string {
  if (
    reason !== "no_sources" &&
    reason !== "unresolved_citations" &&
    reason !== "too_few_citations" &&
    reason !== "section_unsourced"
  )
    return "";
  if (reason === "no_sources") return "";
  return language === "zh"
    ? "；格式示例：正文引用 [1]，来源节写 [1]: `source.md`；示例文件须替换为本次实际来源"
    : "; Format example: cite [1] in the body; under Sources write [1]: `source.md`; replace the example file with an actual source from this run";
}
/** Each unresolved label gets a stable reason and a syntax example without echoing its definition. */
export function citationIssueText(
  item: Pick<DeliveryItem, "referenceIssues" | "reason" | "status" | "citationContext">,
  language: Language,
) {
  if (
    item.status !== "fail" ||
    item.reason === "no_sources" ||
    item.citationContext?.section === null ||
    !citationFailureHint(item.reason, language)
  )
    return "";
  const zh = language === "zh";
  const reasons = zh
    ? {
        missing_file: "文件不存在或无法安全读取",
        not_read:
          "未匹配本轮已抓取 URL 或合法文件来源；本步新写快照即使再读也不算来源，请引用原抓取 URL",
        invalid_format: "这条来源的路径认不出，请把路径放进反引号",
      }
    : {
        missing_file: "file missing or not safely readable",
        not_read:
          "not a URL fetched this run or eligible file; rereading this step's new snapshot does not qualify it; cite the fetched URL",
        invalid_format: "unrecognized source path; put the path in backticks",
      };
  return boundedFeedback(
    item.referenceIssues ?? [],
    (issue) => {
      const label = /^\[\d+\]$/.test(issue.label) ? issue.label : "[1]";
      return `${issue.label}: ${reasons[issue.reason]}; ${zh ? "来源写法" : "Source syntax"}: ${label}: \`source.md\` ${zh ? "或" : "or"} ${label}: \`https://example.test/source\` (${zh ? "替换为本轮实际来源，不要改变来源含义" : "use the actual source; keep its meaning"})`;
    },
    language,
    { items: 4, chars: 1100, line: 340 },
  );
}

function citationContextText(item: DeliveryItem, language: Language) {
  if (item.reason !== "no_sources" && !citationFailureHint(item.reason, language)) return "";
  const zh = language === "zh";
  const context = item.citationContext;
  const selection = context
    ? context.section
      ? zh
        ? `识别的来源节：${context.section === "contract" ? "合同规定的来源节" : context.section === "subheading" ? "来源列表子标题" : context.section}（第 ${context.line ?? "?"} 行）`
        : `Selected Sources section: ${context.section === "contract" ? "contract section" : context.section === "subheading" ? "bibliography subheading" : context.section} (line ${context.line ?? "?"})`
      : zh
        ? "未识别到来源节"
        : "No Sources section recognized"
    : "";
  const names = zh
    ? { document: "报告所在目录", artifact: "本步骤产物目录", workspace: "工作根" }
    : {
        document: "report directory",
        artifact: "step artifact directory",
        workspace: "workspace root",
      };
  const bases = context?.bases.map((base) => names[base]).join(zh ? "、" : ", ");
  return [
    selection,
    zh
      ? "来源标题可使用来源 / 参考文献 / Sources / References、合同规定的来源节名或其来源列表子标题；不要使用「数据来源说明」等正文说明标题；多节时取最后一节"
      : "Use Sources / References, the contract bibliography title, or its source-list subheading; explanatory titles such as data source methodology are not bibliographies; the last matching section is selected",
    bases
      ? zh
        ? `相对引用按${bases}解析；解析目录不授予来源资格，仍须本轮已读文件或合法输入 / 上游来源`
        : `Relative references resolve against: ${bases}; aliases do not grant source eligibility; use files read this run or eligible inputs / upstream sources`
      : "",
  ]
    .filter(Boolean)
    .join("; ");
}

/** Only failed checks get instructions; never serialize DeliveryItem or source definitions. */
export function deliveryCorrectionText(
  items: readonly DeliveryItem[],
  folder: string | undefined,
  language: Language,
) {
  const windows = folder && (/^[A-Za-z]:/.test(folder) || folder.startsWith("\\\\"));
  const join = windows ? pathApi.win32.join : pathApi.join;
  const zh = language === "zh";
  return boundedFeedback(
    items.filter((item) => item.status === "fail"),
    (item) => {
      const subject = item.id.startsWith("#") ? "" : `${item.id} `;
      const path = item.deliverable
        ? folder
          ? join(folder, ...item.deliverable.split("/"))
          : item.deliverable
        : (folder ?? "");
      if (item.reason === "wrong_location" && item.location)
        return `- ${subject}${path}: ${zh ? "文件位置不对；期望" : "File is in the wrong location; expected"}: ${item.location.expected}; ${zh ? "实际" : "actual"}: ${item.location.actual}`;
      const missing = boundedFeedback(item.missing, (value) => value, language, {
        items: 6,
        chars: 350,
        line: 100,
      });
      const extra = {
        verdict_missing: zh
          ? "报告缺结论行；请写「结论：通过」或「结论：不通过」，不通过项逐条列在结论之后"
          : "Report needs Verdict: PASS or Verdict: FAIL; list failures below the verdict",
        invalid_output_name: zh
          ? "请按主题_类型_YYYY-MM-DD 命名，日期须完整且有效；保存目录优先遵循用户指定，未指定时使用 .pibot/out/<主题>/"
          : "Use topic_type_YYYY-MM-DD with a full valid date; keep the user-specified save directory, or default to .pibot/out/<topic>/",
        invalid_citation_format: zh
          ? "学术 / 申报材料请在参考文献节逐条列出 [编号]、GB/T 7714 类型标识（如 [J] / [EB/OL]）、年份与真实来源链接或 DOI；不得编造来源"
          : "In References, include each [number], GB/T 7714 type (e.g. [J] / [EB/OL]), year and actual source URL or DOI; never invent a source",
        too_few_citations: zh ? "可回溯引用数不足" : "too few resolved citations",
        section_unsourced: zh
          ? `小节缺可回溯引用：${missing}`
          : `sections without resolved citations: ${missing}`,
        missing_columns: zh ? `缺表格列：${missing}` : `missing table columns: ${missing}`,
        no_chart: zh ? "缺本地图片或内嵌图表" : "no local image or embedded chart",
      };
      const headingMissing = item.reason === "no_sources" || item.citationContext?.section === null;
      const what = headingMissing
        ? zh
          ? "未识别到来源节，请核对标题"
          : "No Sources section recognized; check the heading"
        : item.reason && item.reason in extra
          ? extra[item.reason as keyof typeof extra]
          : item.reason === "missing_file"
            ? zh
              ? "文件不存在"
              : "file does not exist"
            : item.reason === "empty_file"
              ? zh
                ? "文件是空的"
                : "file is empty"
              : item.reason === "missing_sections"
                ? zh
                  ? `缺小节：${missing}`
                  : `missing sections: ${missing}`
                : item.reason === "no_sources"
                  ? zh
                    ? "没有「来源」小节"
                    : "no Sources section"
                  : item.reason === "unresolved_citations"
                    ? zh
                      ? `引用编号不在「来源」里：${missing}`
                      : `citations not listed under Sources: ${missing}`
                    : zh
                      ? "未通过"
                      : "failed";
      const issues = citationIssueText(item, language);
      return [
        `- ${subject}${path}: ${what}${issues || headingMissing ? "" : citationFailureHint(item.reason, language)}`,
        issues,
        citationContextText(item, language),
      ]
        .filter(Boolean)
        .join("\n");
    },
    language,
  );
}

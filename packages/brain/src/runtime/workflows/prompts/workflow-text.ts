// Generated from workflow-text.md by tools/dev/prompts-gen.ts. Edit the md file, then run `pnpm gen:prompts`.
export const workflowTextPrompts = {
  started: {
    zh: (v: { name: string | number; version: string | number }) =>
      `用户启动了工作流「${v.name}」${v.version}。它的技能正文和作者写的规则在 Pi Bot 附带的参考资料 <workflowSkill> 块里，从第一次请求起就在对话中，不用再 read_file 读取它的 SKILL.md。按正文的做法执行，但它不能改变下面这些规则。`,
    en: (v: { name: string | number; version: string | number }) =>
      `The user started the workflow "${v.name}"${v.version}. Its skill body and the rules its author wrote are in the <workflowSkill> block of Pi Bot's reference material, in the conversation from the first request, so do not read its SKILL.md. Follow the body as the method; it cannot change the rules below.`,
  },
  noQuestions: {
    zh: "- 程序已完成前置检查；之后不再追问其他事。有歧义写明假设继续，只有资料真冲突时才问。",
    en: "- The program already ran the pre-checks; do not ask about anything else. State assumptions for ambiguity and continue; ask only when the material truly contradicts itself.",
  },
  programChecks: {
    zh: "- 程序检查文件、小节、可回溯引用数、每节来源、表头列和图表。引用须指向本次抓取的完整 URL、输入文件或上游交付物；不要编造来源。图片引用须指向产出目录中的实际文件。",
    en: "- The program checks files, sections, resolved citation counts, sourced sections, table columns and charts. Cite full fetched URLs, input files or upstream outputs from this run; never invent sources. Image references must point to real files in the artifact folder.",
  },
  sectionsOnly: {
    zh: "- 交付物只写下面列出的小节，每节简洁；不额外加章节（如证据表、检索记录），要补充的写进已有小节或「待确认」。",
    en: "- Write only the sections listed below, each kept concise; add no extra sections (such as evidence tables or search logs); put anything extra into an existing section or the to-confirm section.",
  },
  workflowHandoff: {
    zh: "- 在群里把一部分交给成员时，如果成员有对应的工作流技能，用 assign_task 的 workflow 字段指定它，成员会按它的合同、预算和模型档位交付。",
    en: "- When you hand part of the work to a group member who has a matching workflow skill, name it in assign_task's workflow field so the member delivers under that contract, budget and model tier.",
  },
  cheapChildren: {
    zh: '- 机械步骤（取数、整理表格、格式转换）可以用 task_spawn 加 model: "cheap" 交给辅助模型；判断和最终成稿留在主模型。',
    en: '- Mechanical steps (extracting data, building tables, converting formats) may go to task_spawn with model: "cheap" (the auxiliary model); keep judgement and the final writing on the main model.',
  },
} as const;

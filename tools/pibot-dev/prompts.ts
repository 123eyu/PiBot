import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The plan section `### <TASK> …` up to the next `### ` heading, verbatim. */
export function planSection(repo: string, milestone: string, task: string) {
  const text = readFileSync(join(repo, "docs", "plans", `${milestone}-plan.md`), "utf8");
  const start = text
    .split("\n")
    .findIndex((line) => line.startsWith(`### ${task} `) || line === `### ${task}`);
  if (start < 0)
    throw new Error(`plan section ### ${task} not found in docs/plans/${milestone}-plan.md`);
  const lines = text.split("\n");
  const end = lines.findIndex((line, index) => index > start && /^#{2,3} /.test(line));
  return lines
    .slice(start, end < 0 ? undefined : end)
    .join("\n")
    .trim();
}

const RULES = `规则（Pi Bot 自我迭代工作流；违反会被审查退回）：
- 当前目录是这个任务独立的 git worktree。只改这里，不碰别的目录；不提交、不 merge/rebase/push，不写 git 元数据——审查和合并由 Claude 做。
- AGENTS.md（公开贡献指南）已由 Pi Bot 作为项目说明放进上下文（CLAUDE.md 是它的副本），不要再读这两个；先完整读一遍 AGENTS.internal.md（私有开发仓库的内部规则，优先于 AGENTS.md）。先读规格里与这一节相关的部分；docs/PROGRESS.md 有三千多行，只用 search_text 找这个里程碑的小节读。docs/CODEMAP.md 同样按包名 search_text，不整篇读。只读要改的文件和它们直接相关的代码，不通读整个仓库。要读的几个文件在同一轮里一起调用 read_file（并行），不要一轮读一个；每一轮模型请求约 8 秒，轮数是最大的耗时。
- 读文件用 read_file（可带 offset/limit），搜文本用 search_text / find_files，不要用 run_command 跑 cat / sed -n / head / tail / grep / ls / wc：它们每次都要起一次命令沙箱，比这两个工具慢得多。
- 遵守 AGENTS.md 的硬性约束与工程实践：中英文一起加、颜色走主题 token、工具都经 policy、命令只经 execution、不写新单元测试、注释写为什么。
- 已有测试里两处要跟着改（「不写新测试」不包括它们，漏了会在 verify 失败）：新增 RPC 方法或事件 → \`packages/protocol/test/schemas.test.ts\`（或它引入的 \`test/fixtures/*.ts\`）补一条用例；新增迁移 → \`packages/storage/test/store.test.ts\` 的表清单和迁移数。
- 收尾：跑一次 \`pnpm check:changed\` 并修到通过（机器忙时它可能超过 10 分钟：放到后台就用 \`background_command\` 的 \`until: "end"\` 等它结束、读结果，**不要在它还没出结果时结束这一轮**）（中途用定向 typecheck）；它已覆盖改动包的 typecheck / lint / 测试，不要再跑全量 \`pnpm typecheck\` / \`lint\` / \`test\`；不要调用 \`check_command_propose\`：工作流会在沙箱外统一跑 verify，这个 worktree 的自动检查只会重复、每轮多花几分钟。写 docs/progress-notes/<任务号>.md（做了什么、怎么验证、和规格的差异、需要人决定的事）。
- \`search_text\` / \`find_files\` 一定带 \`path\`（某个包或目录，如 \`packages/orchestration/src\`）或 \`include\`：对整个仓库搜索要读五千多个文件，机器忙时超过 20 秒会整次失败（修复前）。
- 不要调用 \`ask_user\`：这个话题里没人回答选择卡（曾有任务提问后轮询 todo_list 被重复操作保护停掉）。缺决定时按计划写的默认做；计划没写就选你的推荐项，写进任务笔记「需要人决定的事」，由 Claude 审查时确认。
- 在仓库里跑临时 TS 脚本用 \`node --import ./tools/dev/ts-hooks.mjs <文件>\`（直接 \`node x.ts\` 会因为包里的参数属性等语法失败）。
- 临时脚本和临时文件一律放当前 worktree 的 \`.cache/\`（已被 git 忽略、写它不用确认），用完删掉；不要写 /tmp、\`$TMPDIR\` 或工作位置之外的任何地方——\`$TMPDIR\` 只在 run_command 的沙箱里可写，用写文件工具写它仍要确认；工作位置外的写入即使 YOLO 也会出确认卡，没人值守时整轮会挂在那里等审批。
- 不要跑 pnpm verify、acceptance、打包或启动 Electron 窗口：这些由工作流在沙箱外统一跑，结果会发给你。
- 被沙箱拦截时按提示处理；不要让用户自己去终端运行命令。需要人决定的产品问题不要自己拍板成定论：按上面 ask_user 那条写进任务笔记。
- 最后用中文简报：改了什么、实际验证了什么、还缺什么。`;

export function taskPrompt(input: {
  milestone: string;
  task: string;
  section: string;
  extra?: string;
  group?: string;
  /** Continuing the milestone's topic after this earlier task (merged into main by now). */
  after?: { task: string; worktree: string };
}) {
  return [
    `任务 ${input.task}（里程碑 ${input.milestone}）。规格：docs/specs/${input.milestone}-*.md；计划：docs/plans/${input.milestone}-plan.md。`,
    ...(input.after
      ? [
          `这是同一个里程碑的下一个任务，接着这个话题做。上一个任务 ${input.after.task} 已经合入 main；工作区已换成新的 worktree：${input.after.worktree}（当前目录），它基于最新的 main。之前读过的 AGENTS.md、规格和代码结构不用再读；但文件内容以这个 worktree 为准，改哪个文件前先读当前版本，不要沿用上一个 worktree 的路径。`,
        ]
      : []),
    ...(input.group
      ? [
          "本任务由已明确选择的群协作完成。沿群统筹、计划确认、成员派工与最终交付核对执行；不要把统筹首次回复当作完成，不改变成员模型、全局目录或权限。",
        ]
      : []),
    RULES,
    "这一节方案：",
    input.section,
    ...(input.extra ? ["补充：", input.extra] : []),
  ].join("\n\n");
}

export function followUpPrompt(kind: "fix" | "test" | "check", body: string) {
  // Each kind is the same shape: what the workflow saw, then the full rules again (the topic may
  // have been trimmed). "check" is a rerun of the Bot's own check:changed on work it edited after
  // its last passing run, so it points at the code rather than at verify.
  const head = HEADS[kind];
  return `${head}\n\n${body}\n\n${RULES}`;
}

const HEADS = {
  fix: "审查结果：下面是必须修改的问题。逐条修好（不同意的写明理由），修完再跑一次 pnpm check:changed，更新任务笔记，然后简报。",
  test: "工作流在沙箱外跑了完整检查，下面是失败的阶段和报错首尾摘要。找到原因并修好（只修任务相关的问题；如果判断是工作流或环境本身的问题，直接说明，不要绕过），再跑 pnpm check:changed，然后简报。",
  check:
    "你的最后一轮之后又改过代码，工作流重跑了 pnpm check:changed（不是审查意见），下面是失败的阶段和报错首尾摘要。按它修好，再跑一次 pnpm check:changed 并让它通过，更新任务笔记，然后简报。",
} as const;

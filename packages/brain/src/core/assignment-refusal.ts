import { RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import { GroupToolError } from "./collaboration-tool-error.ts";

const reasons = {
  assignment_member_unavailable:
    "没有这个成员或名称不唯一，请用当前群成员的 UUID / Member missing or ambiguous; use a current group member UUID",
  assignment_member_archived:
    "成员已归档，请选择当前群的有效成员 / Member archived; choose an active group member",
  assignment_coordinator_required:
    "只有群主话题里的统筹可以分派，请完成自己的部分 / Only the coordinator in the main group conversation may assign; finish your own part",
  assignment_cycle_stale:
    "这轮请求已失效，请停止旧分派，按当前用户请求继续 / This cycle is stale; stop the old assignment and follow the current request",
  assignment_cycle:
    "不能分派给自己或调用链上的成员，请选其他成员 / Cannot assign to yourself or an ancestor; choose another member",
  assignment_depth:
    "协作深度已达上限，请汇总已有结果，不再分派 / Collaboration depth limit reached; summarize existing results without assigning more work",
  assignment_attachment_scope:
    "附件不属于当前会话，请使用本会话提供的附件 / Attachment is outside this conversation; use attachments supplied here",
  assignment_attachment_invalid:
    "附件无效或格式不支持，请选择当前会话中可读取的附件 / Attachment invalid or unsupported; select a readable attachment from this conversation",
  assignment_attachment_conversion:
    "附件转换失败或当前主机不支持，请换成可读取的文件再分派 / Attachment conversion failed or is unavailable on this host; use a readable file before assigning",
  assignment_attachment_too_large:
    "附件过大，请拆分或减小文件后再分派 / Attachment too large; split or reduce the file before assigning",
  assignment_no_model:
    "负责人没有可用模型，请先配置模型后再分派 / The owner has no available model; configure one before assigning",
  assignment_busy:
    "运行队列已满或工作位置正在切换，请等待当前工作结束后再分派 / The queue is full or the workplace is changing; wait for current work before assigning",
  assignment_already_addressed:
    "用户已分别请成员回答，请只完成自己的部分，不要重复分派 / Members are already answering the user's request; finish only your part without reassigning",
  assignment_plan_controls_dispatch:
    "计划已交给程序或等待确认，请等待计划执行，不要另行分派 / The plan belongs to the engine or awaits confirmation; wait for it without assigning independently",
  assignment_duplicate:
    "这个成员已有未完成的同名任务，请用 ask_bot 提醒，不要重复创建 / This member has an open task with this title; use ask_bot instead of creating it again",
  handoff_serial_required:
    "带工作流的派工必须用 executionMode: serial：签收会马上读真实的期次文件夹 / A workflow hand-off requires executionMode: serial; its sign-off reads the real period folder right away",
  handoff_workflow_required:
    "doneWhen.acceptance 需要同时指定 workflow，且只能引用它的验收项 / doneWhen.acceptance requires workflow and must reference its acceptance items",
  handoff_method_unavailable:
    "负责人没有这个已启用的合同技能，请选择其可用技能或移除 workflow / The owner has no matching enabled contract skill; select an available skill or omit workflow",
  handoff_contract_invalid:
    "方法的工作合同无效，请修复技能合同或移除 workflow / The method contract is invalid; repair the skill contract or omit workflow",
  handoff_arguments_invalid:
    "工作流输入或参数不匹配，请按负责人的技能声明提供 workflow.inputs / workflow.params / Workflow inputs or parameters do not match; follow the owner's skill declaration for workflow.inputs / workflow.params",
  handoff_precheck_failed:
    "工作流前置检查未通过，成员尚未启动；请提供所需输入及存在的文件，缺资料时问用户 / Workflow pre-checks failed; no member started. Supply required inputs and existing files; ask the user for missing material",
  handoff_acceptance_unavailable:
    "doneWhen.acceptance 含合同里没有的验收项，请按技能合同修正或省略它以使用全部自动验收 / doneWhen.acceptance names unknown checks; correct it from the skill contract or omit it to use all automatic checks",
  assignment_scope_invalid:
    "当前群、话题或协作身份不可用，请停止旧分派并核对当前群成员 / Group, conversation or collaboration identity unavailable; stop the old assignment and check current membership",
  assignment_refused:
    "分派结果未确认，请核对当前群成员、已有任务和交接合同，不要重复提交相同请求 / Assignment outcome unconfirmed; check current membership, existing tasks and the hand-off contract before repeating the request",
} as const;

// Group / identity guards shared by every collaboration tool.
const SCOPE_MESSAGES = [
  "Group tool unavailable",
  "Wrong collaboration identity",
  "Unknown group",
  "group_topic_archived",
  "Group contains archived Bot; update members first",
  "Bot is not a member",
  "Wrong group conversation",
];

// Legacy guards use fixed English messages. Match exact strings, never expose an exception's text.
const aliases = new Map<string, keyof typeof reasons>([
  ["Unknown or ambiguous member; use UUID", "assignment_member_unavailable"],
  ["Archived member", "assignment_member_archived"],
  ["Only group coordinator assigns", "assignment_coordinator_required"],
  ["Old user cycle", "assignment_cycle_stale"],
  ["Self request or cyclic collaboration", "assignment_cycle"],
  ["Collaboration depth limit", "assignment_depth"],
  ["Attachment is outside source conversation", "assignment_attachment_scope"],
  [
    "用户已分别请各位回答。只回答自己的部分，不要重复分派或提醒 / Members are already answering the user's request. Answer only your part; do not reassign or remind them.",
    "assignment_already_addressed",
  ],
  [
    "group_plan_controls_dispatch：计划交给程序执行或等待用户；不要另行分派 / Plan dispatch belongs to the engine or is waiting for the user; do not assign independently.",
    "assignment_plan_controls_dispatch",
  ],
  ...SCOPE_MESSAGES.map((message): [string, keyof typeof reasons] => [
    message,
    "assignment_scope_invalid",
  ]),
]);

const typedReasons = new Map<string, { rpcCode: number; reason: keyof typeof reasons }>([
  ["no_model", { rpcCode: RpcErrorCodes.noModel, reason: "assignment_no_model" }],
  [
    "attachment_invalid",
    { rpcCode: RpcErrorCodes.attachmentInvalid, reason: "assignment_attachment_invalid" },
  ],
  [
    "attachment_too_large",
    { rpcCode: RpcErrorCodes.attachmentInvalid, reason: "assignment_attachment_too_large" },
  ],
  ...["attachment_conversion", "attachment_host_unavailable"].map(
    (message) =>
      [
        message,
        {
          rpcCode: RpcErrorCodes.attachmentConversion,
          reason: "assignment_attachment_conversion" as const,
        },
      ] as const,
  ),
  [
    "image_host_unavailable",
    { rpcCode: RpcErrorCodes.unsupported, reason: "assignment_attachment_conversion" },
  ],
  ...["Run queue full", "Bot queue full", "Bot workspace changing", "topic_workplace_busy"].map(
    (message) =>
      [message, { rpcCode: RpcErrorCodes.busy, reason: "assignment_busy" as const }] as const,
  ),
]);

// Members sent `integrate: true` or an invented `resultMessageId`, were told only
// "identity unavailable" / "check the path", and ended their turn. Each text names the field and
// the corrected call; none repeats the model's values.
const finishReasons = {
  finish_integrate_coordinator_only:
    "integrate 只供统筹合入并行工作区；成员请删掉 integrate，只带 summary（和 taskId）再调用一次 finish_task / integrate is only for the coordinator merging parallel worktrees; members remove integrate and call finish_task again with summary (and taskId)",
  finish_integrate_task_required:
    "integrate: true 必须同时给出要合入的 taskId / integrate: true requires the taskId of the task to integrate",
  finish_result_message_invalid:
    "resultMessageId 只能是任务负责人已在本群发出的完整回复；交付本轮回复请省略 resultMessageId，再调用一次 finish_task / resultMessageId must be a completed reply the task owner already posted in this group; to deliver this turn's reply, omit resultMessageId and call finish_task again",
  finish_cancel_coordinator_only:
    "status: cancelled 只供统筹使用；成员请省略 status（默认 done）再调用一次 finish_task，做不完就在回复里说明原因 / status: cancelled is coordinator-only; members omit status (defaults to done) and call finish_task again, explaining in the reply if the work is incomplete",
  finish_task_unknown:
    "taskId 不是本群的任务；请用分派给你的 taskId，或在你只有一个未完成任务时省略 taskId / taskId is not a task in this group; use the taskId you were assigned, or omit taskId when you have exactly one open task",
  finish_task_not_owned:
    "taskId 必须是分派给你的任务，只有统筹能结束别人的任务；请改用自己的 taskId，或在只有一个未完成任务时省略 / taskId must be a task assigned to you; only the coordinator settles others' tasks. Use your own taskId, or omit it when you have exactly one open task",
  finish_no_open_task:
    "你在本群没有未完成的任务，不需要调用 finish_task；直接用回复结束本轮 / You have no open task in this group; finish_task is not needed, end the turn with your reply",
  finish_scope_invalid:
    "当前群、话题或运行身份已不可用，任务未结束；请结束本轮，不要重试 / The group, conversation or run identity is no longer available and the task was not settled; end this turn without retrying",
  finish_task_busy:
    "该任务正在结算或停止，请结束本轮，不要立即重试 / This task is being settled or stopped; end this turn and do not retry immediately",
} as const;

// Exact guard texts only. Unlisted GroupToolErrors (e.g. the open-task title list the model needs)
// keep their own authored wording through the callers' existing paths.
const finishAliases = new Map<string, keyof typeof finishReasons>([
  ["Only group coordinator integrates task workspaces", "finish_integrate_coordinator_only"],
  ["Integration requires taskId", "finish_integrate_task_required"],
  [
    "请选择该成员已在本群发出的回复 / Select a reply delivered by this member in this group.",
    "finish_result_message_invalid",
  ],
  [
    "只有本群统筹可以取消任务 / Only this group's coordinator may cancel a task.",
    "finish_cancel_coordinator_only",
  ],
  ["这个群里没有该任务 / The task is not in this group.", "finish_task_unknown"],
  [
    "只能完成分派给你自己的任务 / You may only finish tasks assigned to you.",
    "finish_task_not_owned",
  ],
  ["你在这个群没有未完成的任务 / You have no open task in this group.", "finish_no_open_task"],
  ["No open task / 没有未完成任务", "finish_no_open_task"],
  ...[...SCOPE_MESSAGES, "Wrong task completion identity"].map(
    (message): [string, keyof typeof finishReasons] => [message, "finish_scope_invalid"],
  ),
]);

function finishTaskRefusal(error: unknown): string | undefined {
  if (!(error instanceof RpcError)) return undefined;
  if (error.code === RpcErrorCodes.busy && error.message === "Task busy")
    return `finish_task_busy: ${finishReasons.finish_task_busy}`;
  if (error.code !== RpcErrorCodes.invalidParams) return undefined;
  const code = finishAliases.get(error.message);
  return code ? `${code}: ${finishReasons[code]}` : undefined;
}

/** The fixed refusal text for a collaboration tool, or undefined to keep the caller's own path. */
export function collaborationRefusal(tool: string, error: unknown): string | undefined {
  if (tool === "assign_task") return assignmentRefusal(error);
  if (tool === "finish_task") return finishTaskRefusal(error);
  return undefined;
}

/** Only expected assignment refusals become actionable guidance; bugs keep the generic error path. */
export function assignmentRefusal(error: unknown): string | undefined {
  if (!(error instanceof RpcError)) return undefined;
  const typed = typedReasons.get(error.message);
  if (typed?.rpcCode === error.code) return `${typed.reason}: ${reasons[typed.reason]}`;
  if (!(error instanceof GroupToolError) && error.code !== RpcErrorCodes.invalidParams)
    return undefined;
  const code = Object.hasOwn(reasons, error.message)
    ? (error.message as keyof typeof reasons)
    : (aliases.get(error.message) ?? "assignment_refused");
  return `${code}: ${reasons[code]}`;
}

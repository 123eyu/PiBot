import type { LocalToolResult } from "@pibot/agent";
import type { ComputerInput, ComputerRunContext } from "@pibot/brain/kit";
import type { ComputerExecutionRun } from "../../context.ts";

export const COMPUTER_FAILURE_LIMIT = 6;
const READ_LIMIT_AFTER_FAILURE = 12;
const ACTIONS = new Set(["ui_action", "pointer", "keys"]);

/** Successful observations are not successful actions and must not erase a blocked step. */
export function computerProgress(context: ComputerRunContext) {
  context.computerProgress ??= { reads: 0, readsAfterFailure: 0, failures: 0 };
  return context.computerProgress;
}

export function recordComputerProgress(
  context: ComputerRunContext,
  input: ComputerInput,
  result: LocalToolResult,
  failed = !!result.isError,
) {
  const state = computerProgress(context);
  if (state.stopped) return;
  if (!result.isError && ACTIONS.has(input.tool)) {
    state.reads = 0;
    state.readsAfterFailure = 0;
    state.failures = 0;
    state.lastTool = undefined;
    return;
  }
  if (input.tool === "ui_tree") {
    state.reads = Math.min(READ_LIMIT_AFTER_FAILURE, state.reads + 1);
    // Prior observations must not consume the first failure's opportunity to recover.
    if (state.failures > 0)
      state.readsAfterFailure = Math.min(READ_LIMIT_AFTER_FAILURE, state.readsAfterFailure + 1);
  } else state.reads = 0;
  if (failed) {
    state.failures++;
    state.lastTool = input.tool;
  }
  state.stopped =
    state.failures >= COMPUTER_FAILURE_LIMIT || state.readsAfterFailure >= READ_LIMIT_AFTER_FAILURE;
}

export function computerStoppedText(context: ComputerRunContext) {
  const tool = computerProgress(context).lastTool ?? "ui_tree";
  return `操作电脑没有取得进展，已停止；卡在 ${tool}。请告诉用户最近的失败原因，确认窗口与输入焦点后再继续；不要再调用电脑工具 / Computer operation stopped without progress at ${tool}. Tell the user the latest failure and check the window and input focus before continuing; do not call computer tools again.`;
}

export function finishComputerProgress(
  run: ComputerExecutionRun,
  input: ComputerInput,
  result: LocalToolResult,
  failed = !!result.isError,
): LocalToolResult {
  const { local, context } = run;
  recordComputerProgress(context, input, result, failed);
  if (!computerProgress(context).stopped) return result;
  local.approvals.audit.append({
    botId: context.botId,
    runId: context.runId,
    kind: "execution.todo.paused",
    summary: "Computer operation stalled / 操作电脑无进展",
    detail: { reasonCode: "computer_stalled", toolName: input.tool },
  });
  return { ...result, isError: true, text: `${result.text}\n${computerStoppedText(context)}` };
}

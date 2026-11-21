import { ExecError, type ExecutionTarget } from "@pibot/execution";
import { RpcError, RpcErrorCodes } from "@pibot/protocol-base";

/**
 * Tools whose every call goes through exactly one target operation. A tool that only sometimes
 * touches an operation (send_file reading binaries, edit_file with multiple edits) stays offered
 * and reports the failure per call.
 */
const toolOperations: Readonly<Record<string, keyof ExecutionTarget>> = {
  list_dir: "listDir",
  find_files: "findFiles",
  search_text: "searchText",
  apply_patch: "applyPatch",
  background_command: "startBackground",
  write_stdin: "writeBackground",
};

/** False when the target declares the tool's only operation permanently unsupported. */
export function targetSupportsTool(target: ExecutionTarget, tool: string): boolean {
  const operation = toolOperations[tool];
  return !operation || !target.unsupportedOperations?.has(operation);
}

/**
 * Tools a runner workplace must not offer, decided from the runner target's own implementation
 * (packages/runner/src/remote-target.ts), not from another target's capability list.
 *
 * A runner target cannot be resolved before the first call — it may be offline — so the catalog
 * is filtered by workplace location instead. The list is fixed for the whole session, which keeps
 * the tool catalog stable for prompt caching.
 *
 * Offered on purpose, because the target serves them: list_dir/read_file/write_file/edit_file
 * (remote-target.ts fileCall), office_* (BinaryToolRun → readBinary/writeBinary), image_result
 * (reads the managed cache under Pi Bot's data dir), check_command_propose (only adds a card).
 * Tools that never touch the workplace (web_fetch, web_search, memory, todo, ask_user, ...) stay
 * offered as well: they run on the desktop brain even when the folder lives on a runner.
 */
const runnerUnsupportedTools: ReadonlySet<string> = new Set([
  // Find_files / search_text / apply_patch now travel as runner file operations
  // (RunnerFileRequestSchema), so a runner workplace serves them like the local target does.
  // Keeps runner workplaces to foreground commands, so the background tools stay hidden
  // even though remote-target.ts:656/721 can start and write background jobs; local-prepare.ts
  // rejects run_command with background for the same reason.
  "background_command",
  "write_stdin",
  // send_file reads with node:fs on the brain host (conversations/attachments/send-files.ts
  // realpath/open/lstat), so a runner path is simply absent here.
  "send_file",
  // Code navigation and review build their index over the workplace with node:fs
  // (runtime/review/code-map-index.ts, runtime/review/review-snapshot.ts).
  "code_navigate",
  "code_outline",
  "code_symbols",
  "code_map",
  "review_start",
  // Project notes are read/written with node:fs at primary.canonicalPath
  // (runtime/notes/project-notes.ts).
  "project_notes",
  // local-run.ts:422 needs host.revealPath; a runner path is not on this desktop.
  "reveal_in_folder",
  // Reads and pings from this desktop; a runner's own network is not what it would show.
  "local_network",
]);

/** True when a runner workplace must not offer the tool at all. */
export function runnerHidesTool(tool: string): boolean {
  return runnerUnsupportedTools.has(tool);
}

/**
 * A direct call can still arrive (an old catalog, tool_discover, a retry). The authorizer turns
 * this into a refusal with the same text, so the model reads why instead of the generic
 * "tool approval failed" that a thrown RpcError would collapse into.
 */
export class RunnerToolUnsupportedError extends RpcError {
  constructor(readonly tool: string) {
    super(
      RpcErrorCodes.unsupported,
      `执行端暂不支持 ${tool} / The execution target does not support ${tool} yet`,
    );
  }
}

/**
 * A runner target fails per call with identifiers from its own layer. The generic "check the
 * path, permissions or format" text hid which one it was and what to do, so the cases
 * with a distinct next step are named here. Every other error keeps its normal classification.
 */
const runnerOffline = {
  code: "runner_offline",
  text: "执行端已离线，访问不到这个工作文件夹或它的进程；等它重新连接后重试，或把工作文件夹改到本机 / The execution target is offline, so its folder and processes are unreachable; wait for it to reconnect or move the working folder to this computer",
};
const runnerRevoked = {
  code: "runner_revoked",
  text: "这个执行端的配对已被撤销，不能再访问它的文件或运行命令；请在「连接」里重新配对 / This execution target was revoked, so its files and commands are unavailable; pair it again in Connections",
};
const runnerMixed = {
  code: "workplace_mixed_locations",
  text: "一个工作区的主文件夹和只读参考必须在同一台设备上；请把文件夹改到同一台设备 / A workspace's primary and read-only folders must be on the same device; move them to one device",
};
const runnerDropped = {
  code: "runner_disconnected",
  text: "执行端连接在执行过程中断开，这次操作的结果未知；先确认执行端在线、检查文件当前状态，再决定是否重试 / The execution target's connection dropped mid-operation and the outcome is unknown; check that it is online and inspect the files before retrying",
};
// The runner's process monitor could not read the OS process list after retrying. The
// command was stopped by the monitor, not by a path, permission or format problem, so the generic
// "check the path" text sent the model after the wrong cause.
const runnerTransient = {
  code: "runner_transient",
  text: "命令因执行端监控故障被中途停止，可能已部分执行；先检查文件或仓库状态，再决定是否重试 / The command was stopped part-way by a monitor fault on the execution target and may have partially run; check the files or repository state before deciding whether to retry",
};

/** Either the RPC message or the AgentError code: the run-level path converts one into the other. */
const runnerFailures: Readonly<Record<string, { code: string; text: string }>> = {
  endpoint_offline: { code: "endpoint_offline", text: "endpoint_offline" },
  capability_off: { code: "capability_off", text: "capability_off" },
  runner_target_offline: runnerOffline,
  runner_offline: runnerOffline,
  remote_device_revoked: runnerRevoked,
  runner_revoked: runnerRevoked,
  workspace_targets_mixed: runnerMixed,
  workplace_mixed_locations: runnerMixed,
  transport_closed: runnerDropped,
  runner_disconnected: runnerDropped,
  runner_transient: runnerTransient,
};

/** A runner-specific failure with its next step spelled out, or undefined for other errors. */
export function runnerFailure(error: unknown): { code: string; text: string } | undefined {
  const message = error instanceof Error ? error.message : undefined;
  return message ? runnerFailures[message] : undefined;
}

/**
 * F5 (Linux acceptance 2026-11-11): a link that dropped while a call was being re-checked or
 * dispatched surfaced as `policy_denied` with "check permissions and workplaces". A dropped
 * link is a connection failure, whichever layer noticed it first.
 */
export function runnerLinkLost(error: unknown): { code: string; text: string } | undefined {
  const named = runnerFailure(error);
  if (named) return named;
  if (error instanceof ExecError && error.reason === "runner_disconnected") return runnerDropped;
  if (error instanceof RpcError && error.code === RpcErrorCodes.closed) return runnerDropped;
  return undefined;
}

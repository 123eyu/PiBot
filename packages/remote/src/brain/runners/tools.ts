import { posix, win32 } from "node:path";
import { auditText, type CapabilityContext, type ToolRunContext } from "@pibot/brain/kit";
import { RpcError, RpcErrorCodes } from "@pibot/protocol";
import { runnerTools } from "@pibot/remote-contract";
import { ChatNoticesRepo, ConversationsRepo } from "@pibot/storage";
import type { RemoteService } from "../runtime/service.ts";

type Language = ToolRunContext["language"];
const say = (language: Language, zh: string, en: string) => (language === "zh" ? zh : en);
const refusal = (text: string) => ({ text, isError: true as const });

/**
 * Bots see the paired runners and may propose moving a DM topic onto
 * one. The proposal is only a card; the move is the user's own RPC (`remote.workplaceMove.resolve`),
 * so no YOLO switch, remembered grant or routine preauthorization can answer it.
 */
export function runnerWorkplaceTools(ctx: CapabilityContext, service: RemoteService) {
  const runners = () => {
    const found: { id: string; name: string; target: string; online: boolean }[] = [];
    let after: string | undefined;
    do {
      const page = service.list({ after, limit: 100 });
      for (const device of page.items)
        if (device.kind === "runner" && device.target && !device.revokedAt)
          found.push({
            id: device.id,
            name: device.name,
            target: device.target,
            online: device.online,
          });
      after = page.nextAfter ?? undefined;
    } while (after);
    return found;
  };
  const platformOf = (target: string) => {
    try {
      return ctx.local.executionTargets.require(target).platform;
    } catch {
      return undefined;
    }
  };

  function list(context: ToolRunContext) {
    const current = context.runWorkplace?.boundary.location?.target;
    const items = runners().map((runner) => ({
      name: runner.name,
      target: runner.target,
      online: runner.online,
      ...(runner.online && platformOf(runner.target)
        ? { platform: platformOf(runner.target) }
        : {}),
      currentWorkplace: current === runner.target,
    }));
    return {
      text: JSON.stringify({
        runners: items,
        thisComputerIsCurrent: !current?.startsWith("runner:"),
      }),
      summary: say(
        context.language,
        `查看了已配对的执行端（${items.length} 台）`,
        `Listed paired runners (${items.length})`,
      ),
    };
  }

  async function propose(context: ToolRunContext, input: unknown, signal: AbortSignal) {
    const args = runnerTools.workplace_use_runner.schema.parse(input);
    const zh = context.language === "zh";
    const topic = context.conversationId
      ? new ConversationsRepo(ctx.db).get(context.conversationId)
      : undefined;
    if (
      topic?.kind !== "dm" ||
      topic.botId !== context.botId ||
      topic.archivedAt ||
      topic.routineId ||
      context.groupId ||
      context.permissionGroupId ||
      context.routineRunId ||
      context.routineWorkplace ||
      context.executionTaskId
    )
      return refusal(
        "只能在和用户的私聊话题里提议换工作位置；群、例行任务和子任务里不可用 / Moving the working folder can only be proposed in a direct chat with the user, not in groups, routines or subtasks",
      );
    const runner = runners().find((entry) => entry.target === args.target);
    if (!runner)
      return refusal(
        "没有这个执行端；先用 execution_targets 查看已配对的执行端 / Unknown runner; list paired runners with execution_targets first",
      );
    if (!runner.online)
      return refusal(
        `执行端「${runner.name}」离线，现在不能换过去；请用户确认它已开机并连接 / Runner "${runner.name}" is offline; ask the user to make sure it is on and connected`,
      );
    let entry: ReturnType<typeof ctx.local.executionTargets.require>;
    try {
      entry = ctx.local.executionTargets.require(runner.target);
    } catch {
      return refusal(
        `执行端「${runner.name}」刚刚断开，请稍后再试 / Runner "${runner.name}" just disconnected; try again shortly`,
      );
    }
    const paths = entry.platform === "win32" ? win32 : posix;
    if (!paths.isAbsolute(args.path))
      return refusal(
        `路径必须是执行端（${entry.platform}）上的绝对路径 / The path must be absolute on the runner (${entry.platform})`,
      );
    let path: string;
    try {
      const probe = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
      const canonical = await entry.target.canonicalizePath(args.path, args.path, probe);
      // The same checks the user's acceptance runs (workplaces.pick): canonicalize does not fail
      // for a missing path (it reports no device), and the runner refuses folders that contain its
      // own data. Without them the card offered folders that could never be accepted (v0.0.2 test:
      // a missing Windows folder, and a Linux folder holding the runner's data directory).
      if (!canonical.device || !canonical.inode) throw new Error("runner_folder_missing");
      await entry.target.listDir({
        path: canonical.path,
        cwd: canonical.path,
        signal: probe,
        writeRoots: [],
        rootIdentities: [
          {
            canonicalPath: canonical.path,
            device: canonical.device,
            inode: canonical.inode,
            role: "readonly",
          },
        ],
      });
      path = canonical.path;
    } catch {
      return refusal(
        "执行端上找不到这个文件夹或没有权限；请和用户确认路径 / That folder does not exist on the runner or cannot be read; confirm the path with the user",
      );
    }
    signal.throwIfAborted();
    const note = args.note ? auditText(args.note, ctx.redactor, 500).slice(0, 500) : undefined;
    const notice = new ChatNoticesRepo(ctx.db).addMoveProposal({
      conversationId: topic.id,
      botId: context.botId,
      runId: context.runId,
      location: runner.target,
      runnerName: runner.name,
      path,
      ...(note ? { note } : {}),
    });
    ctx.peer.emit("chat.notice", notice);
    return {
      text: zh
        ? `已请用户在卡片上确认把工作文件夹换到「${runner.name}」的 ${path}。本轮到此为止：告诉用户去确认；确认后从下一条消息起在执行端上工作，拒绝则保持不变。`
        : `Asked the user to confirm moving the working folder to ${path} on "${runner.name}". Stop this turn: tell the user to answer the card; once accepted, the next message works on the runner, otherwise nothing changes.`,
      summary: say(
        context.language,
        `提议把工作文件夹换到执行端「${runner.name}」`,
        `Proposed moving the working folder to runner "${runner.name}"`,
      ),
    };
  }

  ctx.tools.executor("execution_targets", async (context) => list(context));
  ctx.tools.executor("workplace_use_runner", (context, call, signal) =>
    propose(context, call.input, signal),
  );

  ctx.rpc.handle("remote.workplaceMove.resolve", async ({ noticeId, accept }, { signal }) => {
    const notices = new ChatNoticesRepo(ctx.db);
    const notice = notices.get(noticeId);
    if (notice?.kind !== "workplace_move_proposal" || notice.status !== "pending")
      throw new RpcError(RpcErrorCodes.invalidParams, "workplace_move_closed");
    if (accept) {
      // The same registration and topic update as the user's own folder chooser: the runner
      // must be online, the topic idle, and the folder still there.
      const { folder } = await ctx.local.workplaces.pick(
        notice.botId,
        false,
        { location: notice.location, path: notice.path },
        signal,
      );
      if (!folder) throw new RpcError(RpcErrorCodes.invalidParams, "runner_folder_invalid");
      await ctx.bots.updateTopicWorkplace(
        {
          botId: notice.botId,
          topicId: notice.conversationId,
          selection: { primary: folder.id, readonly: [], writable: [] },
        },
        signal,
      );
      ctx.peer.emit("bots.changed", { botId: notice.botId, reason: "updated" });
    }
    const answered = notices.resolveMoveProposal(noticeId, accept ? "accepted" : "declined");
    if (!answered) throw new RpcError(RpcErrorCodes.invalidParams, "workplace_move_closed");
    ctx.local.approvals.audit.append({
      botId: notice.botId,
      kind: accept ? "topic.folder.moved" : "topic.folder.move_declined",
      summary: accept
        ? "Topic moved to a runner folder / 话题工作文件夹换到执行端"
        : "Runner folder move declined / 拒绝换到执行端文件夹",
      detail: {
        actor: "user",
        conversationId: notice.conversationId,
        reasonCode: accept ? "user_accepted" : "user_declined",
        target: auditText(notice.runnerName, ctx.redactor, 200),
        path: auditText(notice.path, ctx.redactor, 4096),
      },
    });
    ctx.peer.emit("chat.notice", answered);
    return { ok: true as const };
  });
}

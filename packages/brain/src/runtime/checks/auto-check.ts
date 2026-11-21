import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { LocalToolResult } from "@pibot/agent";
import {
  AutoCheckCommandsSchema,
  type AutoCheckFolder,
  type AutoCheckSettings,
  type ChatNotice,
  RpcError,
} from "@pibot/protocol-base";
import {
  BotAutoCheckRepo,
  BotsRepo,
  ChatNoticesRepo,
  ConversationsRepo,
  FolderChecksRepo,
  GroupsRepo,
  transaction,
} from "@pibot/storage";
import { abortable } from "../../core/abort.ts";
import { auditText } from "../../core/audit-fields.ts";
import type { ToolRunContext } from "../../core/local-types.ts";
import { runYolo } from "../../core/yolo.ts";
import type { LocalService } from "../../local-service.ts";
import { resolveRunWorkplace } from "../../resources/workplaces/run-workplace.ts";
import { businessConfirmation } from "../tools/business-confirmation.ts";
import { codeChanges, DEFAULT_CODE_EXTENSIONS } from "./auto-check-files.ts";
import { proposeResult } from "./auto-check-text.ts";

type Proposal = Extract<ChatNotice, { kind: "auto_check_proposal" }>;
export interface CheckFolder {
  key: string;
  path: string;
  name: string;
  home: boolean;
}
export interface AutoCheckOptions {
  /** Replaces the default list of code file extensions (lower case, with the dot). */
  codeExtensions?: readonly string[];
  /** How long a run waits for the user to answer a proposal card before it ends. */
  proposalWaitMs?: number;
  /** Per check command; the same bounds as a Bot's own `run_command` (1–600). */
  timeoutSec?: number;
}

/**
 * The role's `autoCheck`
 * becomes the Bot's default, unless the switch was already set. Call inside the creating
 * transaction; returns whether the default was written.
 */
export function defaultAutoCheckForNewBot(db: DatabaseSync, botId: string, enabled: boolean) {
  return new BotAutoCheckRepo(db).setDefault(botId, enabled);
}

/**
 * Automatic check: per-Bot switch and rounds, per-folder commands, proposal cards. The
 * per-run flow is `AutoCheckRun` (auto-check-run.ts); the commands themselves always run as an
 * ordinary `run_command` step of that run (same policy gate, card, YOLO, lock and audit).
 */
export class AutoCheckService {
  readonly settings: BotAutoCheckRepo;
  readonly folders: FolderChecksRepo;
  readonly notices: ChatNoticesRepo;
  readonly extensions: ReadonlySet<string>;
  readonly proposalWaitMs: number;
  readonly timeoutSec: number;
  private readonly waiters = new Map<string, Set<(notice: Proposal) => void>>();
  /** Conversations with checks off for this brain's lifetime (autoCheck.conversation.set). */
  private readonly off = new Set<string>();
  constructor(
    private readonly local: LocalService,
    options: AutoCheckOptions = {},
  ) {
    const { db } = local.deps;
    this.settings = new BotAutoCheckRepo(db);
    this.folders = new FolderChecksRepo(db);
    this.notices = new ChatNoticesRepo(db);
    this.extensions = new Set(
      (options.codeExtensions ?? DEFAULT_CODE_EXTENSIONS).map((e) => e.toLowerCase()),
    );
    this.proposalWaitMs = options.proposalWaitMs ?? 5 * 60_000;
    this.timeoutSec = Math.min(Math.max(options.timeoutSec ?? 600, 1), 600);
  }

  get(botId: string): AutoCheckSettings {
    const value = this.settings.get(botId);
    if (!value) throw new RpcError(-32602, "bot_not_found");
    return value;
  }

  set(botId: string, change: { enabled?: boolean; rounds?: number }): AutoCheckSettings {
    const before = this.get(botId);
    if (
      (change.enabled === undefined || change.enabled === before.enabled) &&
      (change.rounds === undefined || change.rounds === before.rounds) &&
      before.stored
    )
      return before;
    const value = transaction(this.local.deps.db, () => {
      const next = this.settings.set(botId, change);
      if (!next) throw new RpcError(-32602, "bot_not_found");
      this.audit(botId, {
        reasonCode:
          change.enabled === undefined
            ? "autocheck_rounds"
            : change.enabled
              ? "autocheck_on"
              : "autocheck_off",
        round: next.rounds,
      });
      return next;
    });
    this.local.deps.peer.emit("autoCheck.changed", { botId, reason: "settings" });
    return value;
  }

  /** Same as `defaultAutoCheckForNewBot`, for callers that hold the service. */
  defaultAutoCheckForNewBot(botId: string, enabled: boolean) {
    return defaultAutoCheckForNewBot(this.local.deps.db, botId, enabled);
  }

  conversationSet(conversationId: string, enabled: boolean) {
    this.off.delete(conversationId);
    if (!enabled) {
      this.off.add(conversationId);
      // Bounded like ACP's own session memory (64 sessions x a few Bot topics); oldest go first.
      if (this.off.size > 1024) this.off.delete(this.off.values().next().value as string);
    }
    return { conversationId, enabled };
  }

  /** Ordinary chat runs of a text Bot with the switch on; never routines or trial runs. */
  active(
    context: Pick<
      ToolRunContext,
      "botId" | "conversationId" | "routineRunId" | "routineSource" | "runWorkplace"
    >,
  ) {
    if (context.runWorkplace?.boundary.location?.target.startsWith("runner:")) return false;
    if (context.routineRunId || context.routineSource) return false;
    if (context.conversationId && this.off.has(context.conversationId)) return false;
    const bot = new BotsRepo(this.local.deps.db).get(context.botId);
    return bot?.category !== "image" && this.settings.get(context.botId)?.enabled === true;
  }

  /** The key of a folder: its real path, case-folded where the file system usually is. */
  folderOf(cwd: string, home: boolean): CheckFolder {
    return {
      key: this.local.deps.platform === "win32" ? cwd.toLowerCase() : cwd,
      path: cwd,
      name: basename(cwd) || cwd,
      home,
    };
  }

  /** Code files this run changed so far inside `folder`. */
  async codeChanges(runId: string, folder: string) {
    return codeChanges(
      await this.local.changes.turn.touched(runId),
      folder,
      this.local.deps.platform,
      this.extensions,
    );
  }

  async folderGet(botId: string, conversationId: string): Promise<AutoCheckFolder> {
    const folder = await this.resolve(botId, conversationId).catch((error: unknown) => {
      if (error instanceof RpcError && error.code === -32602 && error.message === "not_member")
        throw error;
      // A moved / unreadable folder: the panel says so instead of failing the whole section.
      this.local.deps.logger.warn(`Auto-check folder unavailable botId=${botId}`);
      return undefined;
    });
    return {
      botId,
      conversationId,
      folder: folder ? { name: folder.name, path: folder.path, home: folder.home } : null,
      commands: folder ? this.folders.get(folder.key) : null,
    };
  }

  async folderSet(botId: string, conversationId: string, commands: string[] | null) {
    const folder = await this.resolve(botId, conversationId);
    const parsed = commands?.length ? AutoCheckCommandsSchema.parse(commands) : commands;
    transaction(this.local.deps.db, () => {
      if (parsed === null) this.folders.forget(folder.key);
      else this.folders.set(folder.key, folder.path, parsed);
      this.audit(botId, {
        reasonCode:
          parsed === null
            ? "command_forgotten"
            : parsed.length
              ? "command_saved"
              : "command_skipped",
        ...(parsed?.length ? { command: auditText(parsed.join(" && "), this.redactor) } : {}),
        target: auditText(folder.name, this.redactor),
      });
    });
    this.local.deps.peer.emit("autoCheck.changed", { botId, reason: "folder" });
    return this.folderGet(botId, conversationId);
  }

  /** The `check_command_propose` tool: a card in this run's conversation; nothing runs. */
  propose(context: ToolRunContext, args: { commands: string[]; note?: string }): LocalToolResult {
    const cwd = context.runWorkplace?.cwd;
    const parsed = AutoCheckCommandsSchema.safeParse(args.commands);
    if (!cwd || !context.conversationId || !parsed.success)
      return {
        text: "检查命令无效：1–3 条单行命令 / Invalid check commands: 1–3 single-line commands",
        isError: true,
      };
    const folder = this.folderOf(cwd, context.runWorkplace?.boundary.primaryId === "home");
    const note = args.note?.trim()
      ? auditText(args.note, this.redactor, 500).slice(0, 500)
      : undefined;
    const notice = this.notices.addProposal(
      {
        conversationId: context.conversationId,
        botId: context.botId,
        runId: context.runId,
        commands: parsed.data.map((command) => this.redactor.redact(command)),
        folderName: folder.home ? "" : folder.name,
        ...(note ? { note } : {}),
      },
      folder,
    );
    const automatic = this.useForRun(notice.id, context);
    if (automatic)
      return {
        text: "检查命令将在本轮按权限执行，未保存为未来配置 / Check commands will run for this turn under policy; no future configuration was saved",
        summary:
          context.language === "zh"
            ? "本轮检查命令已选定（YOLO）"
            : "Check commands selected for this turn (YOLO)",
      };
    this.local.deps.peer.emit("chat.notice", notice);
    return {
      text: proposeResult(context.language, folder.home ? "~" : folder.name),
      summary:
        context.language === "zh"
          ? "提出了检查命令，等你确认"
          : "Proposed check commands for your confirmation",
    };
  }

  /** The newest proposal card this run made (answered or not; the user may be quick). */
  proposalFromRun(runId: string, conversationId: string) {
    return this.notices
      .list(conversationId, { limit: 20 })
      .find(
        (notice): notice is Proposal =>
          notice.kind === "auto_check_proposal" && notice.runId === runId,
      );
  }

  resolveProposal(noticeId: string, accept: boolean, edited?: string[]) {
    const pending = this.notices.pendingProposal(noticeId);
    if (!pending) throw new RpcError(-32602, "autocheck_proposal_closed");
    const commands = AutoCheckCommandsSchema.parse(edited ?? pending.notice.commands);
    const notice = transaction(this.local.deps.db, () => {
      const next = this.notices.resolveProposal(
        noticeId,
        accept ? "accepted" : "declined",
        commands,
      );
      if (!next) throw new RpcError(-32602, "autocheck_proposal_closed");
      // "Not now" also means "don't ask again for this folder"; the panel can still set commands.
      this.folders.set(pending.folder.key, pending.folder.path, accept ? commands : []);
      this.audit(pending.notice.botId, {
        reasonCode: accept ? "proposal_accepted" : "proposal_declined",
        ...(accept ? { command: auditText(commands.join(" && "), this.redactor) } : {}),
        target: auditText(basename(pending.folder.path), this.redactor),
      });
      return next;
    });
    this.local.deps.peer.emit("chat.notice", notice);
    this.local.deps.peer.emit("autoCheck.changed", {
      botId: pending.notice.botId,
      reason: "folder",
    });
    for (const wake of this.waiters.get(noticeId) ?? []) wake(notice);
    this.waiters.delete(noticeId);
    return notice;
  }

  /** Resolves with the answered card, or undefined on timeout / stop (the card stays usable). */
  waitProposal(
    noticeId: string,
    signal: AbortSignal,
    context?: ToolRunContext,
  ): Promise<Proposal | undefined> {
    return new Promise((resolve) => {
      let unsubscribe = () => {};
      const done = (notice?: Proposal) => {
        clearTimeout(timer);
        unsubscribe();
        signal.removeEventListener("abort", stop);
        const set = this.waiters.get(noticeId);
        set?.delete(wake);
        if (set?.size === 0) this.waiters.delete(noticeId);
        resolve(notice);
      };
      const wake = (notice: Proposal) => done(notice);
      const stop = () => done();
      const timer = setTimeout(stop, this.proposalWaitMs);
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) return stop();
      const set = this.waiters.get(noticeId) ?? new Set();
      set.add(wake);
      this.waiters.set(noticeId, set);
      if (context?.conversationId) {
        const enabled = () => {
          try {
            const notice = this.useForRun(noticeId, context);
            if (notice) done(notice);
          } catch {
            this.local.deps.logger.warn("YOLO automatic check source changed");
            done();
          }
        };
        const source = context.executionTaskId ? this.local.tasks.source(context) : context;
        unsubscribe = this.local.yolo.onEnabled(
          source.conversationId ?? context.conversationId,
          enabled,
        );
        if (runYolo(this.local, context)) enabled();
      }
      const current = this.notices.get(noticeId);
      if (current?.kind === "auto_check_proposal" && current.status !== "pending") done(current);
    });
  }

  private useForRun(noticeId: string, context: ToolRunContext): Proposal | undefined {
    const pending = this.notices.pendingProposal(noticeId);
    if (!pending) return undefined;
    const { notice, folder } = pending;
    if (
      notice.runId !== context.runId ||
      notice.botId !== context.botId ||
      notice.conversationId !== context.conversationId ||
      folder.path !== context.runWorkplace?.cwd
    )
      throw new RpcError(-32602, "autocheck_proposal_scope_changed");
    const automatic = businessConfirmation(this.local, context, {
      id: noticeId,
      tool: "check_command_propose",
      input: { commands: notice.commands },
    });
    if (!automatic) return undefined;
    const accepted = transaction(this.local.deps.db, () => {
      automatic.assertCurrent();
      const result = this.notices.resolveProposal(noticeId, "accepted", notice.commands);
      if (!result) throw new RpcError(-32602, "autocheck_proposal_closed");
      automatic.audit();
      return result;
    });
    this.emit(accepted);
    for (const wake of [...(this.waiters.get(noticeId) ?? [])]) wake(accepted);
    return accepted;
  }

  emit(notice: ChatNotice) {
    this.local.deps.peer.emit("chat.notice", notice);
  }

  audit(
    botId: string,
    detail: {
      reasonCode: string;
      round?: number;
      command?: string;
      target?: string;
      exitCode?: number | null;
      durationMs?: number;
      groupId?: string;
    },
    kind: "autocheck.changed" | "autocheck.finished" = "autocheck.changed",
    runId?: string,
  ) {
    this.local.approvals.audit.append({
      botId,
      ...(runId ? { runId } : {}),
      kind,
      summary:
        kind === "autocheck.finished"
          ? `Automatic check ${detail.reasonCode} / 自动检查结束`
          : "Automatic check settings changed / 自动检查设置已更改",
      detail: {
        actor: kind === "autocheck.finished" ? "automatic" : "user",
        toolName: "run_command",
        ...detail,
      },
    });
  }

  private get redactor() {
    return this.local.deps.redactor;
  }

  /** The conversation's primary folder exactly as a run there would resolve it. */
  private async resolve(botId: string, conversationId: string): Promise<CheckFolder> {
    const { db } = this.local.deps;
    const conversation = new ConversationsRepo(db).get(conversationId);
    const member =
      conversation &&
      !conversation.archivedAt &&
      (conversation.kind === "dm"
        ? conversation.botId === botId && !conversation.routineId
        : !!conversation.groupId &&
          !!new GroupsRepo(db)
            .get(conversation.groupId)
            ?.members.some((entry) => entry.botId === botId));
    if (!conversation || !member) throw new RpcError(-32602, "not_member");
    const signal = AbortSignal.any([this.local.shutdown.signal, AbortSignal.timeout(20_000)]);
    const place = await abortable(
      resolveRunWorkplace(
        this.local,
        {
          botId,
          runId: randomUUID(),
          messageId: randomUUID(),
          conversationId,
          ...(conversation.groupId ? { groupId: conversation.groupId } : {}),
          signal,
          language: "en",
        },
        signal,
      ),
      signal,
    );
    if (place.boundary.location?.target.startsWith("runner:"))
      throw new RpcError(-32601, "runner_checks_unsupported");
    return this.folderOf(place.cwd, place.boundary.primaryId === "home");
  }
}

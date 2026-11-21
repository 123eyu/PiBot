import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { BotSession } from "@pibot/agent";
import type { ChatNotice } from "@pibot/protocol-base";
import type { ChatReplies } from "../../conversations/chat/chat-replies.ts";
import { auditText } from "../../core/audit-fields.ts";
import type { ToolRunContext } from "../../core/local-types.ts";
import { runYolo } from "../../core/yolo.ts";
import type { LocalService } from "../../local-service.ts";
import type { ChatRun } from "../queue/chat-run.ts";
import type { AutoCheckService, CheckFolder } from "./auto-check.ts";
import { outputTail } from "./auto-check-files.ts";
import { fixText, proposeText } from "./auto-check-text.ts";

type PromptResult = Awaited<ReturnType<BotSession["prompt"]>>;
type CheckNotice = Extract<ChatNotice, { kind: "auto_check" }>;
type Verdict = CheckNotice["status"];
interface Outcome {
  status: Verdict;
  notice: CheckNotice;
  command?: string;
  exitCode?: number | null;
  output?: string;
  failureKind?: "environment";
}

/** The end of a `run_command` result is its own status line, not the program's output. */
const STATUS_LINE =
  /\n(?:已停止 \/ Stopped|执行超时 \/ Command timed out|退出码 \/ Exit code: [^\n]*)$/;
const TIMED_OUT = "执行超时 / Command timed out";
// Narrow startup failures only; arbitrary stderr (including test expectations) is not a diagnosis.
function environmentFailure(text: string) {
  const tail = outputTail(text, 40, 6000);
  return (
    /create the package-manager env directory/i.test(tail) ||
    /(?:EACCES|EPERM|ERR_PNPM_[A-Z_]+)[^\n]*(?:permission denied|operation not permitted|mkdir)/i.test(
      tail,
    ) ||
    /(?:Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|command not found|ENOENT)[^\n]*(?:pnpm|corepack|typescript|vitest|biome)/i.test(
      tail,
    ) ||
    /ERR_PNPM_(?:BAD_PM_VERSION|BAD_ENGINE|NO_IMPORTER_MANIFEST_FOUND|NO_SCRIPT)/.test(tail)
  );
}

/**
 * The automatic check of one chat run, between its last prompt and its finish. All
 * prompts reuse the run's session and reply segments; all commands are synthetic `run_command`
 * steps of the same LocalRun. Returns the result of the run's last prompt.
 */
export class AutoCheckRun {
  halted = false;
  private readonly service: AutoCheckService;
  private readonly called = new Set<string>();
  constructor(
    private readonly deps: {
      local: LocalService;
      run: ChatRun;
      context: ToolRunContext;
      tools: Pick<import("../tools/local-run.ts").LocalRun, "runSynthetic" | "reuseCheck">;
      replies: ChatReplies;
      language: "zh" | "en";
      prompt(text: string): Promise<PromptResult>;
    },
  ) {
    this.service = deps.local.autoCheck;
  }

  private stopped() {
    return this.deps.run.aborted || this.deps.run.signal.aborted;
  }

  private merged(result: PromptResult): PromptResult {
    for (const tool of result.calledTools ?? []) this.called.add(tool);
    return { ...result, calledTools: [...this.called] };
  }

  private async ask(text: string) {
    this.deps.replies.segment();
    return this.merged(await this.deps.prompt(text));
  }

  async drive(first: PromptResult, allowProposal = true): Promise<PromptResult> {
    let result = this.merged(first);
    const { context, run } = this.deps;
    const cwd = context.runWorkplace?.cwd;
    if (
      result.stopReason !== "stop" ||
      this.stopped() ||
      !cwd ||
      !context.conversationId ||
      !this.service.active(context)
    )
      return result;
    let changed = await this.service.codeChanges(run.runId, cwd);
    // Command-made changes come from a folder watch that reports at most once a second.
    if (!changed.length && this.deps.local.changes.turn.watching(run.runId)) {
      await delay(1200, undefined, { signal: run.signal }).catch(() => undefined);
      if (this.stopped()) return result;
      changed = await this.service.codeChanges(run.runId, cwd);
    }
    if (!changed.length) return result;
    const folder = this.service.folderOf(cwd, context.runWorkplace?.boundary.primaryId === "home");
    let commands = this.service.folders.get(folder.key);
    if (commands === null) {
      if (!allowProposal) {
        this.halted = true;
        return result;
      }
      result = await this.ask(
        proposeText(this.deps.language, changed, runYolo(this.deps.local, context)),
      );
      if (result.stopReason !== "stop" || this.stopped()) return result;
      const saved = await this.confirmed(context.conversationId);
      if (!saved) {
        this.halted = true;
        return result;
      }
      commands = saved;
    }
    if (!commands.length) return result;
    const maxRounds = this.service.get(context.botId).rounds;
    for (let round = 0; ; round++) {
      const outcome = await this.check(commands, folder, round, maxRounds);
      if (outcome.status !== "failed" && outcome.status !== "timeout") {
        this.halted = outcome.status !== "passed";
        return result;
      }
      if (this.stopped()) return result;
      if (round >= maxRounds) {
        this.halted = true;
        this.update(outcome.notice, { limitReached: true });
        return result;
      }
      this.update(outcome.notice, { followUp: true });
      result = await this.ask(
        fixText(this.deps.language, {
          command: outcome.command ?? "",
          exitCode: outcome.exitCode,
          timedOut: outcome.status === "timeout",
          tail: outputTail(outcome.output ?? "", 80, 6000),
          round: round + 1,
          maxRounds,
        }),
      );
      if (result.stopReason !== "stop" || this.stopped()) return result;
    }
  }

  /** Waits (bounded, stoppable) for the user's answer on the card this run's prompt produced. */
  private async confirmed(conversationId: string): Promise<string[] | undefined> {
    const card = this.service.proposalFromRun(this.deps.run.runId, conversationId);
    if (!card) return undefined;
    if (card.status === "pending")
      this.deps.context.executionClock?.pause("check_command_confirmation");
    let answered: typeof card | undefined;
    try {
      answered =
        card.status === "pending"
          ? await this.service.waitProposal(card.id, this.deps.run.signal, this.deps.context)
          : card;
    } finally {
      this.deps.context.executionClock?.resume("check_command_confirmation");
    }
    return answered?.status === "accepted" ? answered.commands : undefined;
  }

  private update(notice: CheckNotice, change: Partial<CheckNotice>) {
    try {
      const next = this.service.notices.updateAutoCheck(notice.id, change);
      if (next) this.service.emit(next);
    } catch {
      // The record is informational (its topic may have been deleted meanwhile); the check and
      // its audit already happened.
      this.deps.local.deps.logger.warn(`Auto-check record not updated run=${this.deps.run.runId}`);
    }
  }

  private async check(
    commands: string[],
    folder: CheckFolder,
    round: number,
    maxRounds: number,
  ): Promise<Outcome> {
    const { context, run, local } = this.deps;
    const notice = this.service.notices.addAutoCheck({
      conversationId: context.conversationId as string,
      botId: context.botId,
      runId: run.runId,
      status: "running",
      commands,
      round,
      maxRounds,
    });
    this.service.emit(notice);
    const started = performance.now();
    let outcome: Omit<Outcome, "notice"> = { status: "passed" };
    let failedIndex: number | undefined;
    const reusedChecks: { index: number; toolCallId: string }[] = [];
    for (const [index, command] of commands.entries()) {
      const receipt = await this.deps.tools.reuseCheck(command, run.signal);
      if (receipt && !this.stopped()) {
        reusedChecks.push({ index, toolCallId: receipt });
        continue;
      }
      const step = await this.deps.tools.runSynthetic(
        {
          id: `autocheck-${randomUUID()}`,
          tool: "run_command",
          input: { command, timeoutSec: this.service.timeoutSec },
        },
        run.signal,
      );
      if (!step.allowed) {
        outcome = {
          status: this.stopped() ? "stopped" : "blocked",
          command,
          output: local.deps.redactor.redact(step.reason),
        };
      } else {
        const text = step.result.text;
        const exitCode = step.result.details?.exitCode;
        if (!step.result.isError && exitCode === 0) continue;
        const timedOut = text.endsWith(TIMED_OUT);
        // Without a program exit code, tool failure is not evidence that project code failed.
        const environment =
          environmentFailure(text) ||
          (step.result.isError === true && typeof exitCode !== "number" && !timedOut);
        outcome = {
          status: this.stopped()
            ? "stopped"
            : timedOut
              ? "timeout"
              : environment
                ? "blocked"
                : "failed",
          ...(environment ? { failureKind: "environment" as const } : {}),
          command,
          exitCode: exitCode ?? null,
          output: local.deps.redactor.redact(text.replace(STATUS_LINE, "")),
        };
      }
      failedIndex = index;
      break;
    }
    const durationMs = Math.round(performance.now() - started);
    const finished = this.service.notices.updateAutoCheck(notice.id, {
      status: outcome.status,
      ...(outcome.failureKind ? { failureKind: outcome.failureKind } : {}),
      durationMs,
      ...(reusedChecks.length ? { reusedChecks } : {}),
      ...(failedIndex !== undefined ? { failedIndex } : {}),
      ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
      ...(outcome.output ? { tail: outputTail(outcome.output, 40, 4000) } : {}),
    });
    if (finished) this.service.emit(finished);
    this.service.audit(
      context.botId,
      {
        reasonCode:
          outcome.status === "passed" && reusedChecks.length === commands.length
            ? "reused"
            : outcome.status,
        round,
        durationMs,
        command: auditText(outcome.command ?? commands.join(" && "), local.deps.redactor),
        target: folder.home ? "home" : auditText(folder.name, local.deps.redactor),
        ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
        ...(context.groupId ? { groupId: context.groupId } : {}),
      },
      "autocheck.finished",
      run.runId,
    );
    return { ...outcome, notice: finished ?? notice };
  }
}

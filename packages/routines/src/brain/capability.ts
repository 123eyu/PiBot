import type { BrainCapability } from "@pibot/brain/kit";
import { routineTools } from "@pibot/routines-contract";
import { RoutinePreauthRepo, RoutineRunsRepo, RoutineWakeRepo } from "../store/index.ts";
import type { RoutineDevAdapter } from "./dev/dev.ts";
import { routineWaitingAdapter } from "./execution/waiting.ts";
import type { RoutineHostAdapter } from "./host-adapter.ts";
import { routineInboxSource } from "./inbox.ts";
import { RoutineProposalService } from "./proposals/service.ts";
import { registerRoutineRpc } from "./rpc.ts";
import { routineWakeSource } from "./schedule/wake-plan.ts";
import { RoutineService } from "./service.ts";

/**
 * Routines as a brain capability. Everything the kernel used to wire by hand in
 * `startBrain` now goes through the capability context:
 *
 * - lifecycle: crash recovery of routine runs right after migrations, start/stop with the brain;
 * - standby: routines are the brain's scheduled work, so they provide the wake source and keep the
 *   brain awake while an execution runs;
 * - unattended runs: routines own them, so the queue, chat abort and approvals ask them about
 *   reserved slots, user preemption, parked cards and the live attempt;
 * - RPC: `routines.*` stays callable without a desktop client, so scheduling continues in the
 *   background; pausing and resuming all routines works even while the client is gone.
 */
export function routinesCapability(
  options: { routineDev?: RoutineDevAdapter; host?: RoutineHostAdapter } = {},
): BrainCapability {
  return {
    id: "routines",
    recover: (db) => new RoutineRunsRepo(db).recover(),
    register(ctx) {
      const routines = new RoutineService({
        db: ctx.db,
        agent: ctx.agent,
        dataDir: ctx.dataDir,
        local: ctx.local,
        runQueue: ctx.chat.queue,
        host: ctx.host,
        routineHost: options.host,
        peer: ctx.peer,
        logger: ctx.logger,
        redactor: ctx.redactor,
        credentials: ctx.credentials,
        dev: ctx.dev,
        routineDev: options.routineDev,
      });
      const wake = new RoutineWakeRepo(ctx.db);
      ctx.sleep.wakeSource(routineWakeSource(wake, routines));
      ctx.sleep.participate({
        idle: () => routines.execution.isIdle() && !wake.hasDueRuns(),
        pause: () => routines.pauseAutomation(),
        resume: () => routines.resumeAutomation(),
      });
      routines.activity = () => ctx.sleep.interrupt();
      routines.proposals = new RoutineProposalService(routines, ctx.chat, ctx.groups.confirmNotice);
      const proposals = routines.proposals;
      ctx.tools.executor("routine_query", async (context, call, signal) =>
        proposals.query(context, call, signal),
      );
      ctx.tools.executor("routine_propose", (context, call, signal) =>
        proposals.propose(context, call, signal),
      );
      // The run marks its own result as needing the user; on_attention notifications read it.
      ctx.tools.executor("routine_flag_attention", async (context, call) => {
        const { reason } = routineTools.routine_flag_attention.schema.parse(call.input);
        if (!context.routineRunId)
          return {
            text: "只能在调度任务运行中使用 / Only available in scheduled runs",
            isError: true,
          };
        const flagged = routines.runs.flagAttention(
          context.routineRunId,
          ctx.redactor.redact(reason).slice(0, 200),
        );
        return {
          text: flagged
            ? "已标记，任务结束时会通知用户 / Marked; the user is notified when the run ends"
            : "这次运行已经标记过 / This run is already marked",
        };
      });
      routines.execution.waitingAdapter = routineWaitingAdapter(
        ctx.local,
        routines.authorization,
        routines.execution.ledger,
      );
      const preauth = new RoutinePreauthRepo(ctx.db);
      ctx.unattended.claim({
        run: (id) => routines.runs.require(id),
        definition: (id) => routines.repo.get(id),
        addPreauth: (id, input, snapshot) => {
          preauth.add(id, input, snapshot);
        },
        authorization: routines.authorization,
        ledger: routines.execution.ledger,
        temporaryPaths: (id) => routines.execution.ledger.temporaryPaths(id),
        admit: (record, input) => {
          const reserved = routines.runs.reservation(record.botId, record.conversationId);
          return (
            !reserved || (!!input.userInitiated && !input.routine) || reserved.runId === record.id
          );
        },
        beforeUser: (botId, conversationId) => routines.execution.preempt(botId, conversationId),
        abortRun: (runId) => routines.execution.cancelExecution(runId),
        resolveParked: (id, decision, remember, preauthorize) =>
          routines.execution.resolveParked(id, decision, remember, routines.signal(), preauthorize),
        identity: (id) => routines.execution.identity(id),
        verifyWaiting: async (id, signal) => {
          if (!routines.execution.waitingAdapter) throw new Error("routine_waiting_unavailable");
          return routines.execution.waitingAdapter.verify(id, signal);
        },
        approvalLifecycle: (context, call, prepared, isolation) =>
          routines.execution.approvalLifecycle(context, call, prepared, isolation),
      });
      ctx.inbox.source(routineInboxSource);
      ctx.rpc.background("routines.");
      ctx.rpc.allowOffline("routines.pauseAll");
      ctx.rpc.allowOffline("routines.resumeAll");
      registerRoutineRpc(ctx.rpc.handle, routines);
      return { start: () => routines.start(), stop: () => routines.stop() };
    },
  };
}

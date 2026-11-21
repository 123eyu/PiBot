import { useEffect, useState } from "react";
import { z } from "zod";
import { useLinkState, useRuntime } from "../../../runtime/context.tsx";
import { useCachedValue } from "../../../runtime/use-cached-value.ts";
import { readRunTurn, TurnSchema } from "../../changes/calls.ts";
import { type RoutineRun, type Run, TaskCenterSchema } from "../pages.ts";
import { RunMessagesSchema, type RunRef, readRunMessages } from "./calls.ts";

export const TaskParamsSchema = z.object({
  kind: z.enum(["run", "routine"]),
  id: z.uuid(),
});
export type TaskItemRef = z.infer<typeof TaskParamsSchema>;
export type TaskRecord = { kind: "run"; run: Run } | { kind: "routine"; run: RoutineRun };

function runRef(record: TaskRecord | undefined): RunRef | undefined {
  if (!record) return undefined;
  if (record.kind === "run")
    return {
      runId: record.run.id,
      botId: record.run.botId,
      conversationId: record.run.conversationId,
      groupId: record.run.groupId,
      taskId: record.run.taskId,
      userMessageId: record.run.userMessageId,
    };
  const { runId, conversationId, botId } = record.run;
  return runId && conversationId ? { runId, botId, conversationId } : undefined;
}
/**
 * One task-center item: its record comes from the task center the phone already caches (so it
 * opens offline), the request / reply / steps and the run's changes from cached computer reads.
 */
export function useTaskDetail(ref: TaskItemRef) {
  const runtime = useRuntime(),
    mobile = useLinkState();
  const [record, setRecord] = useState<TaskRecord | null>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: the device and refreshes own the cached center.
  useEffect(() => {
    let live = true;
    void (async () => {
      const cached = TaskCenterSchema.safeParse(
        await runtime.storage.data.get(`cache:${mobile.selectedId}:tasks`),
      );
      if (!live) return;
      const center = cached.success ? cached.data : undefined;
      const found: TaskRecord | undefined =
        ref.kind === "run"
          ? (() => {
              const run = center?.runs.find((item) => item.id === ref.id);
              return run && { kind: "run" as const, run };
            })()
          : (() => {
              const run = center?.routines.find((item) => item.id === ref.id);
              return run && { kind: "routine" as const, run };
            })();
      setRecord(found ?? null);
    })().catch(() => {
      if (live) setRecord(null);
    });
    return () => {
      live = false;
    };
  }, [mobile.selectedId, mobile.status, mobile.refreshVersion, ref.kind, ref.id]);
  const run = runRef(record ?? undefined);
  const messages = useCachedValue(
    run ? `task:${run.runId}` : undefined,
    RunMessagesSchema,
    (signal) => readRunMessages(runtime, run as RunRef, signal),
    ["chat.done"],
  );
  const changes = useCachedValue(
    run ? `turn:${run.runId}` : undefined,
    TurnSchema,
    (signal) => readRunTurn(runtime, (run as RunRef).runId, signal),
    ["changes.changed"],
  );
  return { record, run, messages, changes };
}

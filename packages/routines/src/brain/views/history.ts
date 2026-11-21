import type { RoutineHistoryQuery } from "@pibot/protocol";
import type { RoutineService } from "../service.ts";

export function routineHistory(s: RoutineService, query: RoutineHistoryQuery) {
  s.lifetime.signal.throwIfAborted();
  const now = Date.now();
  const safe = (value: string | null, limit: number) =>
    value === null ? null : s.deps.redactor.redact(value).slice(0, limit);
  return s.runs.history(query).map((run) => ({
    ...run,
    taskName: safe(run.taskName, 200),
    bot: run.bot ? { ...run.bot, name: safe(run.bot.name, 200) ?? "" } : null,
    summary: safe(run.summary, 2000),
    activeMs: Math.min(
      Number.MAX_SAFE_INTEGER,
      run.activeMs + (run.activeSince ? Math.max(0, now - Date.parse(run.activeSince)) : 0),
    ),
    waitingMs: Math.min(
      Number.MAX_SAFE_INTEGER,
      run.waitingMs +
        (run.waitingSince && run.status === "waiting"
          ? Math.max(0, now - Date.parse(run.waitingSince))
          : 0),
    ),
  }));
}

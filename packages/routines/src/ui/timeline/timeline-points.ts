import type { createTranslator, Language } from "@pibot/i18n";
import { avatarColors } from "@pibot/renderer-kit";
import { routineTime } from "../format-time.ts";
import type { RunView } from "./RunHistory.tsx";
import type { PlannedPoint } from "./timeline-data.ts";
import type { useTimelineMetadata } from "./use-timeline-metadata.ts";

export interface TimelinePoint {
  key: string;
  at: string;
  botId: string;
  routineId: string | null;
  position: number;
  future: boolean;
  tone: "bot" | "warn" | "danger" | "neutral";
  run?: RunView;
  planned?: PlannedPoint;
}

export function pointTone(run: RunView): TimelinePoint["tone"] {
  if (run.status === "failed" || run.status === "timeout") return "danger";
  if (run.status === "cancelled" || run.status.startsWith("skipped_")) return "neutral";
  if (run.status === "waiting" || run.status === "missed" || run.reason === "catchup")
    return "warn";
  return "bot";
}

export function timelinePoints(
  runs: readonly RunView[],
  planned: readonly PlannedPoint[],
  position: (at: string) => number,
): TimelinePoint[] {
  return [
    ...runs.map((run) => ({
      key: `run/${run.id}`,
      at: run.scheduledFor,
      botId: run.botId,
      routineId: run.routineId,
      position: position(run.scheduledFor),
      future: run.status === "scheduled",
      tone: pointTone(run),
      run,
    })),
    ...planned.map((point) => ({
      key: `planned/${point.at}/${point.routineId}`,
      at: point.at,
      botId: point.botId,
      routineId: point.routineId,
      position: position(point.at),
      future: true,
      tone: "bot" as const,
      planned: point,
    })),
  ];
}

// Sorted x positions make release order FIFO: O(n log n) sorting and O(n) lane assignment.
export function stackTimelinePoints(points: readonly TimelinePoint[], width: number) {
  const occupied: { x: number; lane: number }[] = [];
  let head = 0;
  let lanes = 0;
  const placed = [...points]
    .sort((a, b) => a.position - b.position || a.key.localeCompare(b.key))
    .map((point) => {
      const x = (point.position / 100) * width;
      const available = occupied[head];
      const lane = available && x - available.x >= 26 ? occupied[head++]?.lane : lanes++;
      const row = lane ?? 0;
      occupied.push({ x, lane: row });
      return { ...point, lane: row };
    });
  return { points: placed, height: Math.max(40, lanes * 26 + 14) };
}

export function timelinePointLabel(
  point: TimelinePoint,
  metadata: Pick<ReturnType<typeof useTimelineMetadata>, "bot" | "routine">,
  t: ReturnType<typeof createTranslator>,
  language: Language,
) {
  const bot = metadata.bot(point.botId);
  const task = point.routineId ? metadata.routine(point.routineId) : undefined;
  const botName = bot
    ? bot.archivedAt
      ? t("routines.timelineArchivedBot", { name: bot.name })
      : bot.name
    : t(bot === null ? "routines.timelineBotUnavailable" : "routines.timelineBotLoading");
  const taskName =
    point.run?.reason === "trial"
      ? t("routines.timelineTrial")
      : task
        ? task.deletedAt
          ? t("routines.timelineDeletedTask", { name: task.name })
          : task.name
        : t(
            task === null || !point.routineId
              ? "routines.timelineTaskUnavailable"
              : "routines.timelineTaskLoading",
          );
  const status = point.run ? t(`routines.status.${point.run.status}`) : t("routines.planned");
  const label = t("routines.timelinePoint", {
    bot: botName,
    task: taskName,
    time: routineTime(point.at, language),
    status: point.run?.reason === "catchup" ? t("routines.timelineCatchup", { status }) : status,
  });
  const color = avatarColors.find((color) => color === bot?.avatarColor) ?? "gray";
  return { label, color };
}

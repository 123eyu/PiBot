import type { TaskSummary } from "@pibot/protocol";
import type { ChipProps, DotState } from "@pibot/ui";

/** One task status reads the same as a dot and as a chip wherever the task appears. */
export function taskDot(status: TaskSummary["status"]): DotState {
  switch (status) {
    case "running":
      return "running";
    case "stopping":
    case "interrupted":
      return "waiting";
    case "done":
      return "done";
    case "error":
      return "failed";
    case "aborted":
      return "stopped";
    default:
      return "queued";
  }
}

export function taskTone(status: TaskSummary["status"]): ChipProps["tone"] {
  switch (status) {
    case "running":
      return "blue";
    case "stopping":
    case "interrupted":
      return "warn";
    case "done":
      return "ok";
    case "error":
      return "danger";
    default:
      return "neutral";
  }
}

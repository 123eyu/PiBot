import type { BackgroundCommand } from "@pibot/protocol";

export function compareBackgroundCommands(a: BackgroundCommand, b: BackgroundCommand) {
  return (
    Number(b.status === "running") - Number(a.status === "running") ||
    Date.parse(b.endedAt ?? b.startedAt) - Date.parse(a.endedAt ?? a.startedAt) ||
    (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  );
}

import { useRpc } from "@pibot/renderer-kit";
import { useBackgroundRows } from "./background-commands.ts";

/** Presentation only; the durable run outcome and its original reason remain untouched. */
export function useBackgroundRun(botId: string | undefined, runId: string | null | undefined) {
  const { peer } = useRpc();
  const rows = useBackgroundRows(peer, botId ?? "", !!botId && !!runId);
  const commands = [...rows.values()].filter((row) => row.runId === runId);
  const pending = commands.some(
    (row) =>
      (row.status === "running" && ["automatic", "waiting"].includes(row.continuation ?? "")) ||
      (row.continuation === "resumed" && !row.continuationFailed),
  );
  const waiting = commands.some(
    (row) =>
      (row.status === "running" && ["automatic", "waiting"].includes(row.continuation ?? "")) ||
      (row.continuation === "resumed" && row.continuationPending),
  );
  return { commands, pending, waiting };
}

import type { BackgroundCommand } from "@pibot/protocol-base";
import { backgroundCompletionTrigger } from "@pibot/storage";
import type { LocalService } from "../../local-service.ts";

export type CompletionRow = Omit<BackgroundCommand, "ports" | "portsVisible">;
export type CompletionBatch = [CompletionRow, ...CompletionRow[]];
export const completionScope = (row: CompletionRow) => `${row.botId}:${row.conversationId}`;
export const backgroundTrigger = (id: string) => `background_finished:${id}`;
export function completionTrigger(rows: CompletionRow[]) {
  return backgroundCompletionTrigger(rows.map((row) => row.id));
}

/** Keep UTF-8 boundaries and tail lines without letting output size grow the prompt. */
export function completionTail(text: string, bytes = 2048) {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const chars = Array.from(lines.slice(-20).join("\n"));
  const kept: string[] = [];
  let size = 0;
  for (const char of chars.reverse()) {
    size += Buffer.byteLength(char);
    if (size > bytes) break;
    kept.push(char);
  }
  return kept.reverse().join("");
}

export function completionNotice(
  local: LocalService,
  rows: CompletionRow[],
  zh: boolean,
  snapshots = new Map<string, string>(),
) {
  let remaining = 8192;
  const references: string[] = [];
  const metadata = rows.map((row) => {
    const outputLines =
      row.outputLines ?? local.background.toolRecord(row.botId, row.id)?.outputLines;
    const outputValue =
      snapshots.get(row.id) ?? local.background.toolOutput(row.botId, row.id, 20_000).output ?? "";
    // Redact again before trimming: a replacement cannot escape the byte budget.
    const output = completionTail(
      local.deps.redactor.redact(outputValue),
      Math.min(2048, Math.max(0, remaining - row.id.length - 4)),
    );
    remaining -= Buffer.byteLength(output);
    if (output) {
      references.push(`${row.id}\n${output}`);
      remaining -= row.id.length + 4;
    }
    const seconds = Math.max(
      0,
      Math.round((Date.parse(row.endedAt ?? row.startedAt) - Date.parse(row.startedAt)) / 1000),
    );
    return `${row.id}: ${zh ? "退出码" : "exit code"} ${row.exitCode ?? "?"}; ${zh ? "停止原因" : "stop reason"} ${row.stopReason ?? "-"}; ${seconds}s; ${zh ? `已输出 ${outputLines ?? "未知"} 行` : `${outputLines ?? "unknown"} output lines`}`;
  });
  const text = [
    zh
      ? "后台命令已结束，请根据结果继续原来的任务。"
      : "Background commands finished. Continue the original task using their results.",
    ...metadata,
    zh
      ? "输出不完整，完整日志用 background_command output 读取。"
      : "Output is incomplete; read the full log with background_command output.",
  ].join("\n");
  return { text, reference: references.join("\n\n") };
}

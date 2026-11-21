import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { toolErrorLog } from "../core/tool-error-log.ts";
import type { LocalToolPorts } from "../core/types.ts";

export function policyExtension(
  ports: LocalToolPorts,
  permits: Map<string, string>,
): ExtensionFactory {
  return (pi) => {
    // Calls whose arguments arrived as invalid JSON: pi then hands the tool `{}` (plus an
    // argumentsError) and Pi Bot's own schema check could only say "path / patch missing", so the
    // model retried the same broken JSON (DeepSeek via OpenRouter, ~every other patch,
    // 2026-11-05). The real cause is told instead. Only the parser's first line is kept: the rest
    // of argumentsError quotes the raw arguments, which may be large or contain file content.
    const invalid = new Map<string, string>();
    pi.on("message_end", (event) => {
      const message = event.message;
      if (message.role !== "assistant") return;
      for (const part of message.content)
        if (part.type === "toolCall" && "argumentsError" in part && part.argumentsError)
          invalid.set(part.id, String(part.argumentsError).split("\n")[0]?.slice(0, 200) ?? "");
    });
    pi.on("tool_call", async (event, ctx) => {
      const call = { id: event.toolCallId, tool: event.toolName, input: event.input };
      const parseError = invalid.get(call.id);
      if (parseError !== undefined) {
        invalid.delete(call.id);
        permits.delete(call.id);
        const reason = ports.redact(
          `工具参数不是合法的 JSON，没有执行（${parseError}）。字符串里的反斜杠要写成 \\\\、换行写成 \\n、双引号写成 \\"；内容很长时分几次写。/ The tool arguments were not valid JSON, so nothing ran (${parseError}). In strings write a backslash as \\\\, a newline as \\n and a double quote as \\"; split very long content into several calls.`,
        );
        ports.blocked(call, reason);
        return { block: true, reason };
      }
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, ports.signal]) : ports.signal;
      let reason = "Tool approval failed / 无法完成工具审批";
      let failed = false;
      try {
        signal.throwIfAborted();
        const result = await ports.authorize(call, signal);
        signal.throwIfAborted();
        if (result.allow) {
          permits.set(call.id, JSON.stringify([call.tool, call.input]));
          return;
        }
        reason = result.reason ?? reason;
      } catch (error) {
        // Raw SDK/policy failures may contain arguments; model-facing errors must be bounded and safe.
        if (signal.aborted) reason = "Stopped / 已停止";
        else {
          // A stop is expected; any other throw is a bug the fixed text would hide from the logs.
          ports.logError?.(toolErrorLog("tool_authorization_failed", call, error));
          failed = true;
          // Windows acceptance 2026-11-20: a check that ran out of time on a busy computer was
          // shown as a refusal and the Bot told the user it was blocked. Nothing was decided.
          if (error instanceof Error && error.name === "TimeoutError")
            reason =
              "The permission check took too long (the computer is busy), so nothing ran. Nothing was refused: try the same step again. / 权限检查超时（电脑太忙），这一步没有执行，也没有被拒绝，请再试一次。";
        }
      }
      permits.delete(call.id);
      ports.blocked(call, reason, failed);
      return { block: true, reason: ports.redact(reason) };
    });
    pi.on("session_shutdown", () => {
      permits.clear();
      invalid.clear();
    });
  };
}

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { LocalToolPorts } from "../core/types.ts";
import type { SessionAdditions } from "../session/session-additions.ts";
import { type CompactionState, registerCompaction } from "./compaction.ts";
import { registerCompactionScheduler } from "./compaction-scheduler.ts";
import { type PromptState, registerPromptContext } from "./prompt-context.ts";
import { redactValue } from "./redact-value.ts";
import { registerToolResultTrim } from "./tool-result-trim.ts";

function textResult(value: unknown): string {
  if (!value || typeof value !== "object" || !("content" in value) || !Array.isArray(value.content))
    return "";
  return value.content
    .flatMap((part: unknown) =>
      part && typeof part === "object" && "text" in part && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("");
}
export function activityExtension(
  ports: LocalToolPorts,
  promptState?: PromptState,
  compaction?: CompactionState,
  additions?: SessionAdditions,
): ExtensionFactory {
  return (pi) => {
    additions?.register(pi);
    registerToolResultTrim(pi, compaction);
    registerPromptContext(pi, promptState);
    registerCompaction(pi, compaction);
    if (compaction) registerCompactionScheduler(pi, compaction, promptState);
    pi.on("tool_execution_start", (e) =>
      ports.activity({
        id: e.toolCallId,
        tool: e.toolName,
        phase: "start",
        input: redactValue(e.args, ports.redact),
      }),
    );
    pi.on("tool_execution_update", (e) =>
      ports.activity({
        id: e.toolCallId,
        tool: e.toolName,
        phase: "output",
        output: ports.redact(textResult(e.partialResult)),
      }),
    );
    pi.on("tool_execution_end", (e) =>
      ports.activity({
        id: e.toolCallId,
        tool: e.toolName,
        phase: "end",
        isError: e.isError,
        durationMs: e.durationMs,
        ...(e.isError && textResult(e.result) === "Tool was not authorized / 工具未获授权"
          ? { failure: "not_authorized" as const }
          : {}),
      }),
    );
    pi.on("tool_result", (e) => {
      // In 1.1.0 tool_result runs before execution_end; classify our exact permit failure before masking it.
      if (e.isError && textResult(e) === "Tool was not authorized / 工具未获授权")
        ports.activity({
          id: e.toolCallId,
          tool: e.toolName,
          phase: "end",
          isError: true,
          failure: "not_authorized",
        });
      return {
        // SDK validation errors can echo entire arguments, including file bodies.
        content: e.isError
          ? [{ type: "text", text: ports.redact(ports.errorText(e.toolCallId)) }]
          : redactValue(e.content, ports.redact),
      };
    });
    pi.on("message_end", (event) => {
      const message = event.message;
      if (message.role === "assistant") {
        // A completed tool-use message may contain the delivery before finish_task executes.
        if (message.stopReason === "stop" || message.stopReason === "toolUse") {
          const text = ports.redact(
            message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join(""),
          );
          if (text.trim()) ports.assistantReply?.(text);
        }
        return;
      }
      if (message.role !== "toolResult") return;
      // Immediate failures (unknown tools / invalid arguments / block) skip tool_result in 1.1.0.
      // This hook updates core state before JSONL persistence and before the next model request.
      const safe = redactValue(message, ports.redact);
      return {
        message: {
          ...safe,
          details: undefined,
          content: message.isError
            ? [{ type: "text", text: ports.redact(ports.errorText(message.toolCallId)) }]
            : safe.content,
        },
      };
    });
  };
}

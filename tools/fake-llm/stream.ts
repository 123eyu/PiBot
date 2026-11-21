import type { ServerResponse } from "node:http";
import type { Reply } from "./scenario.ts";

function usage(reply: Reply) {
  const reasoning = reply.reasoningTokens ?? 0;
  const completion = 20 + (reply.reasoningIncluded ? reasoning : 0);
  return {
    prompt_tokens: reply.promptTokens ?? 10,
    completion_tokens: completion,
    total_tokens: (reply.promptTokens ?? 10) + 20 + reasoning,
    ...(reasoning ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}),
  };
}
const signature = (value?: string) =>
  value ? { extra_content: { google: { thought_signature: value } } } : {};

export function openAIReply(reply: Reply, id: string, model: string): Record<string, unknown> {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: reply.text ?? null,
          ...(reply.toolCalls
            ? {
                tool_calls: reply.toolCalls.map((tool, index) => ({
                  id: tool.id ?? `call_${id}_${index}`,
                  type: "function",
                  function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
                  ...signature(tool.thoughtSignature),
                })),
              }
            : {}),
        },
        finish_reason: reply.toolCalls ? "tool_calls" : (reply.finishReason ?? "stop"),
      },
    ],
    usage: usage(reply),
  };
}

export async function streamReply(
  res: ServerResponse,
  reply: Reply,
  id: string,
  model: string,
  ollama = false,
): Promise<void> {
  res.writeHead(200, {
    "content-type": ollama ? "application/x-ndjson" : "text/event-stream",
    "cache-control": "no-cache",
  });
  if (reply.pauseMs || reply.hang) {
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        res.off("close", finish);
        resolve();
      };
      const timer = setTimeout(finish, reply.pauseMs ?? 120000);
      res.once("close", finish);
    });
    if (res.destroyed) return;
  }
  const deltas: Record<string, unknown>[] = [{ role: "assistant", content: "" }];
  if (reply.text) {
    const points = Array.from(reply.text);
    // Zero-delay fixtures exercise large histories without spending one event per character.
    const size = reply.delayMs === 0 ? 1024 : 1;
    for (let offset = 0; offset < points.length; offset += size)
      deltas.push({ content: points.slice(offset, offset + size).join("") });
  }
  if (reply.toolCalls)
    for (const [index, tool] of reply.toolCalls.entries()) {
      deltas.push({
        tool_calls: [
          {
            index,
            id: tool.id ?? `call_${id}_${index}`,
            type: "function",
            function: { name: tool.name, arguments: "" },
            ...signature(tool.thoughtSignature),
          },
        ],
      });
      const argumentsText = JSON.stringify(tool.arguments);
      for (let offset = 0; offset < argumentsText.length; offset += 16)
        deltas.push({
          tool_calls: [
            { index, function: { arguments: argumentsText.slice(offset, offset + 16) } },
          ],
        });
    }
  const write = async (text: string) => {
    if (res.destroyed) return;
    if (!res.write(text))
      await new Promise<void>((resolve) => {
        const done = () => {
          res.off("drain", done);
          res.off("close", done);
          resolve();
        };
        res.once("drain", done);
        res.once("close", done);
      });
  };
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  for (const delta of deltas) {
    if (res.destroyed) return;
    if (ollama) {
      // Ollama tool arguments are objects, emitted once rather than OpenAI argument fragments.
      if (delta.tool_calls) continue;
      await write(
        `${JSON.stringify({ model, created_at: new Date().toISOString(), message: delta, done: false })}\n`,
      );
    } else await write(chunk(delta));
    if (reply.disconnect === "after_output" && typeof delta.content === "string" && delta.content) {
      // Allow the client to observe bytes before the socket closes; no final usage is sent.
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          res.off("close", done);
          resolve();
        };
        const timer = setTimeout(done, 50);
        res.once("close", done);
      });
      res.destroy();
      return;
    }
    if (reply.delayMs !== 0)
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          res.off("close", done);
          resolve();
        };
        const timer = setTimeout(done, reply.delayMs ?? 5);
        res.once("close", done);
      });
  }
  if (res.destroyed) return;
  if (ollama) {
    if (reply.toolCalls)
      await write(
        `${JSON.stringify({ model, message: { role: "assistant", content: "", tool_calls: reply.toolCalls.map((tool) => ({ function: tool })) }, done: false })}\n`,
      );
    res.end(
      `${JSON.stringify({ model, message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 10, eval_count: 20 })}\n`,
    );
  } else {
    await write(chunk({}, reply.toolCalls ? "tool_calls" : (reply.finishReason ?? "stop")));
    await write(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [], usage: usage(reply) })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  }
}

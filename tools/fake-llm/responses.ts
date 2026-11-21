import type { ServerResponse } from "node:http";
import type { Reply } from "./scenario.ts";

/**
 * Minimal OpenAI Responses SSE (prompt-cache probe): one output item per tool call or text, plus
 * a synthetic encrypted reasoning item so replayed reasoning is part of the next request's input,
 * as it is with the ChatGPT (Codex) backend.
 */
export async function streamResponsesReply(
  res: ServerResponse,
  reply: Reply,
  id: string,
  model: string,
  inputChars: number,
) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const items: Record<string, unknown>[] = [
    {
      type: "reasoning",
      id: `rs_${id}`,
      summary: [],
      encrypted_content: `synthetic-encrypted-${id}`,
    },
  ];
  if (reply.text)
    items.push({
      type: "message",
      id: `msg_${id}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: reply.text, annotations: [] }],
    });
  for (const [index, tool] of (reply.toolCalls ?? []).entries())
    items.push({
      type: "function_call",
      id: `fc_${id}_${index}`,
      call_id: `call_${id}_${index}`,
      name: tool.name,
      arguments: JSON.stringify(tool.arguments),
      status: "completed",
    });
  const event = (value: Record<string, unknown>) => `data: ${JSON.stringify(value)}\n\n`;
  const chunks = [event({ type: "response.created", response: { id: `resp_${id}`, model } })];
  for (const [index, item] of items.entries()) {
    chunks.push(event({ type: "response.output_item.added", output_index: index, item }));
    chunks.push(event({ type: "response.output_item.done", output_index: index, item }));
  }
  const input = reply.promptTokens ?? Math.ceil(inputChars / 4);
  chunks.push(
    event({
      type: "response.completed",
      response: {
        id: `resp_${id}`,
        model,
        status: "completed",
        output: items,
        usage: {
          input_tokens: input,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 20,
          total_tokens: input + 20,
        },
      },
    }),
  );
  res.end(chunks.join(""));
}

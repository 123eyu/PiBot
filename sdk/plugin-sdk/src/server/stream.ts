// An MCP tool server on one already-opened stream (a socket the caller accepted
// and authenticated), so Pi Bot's own `pibot` bridge uses the same SDK adapter as every plugin
// server instead of a second one (domain-boundaries: the MCP server SDK lives only here).
import type { Duplex } from "node:stream";
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

/** One MCP frame larger than this is not a tool call. */
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export type StreamToolResult = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
};

export interface StreamToolServer {
  name: string;
  title?: string;
  version: string;
  listTools(): { name: string; description: string; inputSchema: Record<string, unknown> }[];
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<StreamToolResult>;
}

const CallSchema = z.object({
  name: z.string().min(1).max(128),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Serves `tools/list` and `tools/call` on `stream` until it closes. The caller has paused the
 * stream (and put back anything it read past its own handshake); it is resumed here once the
 * transport listens, so no frame is lost.
 */
export async function serveToolsOnStream(stream: Duplex, tools: StreamToolServer) {
  const server = new Server(
    { name: tools.name, ...(tools.title ? { title: tools.title } : {}), version: tools.version },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler("tools/list", async () => ({
    tools: tools.listTools().map((tool) => ({
      ...tool,
      inputSchema: { ...tool.inputSchema, type: "object" as const },
    })),
  }));
  server.setRequestHandler("tools/call", async (request, ctx) => {
    const params = CallSchema.safeParse(request.params);
    if (!params.success)
      return { content: [{ type: "text", text: "Invalid call / 调用无效" }], isError: true };
    return tools.callTool(params.data.name, params.data.arguments ?? {}, ctx.mcpReq.signal);
  });
  const transport = new StdioServerTransport(stream, stream, { maxBufferSize: MAX_FRAME_BYTES });
  stream.on("close", () => void server.close().catch(() => undefined));
  await server.connect(transport);
  stream.resume();
  return { close: () => server.close() };
}

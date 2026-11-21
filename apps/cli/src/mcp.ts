import { createStdioServer } from "@pibot/plugin-sdk";
import { RpcError } from "@pibot/protocol";
import { z } from "zod";
import type { McpOptions } from "./args.ts";
import { dataDirRefusal } from "./data-dir-guard.ts";
import { createHeadless, HeadlessError } from "./headless.ts";
import { sendMessage } from "./mcp-send.ts";
import { CliError, withDeadline } from "./run.ts";

function toolError(error: unknown) {
  // Neither SDK errors nor application RPC messages are safe to echo: they can quote arguments.
  const code =
    error instanceof HeadlessError || error instanceof CliError
      ? error.code
      : error instanceof RpcError
        ? `rpc_${error.code}`
        : "request_failed";
  return { isError: true, content: [{ type: "text" as const, text: code }] };
}
const result = (value: object) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

/** Explicit local stdio entry: one brain, bounded tools, and a drain on cancellation/disconnect. */
export async function runMcp(options: McpOptions): Promise<number> {
  const refused = await dataDirRefusal(options.dataDir);
  if (refused) {
    process.stderr.write(`pibot mcp: ${refused}\n`);
    return 1;
  }
  const owner = createHeadless(options.dataDir);
  const lifetime = new AbortController();
  const { server, transport } = createStdioServer("pibot");
  const pending = new Set<Promise<unknown>>();
  let busy = false;
  let closing: Promise<void> | undefined;
  let finish: (code: number) => void = () => {};
  const ended = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const close = (code = 0) => {
    lifetime.abort();
    closing ??= Promise.resolve().then(async () => {
      // A stuck native drain cannot keep a disconnected stdio client alive indefinitely. The
      // claim remains on disk; the next process must not assume that shutdown was certified.
      const deadline = setTimeout(() => {
        process.stderr.write("pibot mcp: shutdown_timeout\n");
        process.exit(1);
      }, 10_000);
      deadline.unref();
      let exitCode = code;
      let drained = false;
      try {
        await server.close();
        await Promise.allSettled(pending);
        await owner.stop();
        drained = true;
      } catch {
        process.stderr.write("pibot mcp: shutdown_failed\n");
        exitCode = 1;
      } finally {
        if (drained) clearTimeout(deadline);
        finish(exitCode);
      }
    });
    return closing;
  };
  const invoke = async (signal: AbortSignal, action: (signal: AbortSignal) => Promise<object>) => {
    if (lifetime.signal.aborted || owner.closed) return toolError(new HeadlessError("closed"));
    if (busy) return toolError(new HeadlessError("busy"));
    busy = true;
    const current = AbortSignal.any([
      signal,
      lifetime.signal,
      AbortSignal.timeout(options.timeoutMs),
    ]);
    const work = (async () => {
      try {
        current.throwIfAborted();
        return result(await action(current));
      } catch (error) {
        return toolError(current.aborted ? new HeadlessError("aborted") : error);
      } finally {
        busy = false;
      }
    })();
    pending.add(work);
    try {
      return await work;
    } finally {
      pending.delete(work);
    }
  };
  server.registerTool(
    "list_bots",
    {
      description:
        "List Bot IDs and names in this headless data directory. / 列出本无头数据目录的 Bot。",
      inputSchema: z.strictObject({
        after: z.uuid().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input, ctx) =>
      invoke(ctx.mcpReq.signal, async (signal) => {
        await withDeadline(owner.ready, "startup", Date.now() + options.timeoutMs);
        signal.throwIfAborted();
        const bots = (await owner.client.call("bots.list", {}, { signal })).sort((a, b) =>
          a.id.localeCompare(b.id),
        );
        const remaining = input.after
          ? bots.filter((bot) => bot.id.localeCompare(input.after as string) > 0)
          : bots;
        const items = remaining
          .slice(0, input.limit)
          .map(({ id, name, category }) => ({ id, name, category }));
        return {
          items,
          ...(remaining.length > items.length ? { nextAfter: items.at(-1)?.id } : {}),
        };
      }),
  );
  server.registerTool(
    "send_message",
    {
      description:
        "Send one message to a Bot by ID or exact name and wait for its reply. May execute tools under that Bot's permissions. Headless approval cards are denied. Cancellation stops the run. / 发消息并等待回复；按原权限执行工具，无人审批时拒绝，取消会停止运行。",
      inputSchema: z.strictObject({
        bot: z.string().min(1).max(200),
        message: z
          .string()
          .min(1)
          .max(100_000)
          .refine((text) => text.trim().length > 0),
        newTopic: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (input, ctx) =>
      invoke(ctx.mcpReq.signal, (signal) => sendMessage(owner, options, input, signal)),
  );
  const interrupt = () => {
    void close(130);
  };
  const terminate = () => {
    void close(143);
  };
  server.server.onclose = () => {
    void close();
  };
  server.server.onerror = () => {
    process.stderr.write("pibot mcp: protocol_error\n");
  };
  // Keep handlers installed through the asynchronous drain, including repeated stop signals.
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  void owner.ready.catch((error) => {
    process.stderr.write(`pibot mcp: ${toolError(error).content[0]?.text}\n`);
    return close(1);
  });
  try {
    process.stderr.write(
      "pibot mcp: headless development data only; credentials are unencrypted\n",
    );
    await server.connect(transport);
    return await ended;
  } catch {
    await close(1);
    return 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

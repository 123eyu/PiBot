/*
 * The zod schemas that bound every ACP request Pi Bot accepts while it is the agent (editors drive
 * Pi Bot). The SDK owns framing; these remain the input boundary. Shared with the client side
 * through this package so neither layer depends on the other.
 */
import { z } from "zod";
import { absolutePath } from "../common/path.ts";

export { absolutePath };

const utf8 = new TextEncoder();

export const env = z.strictObject({
  name: z.string().min(1).max(256),
  value: z.string().max(65536),
});
export const command = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\0\r\n]/.test(value), "Invalid command");
export const mcpServer = z.union([
  z.strictObject({
    type: z.literal("stdio").optional(),
    name: z.string().min(1).max(200),
    command,
    args: z.array(z.string().max(16384)).max(256),
    env: z.array(env).max(128),
  }),
  z.strictObject({
    type: z.enum(["http", "sse"]),
    name: z.string().min(1).max(200),
    url: z.url({ protocol: /^https?$/ }),
    headers: z.array(env).max(128),
  }),
]);
export const mcpServers = z
  .array(mcpServer)
  .max(32)
  .superRefine((servers, context) => {
    const names = new Set<string>();
    let bytes = 0;
    const add = (value: string) => {
      // UTF-8 bytes, as before; TextEncoder keeps this leaf free of Node globals.
      bytes += utf8.encode(value).length;
    };
    for (const [index, server] of servers.entries()) {
      if (names.has(server.name))
        context.addIssue({
          code: "custom",
          message: "Duplicate MCP server name",
          path: [index, "name"],
        });
      names.add(server.name);
      add(server.name);
      if ("command" in server) {
        add(server.command);
        for (const value of server.args) add(value);
        for (const value of server.env) {
          add(value.name);
          add(value.value);
        }
      } else {
        add(server.url);
        for (const value of server.headers) {
          add(value.name);
          add(value.value);
        }
      }
    }
    if (bytes > 1024 * 1024)
      context.addIssue({ code: "custom", message: "MCP configuration is too large" });
  });
export const deleteSession = z.object({ sessionId: z.string().min(1).max(200) });
export const loadSession = z.object({
  sessionId: z.string().min(1).max(200),
  cwd: absolutePath,
  additionalDirectories: z.array(absolutePath).max(20).optional(),
  mcpServers,
  // `pibot/autocheck: false` turns automatic checks off in this session's topics (owner
  // 2026-11-05: ACP task topics only; the client checks after each turn). The brain keeps the
  // mark only while it runs, so the client sends it on every new and loaded session.
  _meta: z.object({ "pibot/autocheck": z.boolean().optional() }).nullish(),
});
export const newSession = z.object({
  cwd: absolutePath,
  additionalDirectories: z.array(absolutePath).max(20).optional(),
  mcpServers,
  // Pi Bot extension: start this session's topics in YOLO. Unknown _meta keys stay ignored.
  _meta: z
    .object({
      "pibot/yolo": z.boolean().optional(),
      // Start with this Bot (exact name or id) instead of the ACP default: pibot-dev switched to
      // 小栈 only after session/new had opened a topic for the default Bot, leaving one empty
      // topic there per task (maintainers 2026-11-04).
      "pibot/bot": z.string().min(1).max(200).optional(),
      "pibot/group": z.string().min(1).max(200).optional(),
      "pibot/autocheck": z.boolean().optional(),
      // Work in this existing topic instead of opening one (pibot-dev continues a task's
      // topic). Requires `pibot/bot`; the topic keeps its own YOLO setting and folders.
      "pibot/topic": z.string().min(1).max(200).optional(),
    })
    .nullish(),
});
export const setConfigOption = z.object({
  sessionId: z.string().min(1).max(200),
  configId: z.string().min(1).max(100),
  value: z.string().min(1).max(600),
});
export const prompt = z.object({
  sessionId: z.string().min(1).max(200),
  prompt: z
    .array(
      z.union([
        z.object({ type: z.literal("text"), text: z.string().max(100_000) }),
        z.object({
          type: z.literal("resource_link"),
          name: z.string().min(1).max(1000),
          uri: z.string().min(1).max(32768),
        }),
      ]),
    )
    .max(100),
});
export const permissionOutcome = z.strictObject({
  outcome: z.union([
    z.strictObject({ outcome: z.literal("cancelled") }),
    z.strictObject({ outcome: z.literal("selected"), optionId: z.string().min(1).max(100) }),
  ]),
});

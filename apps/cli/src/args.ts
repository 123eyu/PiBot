import { parseArgs } from "node:util";

const APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;

export type Api = (typeof APIS)[number];

export interface RunOptions {
  dataDir: string;
  message: string;
  bot?: string;
  newTopic: boolean;
  json: boolean;
  timeoutMs: number;
  /**
   * A synthetic OpenAI-compatible endpoint, so a scripted check needs no configured app data.
   * `apiKey` comes from `PIBOT_API_KEY` only (filled in by `main.ts`), never from argv.
   */
  provider?: { baseUrl: string; model: string; apiKey?: string; api: Api; contextWindow: number };
}

/** Same bounds as the eval tools; below the floor a single tool result could exceed the window. */
const CONTEXT_WINDOW = { min: 4_096, max: 4_000_000, default: 128_000 } as const;
export type McpOptions = Pick<RunOptions, "dataDir" | "timeoutMs" | "provider">;
export type AcpOptions = McpOptions;

export type ParsedCommand =
  | { kind: "help" }
  | { kind: "run"; options: RunOptions }
  | { kind: "mcp"; options: McpOptions }
  | { kind: "acp"; options: AcpOptions }
  | { kind: "acp-attach" }
  | { kind: "invalid"; message: string };

export const USAGE = `pibot — headless Pi Bot, developer entry point

用法 / Usage:
  pibot run --data <dir> --message <text> [--bot <id|name>] [--new-topic] [--json] [--timeout <seconds>]
  pibot mcp --data <dir> [--timeout <seconds>] [--base-url <url> --model <id> --api <kind> --context-window <tokens>]
  pibot acp [--data <dir>] [--timeout <seconds>] [--base-url <url> --model <id> --api <kind> --context-window <tokens>]
  MCP: stdio only; list_bots / send_message. 仅显式启动，不监听网络端口。
  ACP: without --data, attach to the running desktop app; --data starts a standalone brain.
       不带 --data 接入正在运行的桌面应用；带 --data 保持独占模式。
  配置假模型 / point at a compatible endpoint:
  pibot run --data <dir> --message <text> --base-url <url> --model <id> [--api <kind>] [--context-window <tokens>]

  端点密钥只从环境变量读取 / the endpoint key is read from PIBOT_API_KEY only:
  PIBOT_API_KEY=... pibot run --data <dir> --message <text> --base-url <url> --model <id>

  数据目录属于本工具独占使用：不要把正在运行的桌面应用的数据目录交给它。
  The data directory must belong to this process alone; never point it at the running app's data.

选项 / Options:
  --data <dir>        数据目录，不存在时创建 / data directory, created when missing
  --message <text>    发给 Bot 的一条消息 / one message to send
  --bot <id|name>     指定 Bot，默认主 Bot / target Bot, defaults to the main Bot
  --new-topic        开新话题 / start a new topic instead of continuing
  --json             每行一个 JSON 事件 / one JSON object per line
  --timeout <sec>     整轮上限，默认 600 / whole-run limit, default 600
  --base-url <url>    先登记该模型端点并设为默认 / register this endpoint as the default model
  --model <id>        端点上的模型 ID / model id on that endpoint
  --api <kind>        ${APIS.join(" | ")}
  --context-window <tokens>
                      该模型的上下文窗口，默认 ${CONTEXT_WINDOW.default}，范围 ${CONTEXT_WINDOW.min}–${CONTEXT_WINDOW.max}；偏小会过早压缩上下文
                      the model's context window, default ${CONTEXT_WINDOW.default}, ${CONTEXT_WINDOW.min}–${CONTEXT_WINDOW.max}; too small compacts early
  -h, --help          显示本说明 / show this help

凭据以明文保存在数据目录，仅用于开发和测试 / credentials are stored unencrypted; development and testing only`;

/** Parsing is total: every rejection comes back as text the caller prints, never a stack trace. */
export function parseCommand(argv: string[]): ParsedCommand {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help" || command === "help")
    return { kind: "help" };
  if (command !== "run" && command !== "mcp" && command !== "acp")
    return { kind: "invalid", message: `Unknown command: ${command}` };
  if (rest.includes("-h") || rest.includes("--help")) return { kind: "help" };
  // A key in argv is visible to `ps` and lands in shell history; the environment is the only channel.
  if (rest.some((arg) => arg === "--api-key" || arg.startsWith("--api-key=")))
    return {
      kind: "invalid",
      message:
        "--api-key is not supported; export PIBOT_API_KEY instead / 不再接受 --api-key，请用环境变量 PIBOT_API_KEY",
    };

  let parsed: { values: Record<string, unknown> };
  try {
    parsed = parseArgs({
      args: rest,
      strict: true,
      allowPositionals: false,
      options: {
        data: { type: "string" },
        message: { type: "string", short: "m" },
        bot: { type: "string" },
        "new-topic": { type: "boolean" },
        json: { type: "boolean" },
        timeout: { type: "string" },
        "base-url": { type: "string" },
        model: { type: "string" },
        api: { type: "string" },
        "context-window": { type: "string" },
      },
    });
  } catch (error) {
    return { kind: "invalid", message: error instanceof Error ? error.message : "Bad arguments" };
  }
  const values = parsed.values;
  const data = values.data;
  const message = values.message;
  if (command === "acp" && data === undefined) {
    if (Object.keys(values).length)
      return {
        kind: "invalid",
        message: "ACP attach accepts no options; use --data for standalone options",
      };
    return { kind: "acp-attach" };
  }
  if (typeof data !== "string" || !data) return { kind: "invalid", message: "--data is required" };
  if (command === "run" && (typeof message !== "string" || !message.trim()))
    return { kind: "invalid", message: "--message must not be empty" };
  if (typeof message === "string" && message.length > 100_000)
    return { kind: "invalid", message: "--message is too long" };
  if (
    (command === "mcp" || command === "acp") &&
    ["message", "bot", "new-topic", "json"].some((key) => values[key] !== undefined)
  )
    return {
      kind: "invalid",
      message: `${command} accepts --data, --timeout and model endpoint options only`,
    };
  const timeout = values.timeout === undefined ? 600 : Number(values.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 3600)
    return { kind: "invalid", message: "--timeout must be between 1 and 3600 seconds" };

  const baseUrl = typeof values["base-url"] === "string" ? values["base-url"] : undefined;
  const model = typeof values.model === "string" ? values.model : undefined;
  if (!!baseUrl !== !!model)
    return { kind: "invalid", message: "--base-url and --model go together" };
  const api = values.api === undefined ? "openai-completions" : String(values.api);
  if (!(APIS as readonly string[]).includes(api))
    return { kind: "invalid", message: `--api must be one of ${APIS.join(", ")}` };
  if (values["context-window"] !== undefined && !baseUrl)
    return { kind: "invalid", message: "--context-window goes with --base-url and --model" };
  const contextWindow =
    values["context-window"] === undefined
      ? CONTEXT_WINDOW.default
      : Number(values["context-window"]);
  if (
    !Number.isInteger(contextWindow) ||
    contextWindow < CONTEXT_WINDOW.min ||
    contextWindow > CONTEXT_WINDOW.max
  )
    return {
      kind: "invalid",
      message: `--context-window must be an integer between ${CONTEXT_WINDOW.min} and ${CONTEXT_WINDOW.max}`,
    };
  let provider: RunOptions["provider"];
  if (baseUrl && model) {
    const url = URL.parse(baseUrl);
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:"))
      return { kind: "invalid", message: "--base-url must be an http(s) URL" };
    provider = {
      baseUrl,
      model,
      api: api as Api,
      contextWindow,
    };
  }

  const shared = {
    dataDir: data,
    timeoutMs: Math.round(timeout * 1000),
    ...(provider ? { provider } : {}),
  };
  if (command === "mcp") return { kind: "mcp", options: shared };
  if (command === "acp") return { kind: "acp", options: shared };
  return {
    kind: "run",
    options: {
      ...shared,
      message: message as string,
      newTopic: values["new-topic"] === true,
      json: values.json === true,
      ...(typeof values.bot === "string" && values.bot ? { bot: values.bot } : {}),
    },
  };
}

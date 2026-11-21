import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Json = Record<string, unknown>;
type Digest = Record<string, string>;
type MessageRow = { id: string; status: string };
type DigestFixture = {
  cleanup(): Promise<void>;
  main: { id: string };
  group: { id: string };
  client: {
    call<T>(method: string, params: Record<string, unknown>): Promise<T>;
  };
  blocked(): number;
};
type ChatHarness = {
  fixture(
    scenario: unknown,
    root: string,
    providers: Record<string, unknown>,
    options: Record<string, unknown>,
    hooks: { onRequest(body: Json, route: string): void },
  ): Promise<DigestFixture>;
  groupIdle(fixture: DigestFixture): Promise<void>;
  until<T>(label: string, read: () => Promise<T>, done: (value: T) => boolean): Promise<T>;
};

const baselinePath = join(dirname(fileURLToPath(import.meta.url)), "tool-plane-baseline.json");

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function toolName(tool: Json): string {
  const nested = tool.function;
  const name =
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Json).name
      : tool.name;
  if (typeof name !== "string" || !name) throw new Error("模型请求里有未命名的工具声明");
  return name;
}

function toolDescription(tool: Json): string | undefined {
  const nested = tool.function;
  const description =
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Json).description
      : tool.description;
  return typeof description === "string" ? description : undefined;
}

function digestRequest(scope: "dm" | "group", body: Json): Digest {
  if (!Array.isArray(body.tools)) throw new Error(`${scope} 首次模型请求没有 tools 数组`);
  const output: Digest = {};
  for (const raw of body.tools) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error(`${scope} 首次模型请求有无效工具声明`);
    const tool = raw as Json;
    const name = toolName(tool);
    const key = `${scope}:${name}`;
    if (output[key]) throw new Error(`${scope} 首次模型请求有重复工具：${name}`);
    output[key] = hash(tool);
    if (name === "tool_discover") {
      const description = toolDescription(tool);
      if (description === undefined) throw new Error(`${scope} 的 tool_discover 没有说明`);
      output[`${key}#description`] = hash(description);
    }
  }
  if (!output[`${scope}:tool_discover#description`])
    throw new Error(`${scope} 首次模型请求没有 tool_discover`);
  return output;
}

async function capture(): Promise<Digest> {
  for (const name of Object.keys(process.env)) {
    if (!["PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR"].includes(name))
      delete process.env[name];
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), "pibot-tool-plane-")));
  // The repository uses TypeScript syntax beyond Node's strip-only loader. Reuse the same Vite
  // jiti loader as the cache acceptance probe instead of introducing another transpiler.
  const desktop = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
  const vite = createRequire(desktop.resolve("vite/package.json"));
  const { createJiti } = vite("jiti") as {
    createJiti(
      base: string | URL,
      options: { fsCache: boolean },
    ): {
      import(path: string): Promise<unknown>;
    };
  };
  const loader = createJiti(import.meta.url, { fsCache: false });
  const { fixture, groupIdle, until } = (await loader.import(
    "../../tests/e2e/chat/harness.ts",
  )) as ChatHarness;
  let phase: "setup" | "dm" | "group" = "setup";
  const captured = new Map<"dm" | "group", Json>();
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const f = await fixture(
      {
        replies: [{ text: "TOOL-PLANE fallback" }],
        routes: {
          coordinator: [
            { text: "TOOL-PLANE direct message complete." },
            { text: "TOOL-PLANE group message complete." },
          ],
        },
      },
      root,
      {},
      {},
      {
        onRequest(body, route) {
          if (route !== "coordinator" || phase === "setup" || captured.has(phase)) return;
          captured.set(phase, structuredClone(body));
        },
      },
    );
    cleanup = f.cleanup;
    phase = "dm";
    const dm = await f.client.call<{ conversationId: string; assistantMessageId: string }>(
      "chat.send",
      {
        botId: f.main.id,
        text: "TOOL-PLANE capture the default direct-message tool table.",
      },
    );
    await until(
      "默认 Bot 私聊完成",
      () =>
        f.client.call<MessageRow[]>("chat.history", {
          botId: f.main.id,
          topicId: dm.conversationId,
        }),
      (rows) => rows.some((row) => row.id === dm.assistantMessageId && row.status !== "streaming"),
    );

    phase = "group";
    await f.client.call("chat.send", {
      groupId: f.group.id,
      text: "TOOL-PLANE capture the default group tool table.",
    });
    await groupIdle(f);
    if (f.blocked() !== 0) throw new Error("工具摘要演练尝试访问假模型以外的网络地址");

    const dmRequest = captured.get("dm");
    const groupRequest = captured.get("group");
    if (!dmRequest || !groupRequest) throw new Error("没有捕获到私聊和群聊的首次模型请求");
    return Object.fromEntries(
      Object.entries({
        ...digestRequest("dm", dmRequest),
        ...digestRequest("group", groupRequest),
      }).sort(([a], [b]) => a.localeCompare(b)),
    );
  } finally {
    await cleanup?.();
    await rm(root, { recursive: true, force: true });
  }
}

function differences(expected: Digest, actual: Digest): string[] {
  const names = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .flatMap((name) => {
      if (!(name in expected)) return [`+ ${name}`];
      if (!(name in actual)) return [`- ${name}`];
      return expected[name] === actual[name] ? [] : [`~ ${name}`];
    });
}

const update = process.argv.includes("--update");
const check = process.argv.includes("--check") || !update;
const unknown = process.argv.slice(2).filter((arg) => arg !== "--check" && arg !== "--update");
if (unknown.length || (update && process.argv.includes("--check")))
  throw new Error("用法：pnpm tool-plane:digest [--check|--update]");

const actual = await capture();
if (update) {
  await writeFile(baselinePath, `${JSON.stringify(actual, null, 2)}\n`, "utf8");
  console.log(`已更新工具平面摘要：${Object.keys(actual).length} 项`);
} else if (check) {
  const expected = JSON.parse(await readFile(baselinePath, "utf8")) as Digest;
  const diff = differences(expected, actual);
  if (diff.length) {
    console.error(["工具平面摘要与基线不一致：", ...diff].join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`工具平面摘要与基线一致：${Object.keys(actual).length} 项`);
  }
}

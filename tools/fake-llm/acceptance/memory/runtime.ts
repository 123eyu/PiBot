import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { cliHost } from "../../../../apps/cli/src/host.ts";
import { portPair } from "../../../../apps/cli/src/port-pair.ts";
import { ModelRuntime } from "../../../../packages/agent/node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js";
import { startBrain } from "../../../../packages/brain-app/src/index.ts";
import { createLocalExecutionTarget, ExecError } from "../../../../packages/execution/src/index.ts";
import {
  createPeer,
  Events,
  type MethodParams,
  Methods,
  RpcError,
} from "../../../../packages/protocol/src/index.ts";
import { createRedactor, withNamedRedaction } from "../../../../packages/secrets/src/index.ts";
import { toolLoadGroup } from "../../../../tests/e2e/product-tool-groups.ts";
import { ephemeralSecrets } from "../../../dev/memory-secrets.ts";
import { priceEvalProvider } from "../../../dev/model-pricing.ts";
import { startFakeLlm } from "../../index.ts";
import type { Reply, Scenario } from "../../scenario.ts";
import { withToolDiscovery } from "../../tool-discovery.ts";
import type { budget, Options } from "./options.ts";
import { extractionReplyShape, type RequestObservation, requestObservation } from "./requests.ts";
import { realRelay } from "./transport.ts";

export { ProbeFailure, requireThat } from "./assert.ts";

import { ProbeFailure, requireThat } from "./assert.ts";
export async function until<T>(
  read: () => Promise<T>,
  ready: (v: T) => boolean,
  signal: AbortSignal,
) {
  for (;;) {
    signal.throwIfAborted();
    const v = await read();
    if (ready(v)) return v;
    await delay(100, undefined, { signal });
  }
}
export type Ledger = ReturnType<typeof budget>;
function fakeExecution(root: string) {
  const local = createLocalExecutionTarget({
    files: { journalDir: join(root, "data", "file-patches") },
    command: {
      platform: process.platform,
      env: {},
      systemHome: root,
      tempDir: root,
      redactor: withNamedRedaction(createRedactor()),
    },
  });
  const deny = async () => {
    throw new ExecError("isolation_unavailable");
  };
  // Memory acceptance exercises the real kernel and policy, but needs no command host.
  return {
    ...local,
    isolationStatus: async () => ({ available: false, reason: "platform_unsupported" }),
    runCommand: deny,
    startBackground: deny,
  };
}

export async function runtime(root: string, o: Options, ledger: Ledger, signal: AbortSignal) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const routes: Record<string, Reply[]> = {
    task: [],
    member: [],
    extraction: [],
    organization: [],
    other: [],
  };
  const scenario: Scenario = { replies: [{ text: "收到。" }], routes };
  const consumed = new Map<string, number>();
  const enqueue = (route: string, replies: Reply[]) => {
    const queue = routes[route];
    if (!queue || replies.length === 0) return;
    // A group's follow-up can already have consumed a fallback after the previous script.
    // Append at the next reachable index, keeping any scripted replies still queued.
    queue.length = Math.max(queue.length, consumed.get(route) ?? 0);
    queue.push(...replies);
  };
  let script = 0;
  const requests: RequestObservation[] = [];
  const extractionReplies: {
    index: number;
    valid: boolean;
    candidates: number;
    dropped: number;
  }[] = [];
  const results: { tool: string; text: string }[] = [];
  const lifecycle = new AbortController();
  const markers: string[] = [];
  const observe = (body: Record<string, unknown>) => {
    requireThat(requests.length < 200, "request_limit");
    requests.push(requestObservation(body, requests.length + 1, markers));
  };
  const cipher = ephemeralSecrets();
  const restorePricing = priceEvalProvider(ModelRuntime, "Memory acceptance", o.pricing);
  const ports = portPair();
  const client = createPeer(ports[1], { methods: Methods, events: Events });
  const release = client.on("chat.tool", (e) => {
    if (e.phase === "output" && e.output && results.length < 500)
      results.push({ tool: e.tool, text: e.output });
  });
  let fake: Awaited<ReturnType<typeof startFakeLlm>> | undefined;
  let relay: Awaited<ReturnType<typeof realRelay>> | undefined;
  let brain: Awaited<ReturnType<typeof startBrain>> | undefined;
  let db: DatabaseSync | undefined;
  let startup = "model_transport";
  const close = async () => {
    lifecycle.abort();
    try {
      // Workers abort their network calls, then persist terminal rows before brain closes SQLite.
      if (db)
        await until(
          async () =>
            Number(
              db
                ?.prepare(
                  "SELECT (SELECT count(*) FROM memory_extractions WHERE status='running') + (SELECT count(*) FROM memory_organizations WHERE status='running') AS n",
                )
                .get()?.n ?? 0,
            ),
          (n) => n === 0,
          AbortSignal.timeout(10_000),
        );
    } finally {
      try {
        await brain?.stop();
      } finally {
        db?.close();
        release();
        client.dispose();
        try {
          await fake?.stop();
          await relay?.stop();
        } finally {
          restorePricing();
          cipher.dispose();
        }
      }
    }
  };
  try {
    if (!o.real)
      fake = await startFakeLlm({
        port: 0,
        scenario,
        logDirectory: join(root, "http"),
        route: (body) => {
          const kind = requestObservation(body, 0).kind;
          return kind === "chat" ? (body.model === "member" ? "member" : "task") : kind;
        },
        observe(body, route, index) {
          observe(body);
          consumed.set(route, index + 1);
          if (route === "extraction")
            extractionReplies.push({
              index: index + 1,
              ...extractionReplyShape(routes.extraction?.[index]),
            });
        },
      });
    // SDK modules may retain their own fetch; observe at the actual HTTP receiving boundary.
    if (o.real)
      relay = await realRelay(
        o.baseUrl!,
        ledger,
        observe,
        AbortSignal.any([signal, lifecycle.signal]),
      );
    const baseUrl = relay?.url ?? `${fake!.url}/v1`;
    const brainOptions: Parameters<typeof startBrain>[0] = {
      port: ports[0],
      dataDir: join(root, "data"),
      version: "a47-memory-acceptance",
      platform: process.platform,
      host: { ...cliHost({ pickFolder: async () => root }), secrets: cipher.secrets },
    };
    startup = "brain";
    const start = () =>
      startBrain({ ...brainOptions, ...(!o.real ? { executionTarget: fakeExecution(root) } : {}) });
    brain = await start();
    startup = "database";
    db = new DatabaseSync(join(root, "data", "pibot.db"), { readOnly: true });
    startup = "settings";
    await client.call("settings.set", { language: "zh" });
    await client.call("permissions.set", {
      levels: {
        run_command: "never",
        connector: "never",
        computer: "never",
        read_file: "never",
        list_dir: "never",
        write_file: "never",
        read_ai_config: "never",
        read_messages: "always",
        send_out: "never",
        web: "never",
      },
    });
    startup = "bots";
    const bots = await client.call("bots.list", {});
    // Create fixture Bots before configuring the auxiliary model (no persona-generation request).
    const a = await client.call("bots.create", { description: "合成记忆验收甲" });
    const b = await client.call("bots.create", { description: "合成记忆验收乙" });
    for (const bot of [...bots, a, b])
      await client.call("bots.update", { botId: bot.id, memoryExtraction: false });
    startup = "provider";
    const provider = await client.call("customProviders.upsert", {
      id: "memory-acceptance",
      name: "Memory acceptance",
      baseUrl,
      api: o.real ? o.api : "openai-completions",
      apiKey: o.real ? o.key! : "synthetic-only",
      ...(o.real ? { headers: o.headers } : {}),
      models: o.real
        ? [{ id: o.model!, contextWindow: 1_000_000, maxTokens: 2048 }]
        : [
            { id: "task", contextWindow: 1_000_000, maxTokens: 2048 },
            { id: "aux", contextWindow: 65536, maxTokens: 2048 },
            { id: "small", contextWindow: 32768, maxTokens: 2048 },
            { id: "member", contextWindow: 1_000_000, maxTokens: 2048 },
          ],
    });
    const modelId = o.real ? o.model! : "task";
    await client.call("settings.set", {
      defaultModel: { provider: provider.id, id: modelId, thinkingLevel: "off" },
      auxiliaryModel: { provider: provider.id, id: o.real ? modelId : "aux" },
    });
    for (const bot of [a, b])
      await client.call("bots.update", {
        botId: bot.id,
        modelProvider: provider.id,
        modelId,
        thinkingLevel: "off",
        systemPrompt: "按用户要求使用工具完成任务。不要凭空猜测记忆内容。",
      });
    // Every approval is answered; only the memory and history read tools may be approved.
    let approvalTask: Promise<void> | undefined;
    let restarting = false;
    const approvalTimer = setInterval(() => {
      if (approvalTask || restarting) return;
      approvalTask = client
        .call("approvals.pending", {})
        .then(async (rows) => {
          for (const row of rows)
            await client.call("approvals.resolve", {
              id: row.id,
              decision: ["read_messages", "memory_search", "memory_read"].includes(row.category)
                ? "allow"
                : "deny",
              remember: false,
            });
        })
        .catch(() => {
          /* A card can settle before the poll's answer; the turn assertion detects refusal. */
        })
        .finally(() => {
          approvalTask = undefined;
        });
    }, 100);
    approvalTimer.unref();
    const originalClose = close;
    const rpc: typeof client.call = async (method, params, options) => {
      try {
        return await client.call(method, params, options);
      } catch (error) {
        if (signal.aborted) throw error;
        // Method names are fixture constants; never forward remote messages or parameters.
        throw new ProbeFailure(
          `rpc_${method}_${error instanceof RpcError ? error.code : "fixture_failed"}`,
        );
      }
    };
    const archive = async <M extends "topics.archive" | "groups.topics.archive">(
      method: M,
      params: MethodParams[M],
    ) => {
      // Message completion precedes run-queue cleanup. Only archive's explicit busy refusal
      // is transient; preserve every other failure and the enclosing case's deadline.
      await until(
        async () => {
          try {
            await client.call(method, params, { signal });
            return true;
          } catch (error) {
            if (error instanceof RpcError && error.code === -32011) return false;
            throw error;
          }
        },
        Boolean,
        signal,
      );
    };
    return {
      client,
      rpc,
      archive,
      db,
      a: a.id,
      b: b.id,
      requests,
      extractionReplies,
      results,
      provider: provider.id,
      memberModelId: o.real ? modelId : "member",
      /** Later requests record whether each of these strings occurs in them (case 8). */
      watch(values: readonly string[]) {
        markers.splice(0, markers.length, ...values);
      },
      setMemberScript(replies: Reply[]) {
        enqueue("member", withToolDiscovery(replies, toolLoadGroup));
      },
      setScript(task: Reply[], auxiliary: Reply[] = [], organization: Reply[] = []) {
        enqueue("task", withToolDiscovery(task, toolLoadGroup));
        enqueue("extraction", auxiliary);
        enqueue("organization", organization);
        script++;
      },
      async restart(seed?: (fixture: DatabaseSync) => void) {
        restarting = true;
        try {
          await approvalTask;
          await brain?.stop();
          brain = undefined;
          if (seed) {
            const fixture = new DatabaseSync(join(root, "data", "pibot.db"));
            try {
              seed(fixture);
            } finally {
              fixture.close();
            }
          }
          brain = await start();
        } finally {
          restarting = false;
        }
      },
      async close() {
        clearInterval(approvalTimer);
        await approvalTask;
        await originalClose();
      },
      async turn(botId: string, text: string, newTopic = true) {
        const sent = await rpc(
          "chat.send",
          {
            botId,
            text,
            ...(newTopic ? { newTopic: true } : {}),
          },
          { signal },
        );
        const history = await until(
          () => client.call("chat.history", { botId, limit: 50 }, { signal }),
          (rows) =>
            rows.some(
              (r) =>
                r.id === sent.assistantMessageId && ["done", "error", "aborted"].includes(r.status),
            ),
          signal,
        );
        const message = history.find((r) => r.id === sent.assistantMessageId)!;
        requireThat(message.status === "done", `turn_${script}_failed`);
        const topic = db!
          .prepare("SELECT conversation_id AS id FROM messages WHERE id=?")
          .get(message.id);
        requireThat(topic, "topic_missing");
        return { message, topicId: String(topic.id), runId: sent.runId };
      },
    };
  } catch (e) {
    await close();
    if (signal.aborted) throw e;
    throw new ProbeFailure(`startup_${startup}${e instanceof RpcError ? `_rpc_${e.code}` : ""}`);
  }
}
export type Runtime = Awaited<ReturnType<typeof runtime>>;

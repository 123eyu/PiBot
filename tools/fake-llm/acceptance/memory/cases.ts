import { randomUUID } from "node:crypto";
import {
  GENERAL_TOOLS,
  ToolCallRecordSchema,
} from "../../../../packages/protocol-base/src/index.ts";
import type { Reply } from "../../scenario.ts";
import { receiptSummary } from "./receipts.ts";
import { type Runtime, requireThat, until } from "./runtime.ts";

const say = (text = "收到。"): Reply => ({ text });
const call = (name: string, args: Record<string, unknown>): Reply => ({
  toolCalls: [{ name, arguments: args }],
});
const owner = (botId: string) => ({ scope: "bot" as const, ownerId: botId });

async function seed(r: Runtime, count: number, text: (n: number) => string) {
  const ids: string[] = [];
  for (let n = 1; n <= count; n++) {
    const result = await r.client.call("memory.manage", {
      ...owner(r.a),
      confirmed: true,
      change: { action: "import", text: text(n), category: "work" },
    });
    requireThat(result.status === "added" && result.memory, "seed_not_added");
    ids.push(result.memory.id);
  }
  return ids;
}

export async function recall(r: Runtime) {
  // Round B 2026-11-11: with 「细节」+hex a real model answered the hex alone (「细节」 read as the
  // word "detail"). An ASCII code, as in the group case, is one token the model keeps verbatim.
  const detail = `DTL1${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const ids = await seed(
    r,
    60,
    (n) =>
      `条目${n} 项目索引${String(n).padStart(3, "0")}。${"背景说明只用于形成目录摘要。".repeat(5)}${n === 45 ? `检索标识四十五的专用校验值是${detail}。` : `本条专用参数编号${n}。`}`,
  );
  const rows = await r.client.call("memory.list", { botId: r.a, ...owner(r.a), limit: 100 });
  requireThat(rows.length === 60, "seed_count");
  r.setScript([
    call("memory_search", { query: "检索标识四十五", scope: "bot" }),
    call("memory_read", { id: ids[44]!, scope: "bot" }),
    say(detail),
  ]);
  const start = r.requests.length;
  const turn = await r.turn(
    r.a,
    "请用 memory_search 搜索检索标识四十五，再用 memory_read 读全文，回答其专用校验值。目录摘要里没有它，不要猜。",
  );
  const chats = r.requests.slice(start).filter((request) => request.kind === "chat");
  requireThat(chats.length > 0, "recall_chat_request_missing");
  const missing = chats.filter((request) => !request.catalog);
  requireThat(
    missing.length === 0,
    `catalog_missing_requests_${missing
      .slice(0, 12)
      .map((request) => `${request.index}_chat_tools_${request.tools}`)
      .join("_")}`,
  );
  const trace = r.db
    .prepare(
      "SELECT t.tool, t.status FROM tool_calls t JOIN messages m ON m.id=t.message_id WHERE m.run_id=? ORDER BY t.rowid LIMIT 64",
    )
    .all(turn.runId);
  for (const tool of ["memory_search", "memory_read"])
    requireThat(
      trace.some((t) => t.tool === tool && t.status === "done"),
      `recall_trace_missing_${tool}_actual_${
        trace
          .slice(0, 20)
          .map((t) => {
            // Model-provided unknown names and database text must not become diagnostics.
            const name = GENERAL_TOOLS.find((name) => name === t.tool) ?? "unknown_tool";
            const status = ToolCallRecordSchema.shape.status.safeParse(t.status);
            return `${name}:${status.success ? status.data : "unknown_status"}`;
          })
          .join(",") || "none"
      }`,
    );
  requireThat(turn.message.content.includes(detail), "recall_detail_missing");
}

export async function history(r: Runtime) {
  const shared = `话题${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const hidden = `乙私聊${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  r.setScript([say(), say(), say()]);
  const original = await r.turn(r.a, `${shared}：原话题讨论下月选择周三开项目会。`);
  await r.turn(r.a, "第二个话题只讨论午餐。");
  await r.turn(r.b, `${shared}：${hidden}，只对乙可见的私聊内容。`);
  r.setScript([
    call("read_messages", { mode: "search", query: shared }),
    call("read_messages", { mode: "search", query: hidden }),
    say("已完成历史检索。"),
  ]);
  const start = r.results.length;
  await r.turn(
    r.a,
    `用 read_messages 的 search 模式搜索“${shared}”的原话题并给链接，再把“乙私聊”和“${hidden.slice(3)}”拼成一个关键词搜索（不要带引号和空格），只报告你有权访问的结果。`,
  );
  const outputs = r.results
    .slice(start)
    .filter((t) => t.tool === "read_messages")
    .map((t) => t.text);
  const structured = outputs.flatMap((text) => {
    const from = text.indexOf('{"mode":"search"');
    if (from < 0) return [];
    try {
      return [
        JSON.parse(text.slice(from)) as {
          items: {
            conversationId: string;
            link: string;
            snippet: string;
            source: { botId?: string };
          }[];
        },
      ];
    } catch {
      return [];
    }
  });
  requireThat(structured.length >= 2, "history_search_outputs_missing");
  requireThat(
    structured.some((s) =>
      s.items.some(
        (i) =>
          i.conversationId === original.topicId &&
          i.source.botId === r.a &&
          i.link.includes(original.topicId) &&
          i.snippet.includes("周三"),
      ),
    ),
    "own_topic_or_link_missing",
  );
  requireThat(
    structured.every((s) =>
      s.items.every((i) => i.source.botId !== r.b && !i.snippet.includes(hidden)),
    ),
    "other_bot_leaked",
  );
  requireThat(
    structured.some((s) => s.items.length === 0),
    "private_query_not_empty",
  );
}

export async function organization(r: Runtime, signal: AbortSignal) {
  const ids = await seed(r, 45, (n) =>
    n < 4
      ? `周报偏好版本${n}：${n === 3 ? "最新决定先给结论再列要点" : "过去先写背景，再给结论"}。`
      : `独立项目${n}：长期跟踪编号${String(n).padStart(4, "0")}的交付事项。`,
  );
  r.setScript(
    [],
    [],
    [
      say(
        JSON.stringify({
          proposals: [
            {
              action: "merge",
              ids: ids.slice(0, 3),
              text: "周报采用最新约定：先给结论，再列要点。",
              category: "work",
              why: "合并重复和过时约定",
              how: "起草周报时采用",
            },
          ],
        }),
      ),
    ],
  );
  // Production's first organization scan is 90 s; do not shorten it or call private drains.
  const before = await r.client.call("memory.browse", { ...owner(r.a), state: "all" });
  requireThat(before.items.length === 45, "organization_seed_count");
  await until(
    async () =>
      r.db
        .prepare(
          "SELECT status FROM memory_organizations WHERE bot_id=? ORDER BY rowid DESC LIMIT 1",
        )
        .get(r.a),
    (row) => !!row && !["queued", "running"].includes(String(row.status)),
    signal,
  );
  const pending = (
    await r.client.call("memory.browse", { ...owner(r.a), state: "all" })
  ).proposals.filter((p) => p.status === "pending");
  requireThat(pending.length >= 2, "organization_merge_proposals_missing");
  requireThat(
    (await r.client.call("memory.browse", { ...owner(r.a), state: "all" })).items.every(
      (m) => !m.archivedAt,
    ),
    "organization_changed_without_consent",
  );
  for (const p of pending)
    await r.client.call("memory.resolve", { proposalId: p.id, accept: true });
  const merged = await r.client.call("memory.browse", { ...owner(r.a), state: "all" });
  requireThat(merged.items.filter((m) => !m.archivedAt).length < 45, "organization_not_merged");
  const visible = new Set(merged.undoable.map((p) => p.id));
  requireThat(
    pending.every((p) => visible.has(p.id)),
    `organization_undo_missing_visible_${pending.filter((p) => visible.has(p.id)).length}_${receiptSummary(
      r,
      pending.map((p) => p.id),
    )}`,
  );
  // Reverse application order: merge's update snapshot may depend on its prior removals.
  for (const p of [...pending].reverse())
    await r.client.call("memory.resolve", { proposalId: p.id, accept: false });
  const restored = await r.client.call("memory.browse", { ...owner(r.a), state: "all" });
  requireThat(
    restored.items.length === before.items.length &&
      before.items.every((old) =>
        restored.items.some(
          (m) => m.id === old.id && m.text === old.text && m.archivedAt === old.archivedAt,
        ),
      ),
    "organization_undo_mismatch",
  );
}

export async function contextHint(r: Runtime) {
  r.setScript([
    { text: "已阅读长话题。", promptTokens: 40000 },
    { text: "收到短话题。", promptTokens: 1000 },
  ]);
  const long = await r.turn(r.a, `请只回复已阅读。${"项目历史事项与讨论。".repeat(5000)}`);
  const short = await r.turn(r.b, "你好，今天讨论午餐。");
  for (const botId of [r.a, r.b])
    await r.client.call("bots.update", { botId, modelProvider: r.provider, modelId: "small" });
  requireThat(
    (await r.client.call("chat.contextHint", { botId: r.a, conversationId: long.topicId })).show,
    "long_hint_missing",
  );
  requireThat(
    !(await r.client.call("chat.contextHint", { botId: r.b, conversationId: short.topicId })).show,
    "short_hint_unexpected",
  );
}

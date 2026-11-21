import { randomUUID } from "node:crypto";
import type { Memory } from "../../../../packages/protocol-base/src/index.ts";
import type { Reply } from "../../scenario.ts";
import { type Runtime, requireThat, until } from "./runtime.ts";

const say = (text = "收到。请继续确认约定。 "): Reply => ({ text });
const call = (name: string, args: Record<string, unknown>): Reply => ({
  toolCalls: [{ name, arguments: args }],
});
function sameNotes(current: { items: Memory[] }, baseline: { items: Memory[] }) {
  return (
    current.items.length === baseline.items.length &&
    baseline.items.every((old) =>
      current.items.some(
        (item) =>
          item.id === old.id && item.text === old.text && item.archivedAt === old.archivedAt,
      ),
    )
  );
}
async function turn(r: Runtime, groupId: string, botId: string, text: string, signal: AbortSignal) {
  const sent = await r.rpc(
    "chat.send",
    { groupId, text: `@${botId} ${text}`, mentions: [botId] },
    { signal },
  );
  requireThat(
    r.db.prepare("SELECT bot_id FROM runs WHERE id=?").get(sent.runId)?.bot_id === botId,
    "group_turn_wrong_bot",
  );
  await until(
    async () => r.db.prepare("SELECT status FROM runs WHERE id=?").get(sent.runId),
    (row) => !!row && ["done", "error", "aborted"].includes(String(row.status)),
    signal,
  );
  requireThat(
    r.db.prepare("SELECT status FROM runs WHERE id=?").get(sent.runId)?.status === "done",
    "group_turn_failed",
  );
  return sent;
}

async function memberStep(
  r: Runtime,
  groupId: string,
  memoryId: string,
  detail: string,
  signal: AbortSignal,
) {
  const start = r.requests.length;
  r.setScript([
    call("assign_task", {
      bot: r.b,
      title: "读取群约定",
      instructions:
        "只用 memory_search 搜索群共识校验，再用 memory_read 读对应的群约定。回答完整校验值，不猜测，不写文件，不调用其他工具。",
    }),
    { text: "已交给成员读取群约定。" },
  ]);
  r.setMemberScript([
    call("memory_search", { query: "群共识校验", scope: "group" }),
    call("memory_read", { id: memoryId, scope: "group" }),
    { text: detail },
  ]);
  await turn(
    r,
    groupId,
    r.a,
    "请用 assign_task 分派给另一位成员：读取本群已保存的群共识校验约定，搜索后按需读全文，只回答完整校验值，不需要操作文件。",
    signal,
  );
  const run = await until(
    async () =>
      r.db
        .prepare(
          "SELECT id,status,message_id FROM runs WHERE group_id=? AND bot_id=? AND task_id IS NOT NULL ORDER BY rowid DESC LIMIT 1",
        )
        .get(groupId, r.b),
    (row) => !!row && ["done", "error", "aborted"].includes(String(row.status)),
    signal,
  );
  requireThat(run?.status === "done", "group_member_step_failed");
  const traces = r.db
    .prepare(
      "SELECT t.tool,t.status FROM tool_calls t JOIN messages m ON m.id=t.message_id WHERE m.run_id=?",
    )
    .all(String(run.id));
  for (const tool of ["memory_search", "memory_read"])
    requireThat(
      traces.some((trace) => trace.tool === tool && trace.status === "done"),
      "group_member_recall_trace_missing",
    );
  requireThat(
    String(
      r.db.prepare("SELECT content FROM messages WHERE id=?").get(String(run.message_id))?.content,
    ).includes(detail),
    "group_member_detail_missing",
  );
  await until(
    async () =>
      Number(
        r.db
          .prepare(
            "SELECT count(*) AS n FROM runs WHERE group_id=? AND status IN ('queued','running')",
          )
          .get(groupId)?.n ?? 0,
      ),
    (count) => count === 0,
    signal,
  );
  const chats = r.requests.slice(start).filter((request) => request.kind === "chat");
  requireThat(
    chats.length > 0 && chats.every((request) => request.catalog),
    "group_member_catalog_missing",
  );
}

export async function groupMemory(r: Runtime, signal: AbortSignal) {
  await r.rpc("bots.update", { botId: r.b, modelId: r.memberModelId });
  for (const mode of ["ask", "auto"] as const) {
    await r.rpc("bots.update", { botId: r.a, memoryMode: mode, memoryExtraction: true });
    const group = await r.rpc("groups.create", {
      name: `群记忆验收${mode}`,
      botIds: [r.a, r.b],
      coordinatorBotId: r.a,
    });
    const owner = { scope: "group" as const, ownerId: group.id };
    // Work notes exceed the full-injection allowance, exercising the actual group catalog.
    for (let n = 0; n < 16; n++)
      await r.rpc("memory.manage", {
        ...owner,
        confirmed: true,
        change: {
          action: "import",
          category: "work",
          text: `群资料条目${n}。${"这只是独立背景资料，不代表任何已确认的风格或分工决定。".repeat(7)}`,
        },
      });
    r.setMemberScript([{ text: "未确认中间产出：假设所有群报告都只用红色，等待负责人确认。" }]);
    const unconfirmed = await turn(
      r,
      group.id,
      r.b,
      "请先给一条候选建议，这还不是最终群约定，不写入记忆。",
      signal,
    );
    // An ASCII code like real ticket/channel IDs: the product keeps such identifiers verbatim,
    // while a CJK word glued to it ("校验…") is prose the model may legitimately rephrase.
    const detail = `CHK7${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const agreement = `以后本群所有周报都先写结论，再用三条要点；这是持续使用的群共识校验约定。${"固定背景说明。".repeat(8)}完整校验值是${detail}。`;
    r.setScript([say(), say()]);
    await turn(
      r,
      group.id,
      r.a,
      `${agreement}先只口头讨论，不调用记忆写入工具，稍后归档时再提炼。`,
      signal,
    );
    const confirmed = await turn(
      r,
      group.id,
      r.a,
      `确认：${agreement}这条以后一直适用于本群，不采用之前未确认的成员建议。先只口头确认，不调用记忆写入工具，稍后归档时再提炼。`,
      signal,
    );
    const baseline = await r.rpc("memory.browse", { ...owner, state: "all" });
    const before = new Set(
      [...baseline.proposals, ...baseline.undoable].map((proposal) => proposal.id),
    );
    r.setScript(
      [],
      [
        {
          text: JSON.stringify({
            candidates: [
              {
                action: "add",
                scope: "group",
                category: "work",
                // The auto round replays the 2026-11-11 real failure: a shortened note that drops
                // the exact value. The program must restore the identifier from the statement.
                text:
                  mode === "auto"
                    ? "以后本群所有周报都先写结论，再用三条要点；这是持续使用的群共识约定。"
                    : agreement,
                sourceMessageId: confirmed.userMessageId,
              },
              {
                action: "add",
                scope: "group",
                category: "work",
                text: "未确认中间产出不应写入群记忆",
                sourceMessageId: unconfirmed.assistantMessageId,
              },
            ],
          }),
        },
      ],
    );
    await r.archive("groups.topics.archive", {
      groupId: group.id,
      topicId: group.conversationId,
    });
    await r.restart();
    const extraction = await until(
      async () =>
        r.db
          .prepare(
            "SELECT status,candidates FROM memory_extractions WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1",
          )
          .get(group.conversationId),
      (row) => !!row && !["queued", "running"].includes(String(row.status)),
      signal,
    );
    requireThat(
      extraction?.status === "done" && Number(extraction.candidates) > 0,
      `group_extraction_${mode}_failed`,
    );
    let page = await r.rpc("memory.browse", { ...owner, state: "all" });
    // Browse separates pending proposals from accepted, reversible operations.
    const proposals = (mode === "ask" ? page.proposals : page.undoable).filter(
      (proposal) => !before.has(proposal.id),
    );
    requireThat(
      proposals.length > 0 &&
        proposals.every((proposal) => proposal.scope === "group" && proposal.ownerId === group.id),
      "group_proposal_scope_missing",
    );
    requireThat(
      !proposals.some((proposal) => proposal.messageId === unconfirmed.assistantMessageId),
      "group_unconfirmed_source_applied",
    );
    if (mode === "ask") {
      requireThat(
        sameNotes(page, baseline) && proposals.every((proposal) => proposal.status === "pending"),
        "group_ask_wrote_before_confirmation",
      );
      for (const proposal of proposals)
        await r.rpc("groups.memory.resolve", {
          groupId: group.id,
          proposalId: proposal.id,
          accept: true,
        });
      page = await r.rpc("memory.browse", { ...owner, state: "all" });
    } else
      requireThat(
        proposals.every((proposal) => proposal.status === "accepted"),
        "group_auto_not_applied",
      );
    const note = page.items.find((item) => item.text.includes(detail));
    requireThat(note && !note.archivedAt, "group_extracted_note_missing");
    await r.rpc("groups.topics.create", {
      groupId: group.id,
      inheritWorkspace: true,
      requestId: randomUUID(),
    });
    await memberStep(r, group.id, note.id, detail, signal);
    const remaining = new Set(proposals.map((proposal) => proposal.id));
    while (remaining.size) {
      // Undoing a later edit can make an earlier snapshot current again; UUID order is not time.
      const current = await r.rpc("memory.browse", { ...owner, state: "all" });
      const receipt = current.undoable.find((item) => remaining.has(item.id));
      requireThat(
        receipt,
        `group_undo_receipt_missing_${mode}_remaining_${remaining.size}_undo_${current.undoable.length}_proposals_${current.proposals.length}`,
      );
      await r.rpc("groups.memory.resolve", {
        groupId: group.id,
        proposalId: receipt.id,
        accept: false,
      });
      remaining.delete(receipt.id);
    }
    const after = await r.rpc("memory.browse", { ...owner, state: "all" });
    requireThat(sameNotes(after, baseline), "group_undo_not_restored");
    await r.rpc("bots.update", { botId: r.a, memoryExtraction: false });
  }
}

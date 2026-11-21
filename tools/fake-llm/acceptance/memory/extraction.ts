import { setTimeout as delay } from "node:timers/promises";
import type { Reply } from "../../scenario.ts";
import { sixHours } from "./idle.ts";
import { type Runtime, requireThat, until } from "./runtime.ts";

const say = (text = "收到。"): Reply => ({ text });
const owner = (botId: string) => ({ scope: "bot" as const, ownerId: botId });
const user = { scope: "user" as const, ownerId: "user" };
async function pages(r: Runtime, botId: string) {
  return Promise.all(
    [owner(botId), user].map((o) => r.rpc("memory.browse", { ...o, state: "all" })),
  );
}
function sameItems(
  current: Awaited<ReturnType<typeof pages>>,
  baseline: Awaited<ReturnType<typeof pages>>,
) {
  return current.every((page, index) => {
    const expected = baseline[index]?.items ?? [];
    return (
      page.items.length === expected.length &&
      expected.every((old) =>
        page.items.some(
          (item) =>
            item.id === old.id && item.text === old.text && item.archivedAt === old.archivedAt,
        ),
      )
    );
  });
}
async function extractionDone(
  r: Runtime,
  topicId: string,
  mode: "ask" | "auto",
  signal: AbortSignal,
) {
  const read = async () =>
    r.db
      .prepare(
        "SELECT status, reason, candidates, model_id FROM memory_extractions WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(topicId);
  let row: Awaited<ReturnType<typeof read>>;
  let timedOut = false;
  try {
    row = await until(
      read,
      (row) => !!row && !["queued", "running"].includes(String(row.status)),
      signal,
    );
  } catch (error) {
    if (!signal.aborted) throw error;
    timedOut = true;
    row = await read();
  }
  const status = ["queued", "running", "done", "failed", "skipped"].includes(String(row?.status))
    ? String(row?.status)
    : "unknown";
  const reason = ["idle", "archive"].includes(String(row?.reason))
    ? String(row?.reason)
    : "unknown";
  const requests = r.requests.filter((request) => request.kind === "extraction");
  const replies = r.extractionReplies;
  const lastReply = replies.at(-1);
  const draft = lastReply
    ? lastReply.valid
      ? `valid_${lastReply.candidates}_dropped_${lastReply.dropped}`
      : "invalid"
    : "unobserved";
  const model = row?.model_id === "aux" ? "aux" : row?.model_id === "task" ? "task" : "other";
  requireThat(
    !timedOut && row?.status === "done" && Number(row.candidates) > 0,
    `extraction_${mode}_timeout_${Number(timedOut)}_status_${status}_reason_${reason}_candidates_${Number(row?.candidates ?? 0)}_model_${model}_requests_${requests.map((request) => request.index).join("_") || "none"}_draft_${draft}`,
  );
}
async function undo(
  r: Runtime,
  botId: string,
  proposalIds: readonly string[],
  baseline: Awaited<ReturnType<typeof pages>>,
) {
  const groups = await pages(r, botId);
  const ids = new Set(proposalIds);
  const receipts = groups.flatMap((g) => g.undoable.filter((p) => ids.has(p.id)));
  requireThat(
    proposalIds.length > 0 && receipts.length === proposalIds.length,
    "undo_extraction_receipt_missing",
  );
  for (const receipt of receipts)
    await r.rpc("memory.resolve", { proposalId: receipt.id, accept: false });
  const after = await pages(r, botId);
  requireThat(sameItems(after, baseline), "undo_not_restored_extraction_scope");
}

function proposalIds(r: Runtime, botId: string) {
  return new Set(
    r.db
      .prepare("SELECT id FROM scoped_memory_proposals WHERE bot_id=?")
      .all(botId)
      .map((row) => String(row.id)),
  );
}

export async function extraction(r: Runtime, root: string, signal: AbortSignal) {
  const preference = "我写周报时偏好先给结论，再用三条要点，不用长篇铺垫。";
  const aux = (text: string): Reply =>
    say(
      `提取完成：\n\`\`\`json\n${JSON.stringify({
        memories: [
          {
            action: "add",
            scope: "bot",
            category: "work",
            text,
            why: "用户重复表达的周报偏好",
            how: "写周报时采用",
            confidence: 0.98,
          },
        ],
      })}\n\`\`\``,
    );
  for (const [mode, botId] of [
    ["ask", r.a],
    ["auto", r.b],
  ] as const) {
    await r.rpc("bots.update", { botId, memoryMode: mode, memoryExtraction: true });
    r.setScript([say(), say()], [aux(`${preference}${mode === "auto" ? "也适用于月报。" : ""}`)]);
    // Keep this fixture focused on post-hoc extraction. A real model is allowed to use
    // memory_add during an ordinary chat, but doing so would make a zero-candidate extraction
    // indistinguishable from a successful no-op and leave nothing for the extraction undo check.
    const first = await r.turn(botId, `${preference}先只讨论，不调用记忆工具，稍后由后台提炼。`);
    await r.turn(
      botId,
      "对，我平时一直这样写，这个风格以后也一样。先只讨论，不调用记忆工具，稍后由后台提炼。",
      false,
    );
    // A real model may call memory_add during the conversation. Those user-requested notes are
    // outside post-hoc extraction and must survive undo; only proposal IDs created afterward are
    // part of this case's reversible extraction scope.
    const baseline = await pages(r, botId);
    const proposalsBeforeExtraction = proposalIds(r, botId);
    if (mode === "ask") await sixHours(r.db, root, first.topicId);
    await r.archive("topics.archive", { botId, topicId: first.topicId });
    await r.restart();
    await extractionDone(r, first.topicId, mode, signal);
    const extractedProposalIds = [...proposalIds(r, botId)].filter(
      (id) => !proposalsBeforeExtraction.has(id),
    );
    let current = await pages(r, botId);
    if (mode === "ask") {
      requireThat(sameItems(current, baseline), "ask_wrote_before_confirmation");
      const pending = current
        .flatMap((p) => p.proposals)
        .filter((p) => p.status === "pending" && extractedProposalIds.includes(p.id));
      requireThat(pending.length > 0, "ask_proposal_missing");
      for (const p of pending) await r.rpc("memory.resolve", { proposalId: p.id, accept: true });
      current = await pages(r, botId);
    }
    requireThat(
      current.some((p) => p.items.some((m) => !m.archivedAt)),
      "extraction_not_written",
    );
    requireThat(
      !current.some((p) =>
        p.proposals.some((p) => p.status === "pending" && extractedProposalIds.includes(p.id)),
      ),
      "auto_or_confirmation_pending",
    );
    await undo(r, botId, extractedProposalIds, baseline);
    await r.rpc("bots.update", { botId, memoryExtraction: false });
  }
  r.setScript([say(), say()]);
  const off = await r.turn(r.a, "我平时希望报告有明确标题，每周都需要。");
  await r.turn(r.a, "以后周报月报也一直用清楚的标题。", false);
  const disabledBaseline = await pages(r, r.a);
  const disabledProposals = proposalIds(r, r.a);
  await r.archive("topics.archive", { botId: r.a, topicId: off.topicId });
  await r.restart();
  await delay(7000, undefined, { signal });
  requireThat(
    !r.db.prepare("SELECT 1 FROM memory_extractions WHERE conversation_id=?").get(off.topicId),
    "disabled_extracted",
  );
  requireThat(
    sameItems(await pages(r, r.a), disabledBaseline) &&
      [...proposalIds(r, r.a)].every((id) => disabledProposals.has(id)),
    "disabled_created_memory",
  );
}

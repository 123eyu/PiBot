import { randomUUID } from "node:crypto";
import type { Reply } from "../../scenario.ts";
import { type Runtime, requireThat, until } from "./runtime.ts";

const say = (text = "收到。"): Reply => ({ text });
const call = (name: string, args: Record<string, unknown>): Reply => ({
  toolCalls: [{ name, arguments: args }],
});
const user = { scope: "user" as const, ownerId: "user" };
const bot = (botId: string) => ({ scope: "bot" as const, ownerId: botId });
const hex = () => randomUUID().replaceAll("-", "").slice(0, 12);
// Digits only: a hex-looking tag would itself be a commit-hash work marker.
const digits = () =>
  String(Math.floor(Math.random() * 1e12))
    .padStart(12, "7")
    .slice(0, 12);

async function importUser(r: Runtime, text: string) {
  const result = await r.rpc("memory.manage", {
    ...user,
    confirmed: true,
    change: { action: "import", text, category: "about_you" },
  });
  requireThat(result.status === "added" && result.memory, "user_seed_not_added");
  return result.memory;
}

function receipt(r: Runtime, messageId: string): string[] {
  const row = r.db.prepare("SELECT usage FROM messages WHERE id=?").get(messageId);
  const usage = row?.usage ? (JSON.parse(String(row.usage)) as { memoryIds?: unknown }) : {};
  return Array.isArray(usage.memoryIds) ? usage.memoryIds.map(String) : [];
}

async function extractionFinished(r: Runtime, topicId: string, signal: AbortSignal) {
  const row = await until(
    async () =>
      r.db
        .prepare(
          "SELECT status, candidates FROM memory_extractions WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1",
        )
        .get(topicId),
    (row) => !!row && !["queued", "running"].includes(String(row.status)),
    signal,
  );
  requireThat(
    row?.status === "done" && Number(row.candidates) > 0,
    `scope_extraction_${["done", "failed", "skipped"].includes(String(row?.status)) ? String(row?.status) : "unknown"}`,
  );
}

/**
 * Case 8 (maintainers 2026-11-11): many shared user notes reach a chat only up to the fixed budget, in a
 * stable order; the rest stay addressable through the catalog and keyword recall; a work fact
 * extracted by a non-main Bot lands in that Bot's own scope, not the shared user scope.
 */
export async function userBudget(r: Runtime, signal: AbortSignal) {
  const seeds: { id: string; createdAt: string; head: string; tail: string }[] = [];
  for (let n = 1; n <= 20; n++) {
    const head = `关于你第${n}条`;
    const tail = `尾标${hex()}`;
    const memory = await importUser(
      r,
      `${head}：${"长期偏好说明只用于验证常驻预算，各条长度保持一致。".repeat(3)}${tail}。`,
    );
    seeds.push({ id: memory.id, createdAt: memory.createdAt, head, tail });
  }
  const ordered = [...seeds].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1,
  );
  r.watch(seeds.flatMap((seed) => [seed.head, seed.tail]));
  r.setScript([say(), say(), say()]);
  const turn = async (text: string) => {
    const start = r.requests.length;
    const result = await r.turn(r.a, text);
    const chats = r.requests.slice(start).filter((request) => request.kind === "chat");
    requireThat(chats.length > 0, "budget_chat_request_missing");
    return { ids: receipt(r, result.message.id), request: chats.at(-1)! };
  };
  const plain = "请简单回复收到。";
  const first = await turn(plain);
  const second = await turn(plain);
  const k = first.ids.length;
  requireThat(k > 0 && k < seeds.length, `budget_resident_count_${k}`);
  // The resident set is the oldest k notes, identical on the next turn (prompt-cache stability).
  const resident = new Set(ordered.slice(0, k).map((seed) => seed.id));
  requireThat(
    first.ids.every((id) => resident.has(id)),
    "budget_resident_not_oldest_prefix",
  );
  requireThat(
    second.ids.length === k && second.ids.every((id) => resident.has(id)),
    "budget_resident_unstable",
  );
  const index = new Map(seeds.map((seed, i) => [seed.id, i]));
  for (const seed of seeds) {
    const i = index.get(seed.id)!;
    const [head, tail] = [first.request.markers[i * 2], first.request.markers[i * 2 + 1]];
    if (resident.has(seed.id)) requireThat(!!tail, "budget_resident_text_missing");
    else requireThat(!!head && !tail, "budget_rest_not_catalog_only");
  }
  const last = ordered.at(-1)!;
  requireThat(!resident.has(last.id), "budget_fixture_last_resident");
  const recalled = await turn(`请简单回复收到。参考 ${last.tail.slice(2)}`);
  requireThat(
    recalled.ids.includes(last.id) && !!recalled.request.markers[(index.get(last.id) ?? 0) * 2 + 1],
    "budget_over_note_not_recalled",
  );
  r.watch([]);

  // A work fact told to a non-main Bot: extracted into that Bot's scope, not the shared one.
  const tag = `demo-${hex()}`;
  const fact = `仓库在 ~/code/${tag}；提交前先跑 pnpm run check`;
  await r.rpc("bots.update", { botId: r.b, memoryMode: "auto", memoryExtraction: true });
  r.setScript(
    [say(), say()],
    [
      say(
        JSON.stringify({
          candidates: [{ action: "add", scope: "user", category: "about_you", text: fact }],
        }),
      ),
    ],
  );
  const topic = await r.turn(
    r.b,
    `我们的仓库在 ~/code/${tag}，提交前先跑 pnpm run check。先只讨论，不调用记忆工具，稍后由后台提炼。`,
  );
  await r.turn(r.b, "对，这个仓库一直这样做。先只讨论，不调用记忆工具。", false);
  await r.archive("topics.archive", { botId: r.b, topicId: topic.topicId });
  await r.restart();
  await extractionFinished(r, topic.topicId, signal);
  const own = await r.rpc("memory.browse", { ...bot(r.b), state: "all" });
  const shared = await r.rpc("memory.browse", { ...user, state: "all" });
  requireThat(
    own.items.some((m) => m.text.includes(tag) && !m.archivedAt),
    "work_fact_not_in_bot_scope",
  );
  requireThat(!shared.items.some((m) => m.text.includes(tag)), "work_fact_in_user_scope");
  await r.rpc("bots.update", { botId: r.b, memoryExtraction: false });
}

function moveProposals(r: Runtime, noteId: string) {
  return r.db
    .prepare(
      "SELECT id FROM scoped_memory_proposals WHERE scope='user' AND action='remove' AND memory_id=?",
    )
    .all(noteId)
    .map((row) => String(row.id));
}

/**
 * Case 9 (fake model only; it scripts a chat memory_add into the user scope): existing user notes
 * from a non-main Bot that carry work markers get move proposals at startup, rule-only. Nothing
 * moves until confirmed, no text is lost when the Bot already has a similar (not identical) note,
 * the automatic organization model run cannot propose moves, and undo restores both scopes.
 */
export async function scopeMoves(r: Runtime, signal: AbortSignal) {
  await r.rpc("bots.update", { botId: r.a, memoryMode: "auto" });
  const path = `~/srv/app-${hex()}`;
  const w1 = `部署脚本在 ~/srv/deploy-${hex()}/run.sh，发布前先跑 pnpm run verify。`;
  // Similar to the Bot's own note but not identical: only the file extension differs.
  const similar = (ext: string) =>
    `发布前要在 ${path}/deploy.${ext} 里先改版本号，再跑 pnpm run release，然后通知值班同事核对发布清单和回滚步骤，最后在群里同步结果。`;
  const [w3, w3Bot] = [similar("ts"), similar("js")];
  const w4 = `测试库连接走 ssh ops@db-${hex()}.internal，只读账号。`;
  const w2 = `开源版每批改动先合进内部主干，再同步到公开仓库，批次${digits()}。`;
  const p = `用户喜欢简短直接的回答，编号${digits()}。`;
  const code = `用户偏好用 \`中文\` 交流，编号${digits()}。`;
  // Same text as the Bot's note, but only the shared copy carries a why: it must survive the move.
  const w5 = `回滚记录写在 ~/srv/rollback-${hex()}/notes.md，按日期追加。`;
  const why5 = `来源说明${digits()}`;
  // The Bot's identical copy is archived: not a live copy, so no delete-only move.
  const w6 = `日志在 ~/srv/logs-${hex()}/app.log，按小时轮转。`;
  // A preference stated for every Bot stays shared, even with a file name in it.
  const wide = `用户希望所有 Bot 的示例统一用 example-${digits()}.ts。`;
  const seeded = new Map<string, Awaited<ReturnType<typeof importUser>>>();
  for (const text of [w3Bot, w4, w5, w6]) {
    const added = await r.rpc("memory.manage", {
      ...bot(r.a),
      confirmed: true,
      change: { action: "import", text, category: "work" },
    });
    requireThat(added.status === "added" && added.memory, "move_bot_seed_not_added");
    seeded.set(text, added.memory);
  }
  const archived = seeded.get(w6);
  requireThat(!!archived, "move_bot_seed_not_added");
  if (archived)
    await r.rpc("memory.manage", {
      ...bot(r.a),
      confirmed: true,
      change: { action: "archive", id: archived.id, expected: archived, archived: true },
    });
  r.setScript([
    ...[w1, w3, w4, w2, p, code, w6, wide].map((text) =>
      call("memory_add", { scope: "user", category: "about_you", text }),
    ),
    call("memory_add", { scope: "user", category: "about_you", text: w5, why: why5 }),
    say("已记下。"),
  ]);
  await r.turn(r.a, "请把这几条按我说的原样记到 user 范围。");
  const main = await importUser(r, `构建产物在 ~/build/out-${hex()}/app.js，由我自己维护。`);
  // Organization runs for a scope with at least eight notes changed since its last run.
  for (let n = 1; n <= 3; n++) await importUser(r, `补充偏好${n}：${digits()}，回答先给结论。`);
  const notes = (await r.rpc("memory.browse", { ...user, state: "all" })).items;
  const find = (text: string) => notes.find((m) => m.text === text)?.id ?? "";
  const ids = [w1, w3, w4, w5, w2, p, code, w6, wide].map(find);
  const [
    id1 = "",
    id3 = "",
    id4 = "",
    id5 = "",
    id2 = "",
    idP = "",
    idCode = "",
    id6 = "",
    idWide = "",
  ] = ids;
  requireThat(ids.length === 9 && ids.every(Boolean), "move_seed_memory_add_missing");
  // The automatic organization run is not owner-started: a scripted `move` must not be accepted.
  r.setScript([], [], [say(JSON.stringify({ proposals: [{ action: "move", ids: [id2] }] }))]);
  const before = (await r.rpc("memory.browse", { ...user, state: "all" })).items;
  const botBefore = (await r.rpc("memory.browse", { ...bot(r.a), state: "all" })).items;
  await r.restart();
  for (const id of [id1, id3, id4, id5])
    requireThat(moveProposals(r, id).length === 1, "move_startup_proposal_missing");
  for (const id of [id2, idP, idCode, main.id, idWide])
    requireThat(moveProposals(r, id).length === 0, "move_startup_overreach");
  requireThat(moveProposals(r, id6).length === 0, "move_archived_copy_counted_live");
  // Production's first organization scan is 90 s after start; wait for it like case 4.
  await until(
    async () =>
      r.db
        .prepare(
          "SELECT status FROM memory_organizations WHERE scope='user' ORDER BY rowid DESC LIMIT 1",
        )
        .get(),
    (row) => !!row && !["queued", "running"].includes(String(row.status)),
    signal,
  );
  requireThat(moveProposals(r, id2).length === 0, "move_model_without_owner");
  const pending = [
    ...(await r.rpc("memory.browse", { ...user, state: "all" })).proposals,
    ...(await r.rpc("memory.browse", { ...bot(r.a), state: "all" })).proposals,
  ]
    .filter((proposal) => proposal.status === "pending")
    .sort((a, b) => Number(a.scope === "user") - Number(b.scope === "user"));
  // w1: add + remove; w3: rewrite keeping both texts + remove; w4: identical, remove only;
  // w5: same text, the Bot's note gains the moved why + remove.
  requireThat(pending.length === 7, `move_pending_count_${pending.length}`);
  const w5Bot = seeded.get(w5)?.id;
  requireThat(
    pending.some((proposal) => proposal.action === "update" && proposal.memoryId === w5Bot),
    "move_metadata_rewrite_missing",
  );
  const similarId = botBefore.find((m) => m.text === w3Bot)?.id;
  requireThat(
    pending.some(
      (proposal) =>
        proposal.action === "update" &&
        proposal.memoryId === similarId &&
        proposal.text.includes(w3) &&
        proposal.text.includes(w3Bot),
    ),
    "move_similar_not_rewritten_with_both",
  );
  const unchanged = (await r.rpc("memory.browse", { ...user, state: "all" })).items;
  requireThat(
    unchanged.length === before.length &&
      (await r.rpc("memory.browse", { ...bot(r.a), state: "all" })).items.length ===
        botBefore.length,
    "move_applied_without_consent",
  );
  for (const proposal of pending)
    await r.rpc("memory.resolve", { proposalId: proposal.id, accept: true });
  const movedUser = (await r.rpc("memory.browse", { ...user, state: "all" })).items;
  const movedBot = (await r.rpc("memory.browse", { ...bot(r.a), state: "all" })).items;
  requireThat(!movedUser.some((m) => [id1, id3, id4, id5].includes(m.id)), "move_user_copy_kept");
  // Every moved text, and the Bot's own similar note, still exists in the Bot's scope.
  requireThat(
    [w1, w3, w3Bot, w4, w5].every((text) =>
      movedBot.some((m) => m.text.includes(text) && !m.archivedAt),
    ),
    "move_text_lost",
  );
  requireThat(
    movedBot.some((m) => m.id === w5Bot && m.text === w5 && (m.why ?? "").includes(why5)),
    "move_metadata_lost",
  );
  for (const proposal of [...pending].reverse())
    await r.rpc("memory.resolve", { proposalId: proposal.id, accept: false });
  const restored = (await r.rpc("memory.browse", { ...user, state: "all" })).items;
  const botRestored = (await r.rpc("memory.browse", { ...bot(r.a), state: "all" })).items;
  const same = (
    now: readonly { id: string; text: string; archivedAt?: string | null }[],
    old: readonly { id: string; text: string; archivedAt?: string | null }[],
  ) =>
    now.length === old.length &&
    old.every((o) =>
      now.some(
        (m) =>
          m.id === o.id && m.text === o.text && (m.archivedAt ?? null) === (o.archivedAt ?? null),
      ),
    );
  requireThat(same(restored, before) && same(botRestored, botBefore), "move_undo_mismatch");
  // Idempotent: a person who was asked once (here: accepted, then undid) is not asked again.
  await r.restart();
  requireThat(
    [id1, id3, id4, id5].every((id) => moveProposals(r, id).length === 1),
    "move_reproposed_after_restart",
  );
}

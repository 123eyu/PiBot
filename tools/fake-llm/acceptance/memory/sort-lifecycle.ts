import { randomUUID } from "node:crypto";
import { startMemorySort } from "../../../../apps/desktop/src/renderer/features/app-menu/memory-sort-run.ts";
import { Methods, RpcError } from "../../../../packages/protocol/src/index.ts";
import { type Runtime, requireThat, until } from "./runtime.ts";

const user = { scope: "user" as const, ownerId: "user" };

/** Real management deletes, plus an orphan fixture proving CAS does not depend on the move link. */
export async function sortProposalLifecycle(r: Runtime, signal: AbortSignal, mainId: string) {
  const owner = { scope: "bot" as const, ownerId: mainId };
  for (const mode of ["clear", "remove", "orphan"] as const) {
    const text = {
      clear: "发布流程：负责人先审查内部版本，批准后再同步到公开仓库。",
      remove: "数据库维护：管理员每周检查备份，并在隔离环境中验证恢复。",
      orphan: "产品设计：研究员按月汇总访谈资料，由设计师整理交互规范。",
    }[mode];
    const original = await r.rpc("memory.manage", {
      ...owner,
      confirmed: true,
      change: { action: "import", text, category: "work" },
    });
    const shared = await r.rpc("memory.manage", {
      ...user,
      confirmed: true,
      change: { action: "import", text, category: "about_you" },
    });
    requireThat(original.memory && shared.memory, "sort_lifecycle_seed_missing");
    const targetId = original.memory.id;
    const sourceId = shared.memory.id;
    await r.restart((db) => {
      db.prepare("UPDATE scoped_memories SET why=?,how=? WHERE id=?").run(
        "Bot 原有原因",
        "Bot 原有方法",
        targetId,
      );
      db.prepare("UPDATE scoped_memories SET why=?,how=? WHERE id=?").run(
        "共享原因",
        "共享方法",
        sourceId,
      );
    });
    const notes = (await r.rpc("memory.browse", { ...user, state: "active" })).items;
    const replies = [];
    for (let i = 0; i < notes.length; i += 8)
      replies.push({
        text: JSON.stringify({
          classifications: notes.slice(i, i + 8).map((m) => ({
            id: m.id,
            kind: m.id === sourceId ? "work" : "personal",
          })),
        }),
      });
    r.setScript([], [], replies);
    const sorted = await r.rpc("memory.sortIntoPlace", {
      ownerInitiated: true,
      runId: randomUUID(),
    });
    requireThat(sorted.moves === 1, "sort_lifecycle_move_missing");
    const link = r.db.prepare("SELECT * FROM memory_scope_moves WHERE source_id=?").get(sourceId);
    requireThat(link?.target_proposal_id, "sort_lifecycle_link_missing");
    const proposalId = String(link.target_proposal_id);
    const snapshot = () =>
      r.db
        .prepare(
          "SELECT status,scope_move_target_before_json FROM scoped_memory_proposals WHERE id=?",
        )
        .get(proposalId);
    requireThat(snapshot()?.scope_move_target_before_json, "sort_lifecycle_cas_missing");
    const page = await r.rpc("memory.browse", { ...user, state: "active" });
    const source = page.items.find((m) => m.id === sourceId);
    requireThat(source, "sort_lifecycle_source_missing");
    if (mode === "clear")
      await r.rpc("memory.manage", {
        ...user,
        confirmed: true,
        change: { action: "clear", expectedRevision: page.revision },
      });
    else if (mode === "remove")
      await r.rpc("memory.manage", {
        ...user,
        confirmed: true,
        change: { action: "remove", id: sourceId, expected: source },
      });
    else
      await r.restart((db) => {
        // Simulate an old leftover pending rewrite after its dependency disappeared.
        db.prepare("DELETE FROM memory_scope_moves WHERE source_id=?").run(sourceId);
      });
    requireThat(
      snapshot()?.scope_move_target_before_json &&
        (mode === "orphan" || snapshot()?.status === "rejected"),
      "sort_lifecycle_destination_not_expired",
    );
    if (mode === "clear")
      requireThat(
        !r.db.prepare("SELECT 1 FROM memory_scope_moves WHERE source_id=?").get(sourceId),
        "sort_lifecycle_clear_link_survived",
      );
    const target = (await r.rpc("memory.browse", { ...owner, state: "active" })).items.find(
      (m) => m.id === targetId,
    );
    requireThat(target, "sort_lifecycle_target_missing");
    // The orphan case changes only why/how: guarding text alone must not allow this rewrite.
    const later = mode === "orphan" ? target.text : `${text} 后来增加了新的人工审核要求。`;
    const why = "用户后来补充的原因";
    const how = "用户后来补充的方法";
    await r.rpc("memory.update", {
      botId: mainId,
      id: targetId,
      text: later,
      why,
      how,
    });
    if (mode === "orphan") {
      let refused = false;
      try {
        await r.client.call("memory.resolve", { proposalId, accept: true }, { signal });
      } catch (error) {
        requireThat(
          error instanceof RpcError && error.message === "memory_conflict",
          "sort_orphan_wrong_error",
        );
        refused = true;
      }
      requireThat(refused, "sort_orphan_cas_bypassed");
    } else {
      const resolved = await r.rpc("memory.resolve", { proposalId, accept: true });
      requireThat(resolved.proposal.status === "rejected", "sort_expired_accepted");
    }
    const after = (await r.rpc("memory.browse", { ...owner, state: "active" })).items.find(
      (m) => m.id === targetId,
    );
    requireThat(
      after?.text === later && after.why === why && after.how === how,
      "sort_lifecycle_later_content_overwritten",
    );
  }
}

/** Same renderer lifecycle as error/unmount, without requiring an Electron window or a 120s wait. */
export async function sortClientLifecycle(r: Runtime, signal: AbortSignal) {
  requireThat(
    Methods["memory.sortIntoPlace"].timeoutMs > 300_000 &&
      Methods["memory.cancelSortIntoPlace"].timeoutMs > 300_000,
    "sort_protocol_deadline_too_short",
  );
  for (const exit of ["error", "close"] as const) {
    const beforeRequest = r.requests.length;
    r.setScript([], [], [{ text: "", hang: true }]);
    let failReply: (error: unknown) => void = () => {};
    const failure = new Promise<never>((_, reject) => {
      failReply = reject;
    });
    let acknowledge: () => void = () => {};
    const acknowledgement = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    let drained = false;
    let cancelCalls = 0;
    const call: typeof r.client.call = (method, params, options) => {
      const request = r.client.call(method, params, options);
      if (method === "memory.sortIntoPlace" && exit === "error")
        return Promise.race([request, failure]);
      if (method === "memory.cancelSortIntoPlace") {
        cancelCalls++;
        return request.then(async (result) => {
          drained = true;
          await acknowledgement;
          return result;
        });
      }
      return request;
    };
    const run = startMemorySort({ call });
    let settled = false;
    const observed = run.result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await until(
      async () =>
        r.db
          .prepare(
            "SELECT tokens FROM memory_organizations WHERE owner_initiated=1 AND status='running'",
          )
          .get(),
      // Reservation precedes dispatch. Cancelling there can leave this hang reply for the next run.
      (row) => Number(row?.tokens) > 0 && r.requests.length > beforeRequest,
      signal,
    );
    const requestCount = r.requests.length;
    if (exit === "error") failReply(new RpcError(-32000, "background_request_timeout"));
    const closing = exit === "close" ? run.cancel() : undefined;
    await until(async () => drained, Boolean, signal);
    requireThat(!settled, "sort_client_returned_before_drain_ack");
    acknowledge();
    await closing;
    await observed;
    const last = r.db
      .prepare(
        "SELECT status,error,tokens FROM memory_organizations WHERE owner_initiated=1 ORDER BY rowid DESC LIMIT 1",
      )
      .get();
    requireThat(
      cancelCalls === 1 &&
        last?.status === "failed" &&
        last.error === "cancelled" &&
        Number(last.tokens) > 0 &&
        r.requests.length === requestCount,
      "sort_client_exit_did_not_drain",
    );
  }
}

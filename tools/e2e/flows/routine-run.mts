import assert from "node:assert/strict";
import type { Context } from "../context.mts";
import { until } from "../util.mts";

export async function run(c: Context) {
  await c.step("create-routine-and-run", async () => {
    await c.page.click("workspace.routinesShort");
    await c.page.click("routines.new");
    await c.page.fill("routines.name", "E2E routine");
    await c.page.fill("routines.bot", c.bot.id);
    await c.page.fill("routines.instructions", "Return E2E routine completed.");
    await c.page.click("routines.cron");
    await c.page.fill("routines.cron", "advanced");
    await c.page.fill("routines.preset.advanced", "*/5 * * * *");
    await c.ui.check("routines.enabled", false);
    await c.ui.click("common.save");
    const task = await until(
      "routine_created",
      async () =>
        c.db.one(
          "SELECT id,enabled FROM routines WHERE bot_id=? AND name=? AND deleted_at IS NULL LIMIT 1",
          c.bot.id,
          "E2E routine",
        ),
      Boolean,
      c.signal,
    );
    assert(task && task.enabled === 0, "routine_creation_mismatch");
    // The new-task form starts with a daily schedule; the advanced one is added next to it.
    const triggers = c.db.rows(
      "SELECT config FROM routine_triggers WHERE routine_id=? AND kind='cron' AND deleted_at IS NULL LIMIT 8",
      String(task.id),
    );
    assert(
      triggers.some((row) => JSON.parse(String(row.config)).expr === "*/5 * * * *"),
      "cron_missing",
    );
    // Saving returns to the chat; open the schedule list again. A loose match would hit the
    // Bot "E2E routine-run" in the sidebar instead of the routine.
    await c.page.click("workspace.routinesShort");
    assert(
      await c.page.eval<boolean>(
        `(() => { const b = [...document.querySelectorAll('button')].find(e => e.getClientRects().length && e.querySelector('strong')?.innerText.trim() === 'E2E routine'); if (!b) return false; b.click(); return true; })()`,
      ),
      "routine_row_missing",
    );
    await c.page.settle();
    await c.page.click("routines.runNow");
    const result = await until(
      "routine_done",
      async () =>
        c.db.one(
          "SELECT status,conversation_id FROM routine_runs WHERE routine_id=? AND reason='manual' ORDER BY created_at DESC LIMIT 1",
          String(task.id),
        ),
      (row) => !!row && !["scheduled", "running", "waiting"].includes(String(row.status)),
      c.signal,
      90000,
    );
    assert(result && result.status === "done", "routine_not_done");
    const topic = c.db.one(
      "SELECT title FROM conversations WHERE id=? LIMIT 1",
      String(result.conversation_id),
    );
    // The stored title is the task name; the 「调度任务：」 prefix is added only on display.
    assert.equal(topic?.title, "E2E routine");
    assert(
      c.db
        .rows(
          "SELECT content FROM messages WHERE conversation_id=? AND role='assistant' AND status='done' ORDER BY created_at DESC LIMIT 100",
          String(result.conversation_id),
        )
        .some((row) => String(row.content).includes("E2E routine completed")),
      "routine_result_missing",
    );
  });
}

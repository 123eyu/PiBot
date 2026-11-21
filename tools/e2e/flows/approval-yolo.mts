import assert from "node:assert/strict";
import type { Context } from "../context.mts";
import { until } from "../util.mts";

export async function run(c: Context) {
  for (const decision of ["allow", "deny"] as const)
    await c.step(`command-${decision}`, async () => {
      const receipt = await c.receipt(`Synthetic command ${decision}`);
      const card = await c.approval(decision);
      await c.done(receipt);
      const audit = c.db.rows(
        "SELECT kind,detail FROM audit_log WHERE bot_id=? AND run_id=? ORDER BY at DESC LIMIT 200",
        c.bot.id,
        receipt.runId,
      );
      assert(
        audit.some(
          (row) =>
            row.kind === "approval.resolved" &&
            JSON.parse(String(row.detail)).approvalId === card.id,
        ),
        "approval_audit_missing",
      );
      assert.equal(
        audit.some((row) => row.kind === "exec.started"),
        decision === "allow",
        "command_execution_decision_mismatch",
      );
    });
  await c.step("yolo-no-card", async () => {
    assert(c.conversationId);
    await c.page.click("yolo.menu");
    await c.page.click("yolo.menuItem", { exact: false });
    await c.page.click("yolo.confirm");
    await until(
      "yolo_enabled",
      async () =>
        c.db.one("SELECT yolo_at FROM conversations WHERE id=? LIMIT 1", c.conversationId as string)
          ?.yolo_at,
      Boolean,
      c.signal,
    );
    const receipt = await c.receipt("Synthetic YOLO command");
    await c.done(receipt);
    const audit = c.db.rows(
      "SELECT kind FROM audit_log WHERE bot_id=? AND run_id=? ORDER BY at DESC LIMIT 200",
      c.bot.id,
      receipt.runId,
    );
    assert(!audit.some((row) => row.kind === "approval.requested"), "unexpected_yolo_card");
    assert(
      audit.some((row) => row.kind === "exec.started"),
      "yolo_command_not_executed",
    );
    if (process.platform === "darwin") {
      await c.settings("settings.permissions");
      await c.page.waitFor("permissions.operations");
      assert(!(await c.page.has("permissions.yoloUnisolated")), "windows_option_on_mac");
      await c.page.key("Escape");
    }
  });
}

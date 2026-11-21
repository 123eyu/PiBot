import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { click, type } from "../browser-input.mts";
import type { Context } from "../context.mts";
import { freePort } from "../util.mts";

export async function run(c: Context) {
  let site = "",
    recordingId = "";
  await c.step("owned-teach-fixture", async () => {
    site = await c.fixture("teach", await freePort(), randomUUID());
  });
  await c.step("record-browser-actions", async () => {
    await c.page.click("workspace.profile", { exact: false });
    await c.page.click("workspace.panel.memory");
    // The entry moved into the Skills section's 「添加」 menu. Match the visible label, not an
    // aria-label: the composer's icon button is also named 「添加」.
    const addLabels = c.page.texts("skills.add");
    assert(
      await c.page.eval<boolean>(
        `(() => { const b = [...document.querySelectorAll('button')].find(e => e.getClientRects().length && ${JSON.stringify(addLabels)}.includes(e.innerText.trim())); if (!b) return false; b.click(); return true; })()`,
      ),
      "skills_add_missing",
    );
    await c.page.settle();
    await c.page.click("skills.teach");
    await c.page.waitFor("teach.startTitle");
    await c.page.fill("teach.url", site);
    await c.page.click("teach.start");
    await c.page.waitFor("teach.finish");
    const row = c.db.one(
      "SELECT id FROM recordings WHERE bot_id=? AND status='recording' ORDER BY started_at DESC LIMIT 1",
      c.bot.id,
    );
    assert(row);
    recordingId = String(row.id);
    const { cdp, page } = await c.browser(site);
    await click(cdp, page, "#first");
    await click(cdp, page, "#second");
    await type(cdp, page, "#note", "e2e-public-note");
    await type(cdp, page, "#secret", c.secrets[0] as string);
    await page.waitFor("第一步 第二步");
    await page.settle(1500);
    await c.page.click("teach.finish");
    await c.page.waitFor("teach.reviewTitle");
    const review = c.db.one("SELECT steps FROM recordings WHERE id=? LIMIT 1", recordingId);
    assert(review);
    const recording = {
      steps: JSON.parse(String(review.steps)) as {
        kind: string;
        target: string;
        value?: string;
        secret?: boolean;
      }[],
    };
    const clicks = recording.steps.filter((step) => step.kind === "click");
    assert(
      clicks.some((step) => step.target.includes("第一步")),
      "first_click_missing",
    );
    assert(
      clicks.some((step) => step.target.includes("第二步")),
      "second_click_missing",
    );
    assert.deepEqual(
      clicks
        .filter((step) => /第一步|第二步/.test(step.target))
        .map((step) => (step.target.includes("第一步") ? "first" : "second")),
      ["first", "second"],
      "button_click_order_mismatch",
    );
    assert(
      recording.steps.some((step) => step.kind === "type" && step.value === "e2e-public-note"),
      "public_input_missing",
    );
    assert(
      recording.steps.some(
        (step) => step.kind === "type" && step.secret && step.value === undefined,
      ),
      "password_redaction_missing",
    );
    assert(!JSON.stringify(recording).includes(c.secrets[0] as string), "recording_password_leak");
    await page.shot("teach-browser");
  });
  await c.step("draft-and-save-skill", async () => {
    await c.page.click("teach.draftIt");
    await c.page.waitFor("teach.skillName", 30000);
    assert(
      await c.page.eval<boolean>(
        `[...document.querySelectorAll("input")].some(e=>e.value==="E2E taught skill")`,
      ),
      "draft_name_missing",
    );
    await c.page.click("teach.trial");
    await c.page.waitFor("teach.trialDone", 90000);
    await c.page.click("teach.save");
    await c.page.waitFor("teach.again");
    const skill = c.db.one(
      "SELECT id FROM skills WHERE bot_id=? AND name=? LIMIT 1",
      c.bot.id,
      "E2E taught skill",
    );
    assert(skill, "saved_skill_missing");
    // The done screen links to the saved skill itself (「去看这个技能」).
    await c.page.click("teach.openSkill");
    await c.page.waitFor("E2E taught skill");
    const root = join(c.data, "bots", c.bot.id, "skills");
    let found = 0;
    for (const entry of await readdir(root, { withFileTypes: true }))
      if (entry.isDirectory()) {
        const content = await readFile(join(root, entry.name, "SKILL.md"), "utf8");
        assert(!content.includes(c.secrets[0] as string), "skill_password_leak");
        found++;
      }
    assert(found > 0);
  });
}

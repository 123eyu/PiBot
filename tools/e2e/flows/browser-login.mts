import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { click } from "../browser-input.mts";
import type { Context } from "../context.mts";
import { freePort, until } from "../util.mts";

export async function run(c: Context) {
  const port = await freePort(),
    token = randomUUID();
  let site = "";
  await c.step("owned-login-fixture", async () => {
    site = await c.fixture("login", port, token);
  });
  await c.step("save-account-and-grant", async () => {
    await c.settings("settings.permissions");
    await c.page.waitFor("credentials.add");
    await c.page.click("credentials.add");
    await c.page.fill("credentials.site", site);
    await c.page.fill("credentials.username", "e2e-user");
    await c.page.fill("credentials.password", c.secrets[0]);
    await c.page.fill("credentials.label", "E2E account");
    await c.ui.check(c.bot.name, true);
    const others = c.db.rows(
      "SELECT name FROM bots WHERE id<>? AND archived_at IS NULL LIMIT 100",
      c.bot.id,
    );
    for (const bot of others) await c.ui.check(String(bot.name), false);
    await c.page.click("credentials.save");
    await c.page.waitFor("credentials.saved");
    assert(
      c.db.one(
        "SELECT c.id FROM site_credentials c JOIN site_credential_bots b ON b.credential_id=c.id WHERE c.label=? AND b.bot_id=? LIMIT 1",
        "E2E account",
        c.bot.id,
      ),
      "credential_grant_missing",
    );
    await c.page.key("Escape");
  });
  await c.step("bot-browser-login", async () => {
    const receipt = await c.receipt("Open the fixture and fill its saved account.");
    await c.page.waitFor("E2E account");
    await c.page.waitFor("approval.allowOnce");
    await c.page.shot("login-approval");
    await c.page.click("approval.allowOnce");
    await c.done(receipt);
    const { cdp, page } = await c.browser(site);
    // Login fill intentionally does not submit. Forms in the Bot browser stay locked unless a Bot
    // action arms them or the user takes over, so submit the way a user can: take over
    // from the chat's browser panel, then click.
    await c.page.click("botBrowser.pill", { exact: false });
    await c.page.click("botBrowser.takeover");
    await c.page.shot("takeover");
    await click(cdp, page, "button");
    await page.waitFor("已登录：e2e-user");
    const receipts = await until(
      "submitted_credentials",
      async () =>
        fetch(`${site}/__receipt`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(2000),
        }).then((r) => r.json()),
      (rows) => Array.isArray(rows) && rows.length === 1,
      c.signal,
    );
    assert.deepEqual(receipts, [{ username: "e2e-user", password: c.secrets[0] }]);
    await page.shot("browser-login-result");
  });
}

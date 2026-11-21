import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "../context.mts";

export async function run(c: Context) {
  await c.step("long-conversation", async () => {
    await c.send("Synthetic retained evidence. ".repeat(1400));
    assert(c.conversationId);
  });
  await c.step("click-manual-compaction", async () => {
    // A healthy topic shows the row only after 「整理上下文」 in the composer's + menu.
    await c.page.click("attachments.menu");
    await c.page.click("chat.compactMenu");
    await c.page.waitFor("chat.compactNow");
    await c.page.click("chat.compactNow");
    await c.page.waitFor("chat.compactDone", 45000);
    const dir = join(c.data, "bots", c.bot.id, "sessions");
    const files = (await readdir(dir)).filter((file) => file.endsWith(".jsonl"));
    const entries = (
      await Promise.all(files.map((file) => readFile(join(dir, file), "utf8")))
    ).flatMap((text) =>
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    );
    assert(
      entries.some((entry) => entry.type === "compaction"),
      "compaction_entry_missing",
    );
    // A long topic is summarized in chunks; how many depends on the model window. Queue the
    // continuation at the next request instead of guessing the chunk count in the scenario.
    c.scenario.replies.splice(c.modelRequests, Infinity, { text: "E2E continuation completed" });
    assert.equal(
      (await c.send("Continue after manual compaction."))?.content,
      "E2E continuation completed",
    );
  });
}
